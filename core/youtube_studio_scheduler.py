"""Orchestrates the studio-first YouTube scheduling workflow.

Default YouTube Data API v3 quota: 10,000 units/day.
Studio-first cost per scheduled video:
  channels.list          1   (one-shot, lazy on first list)
  playlistItems.list    ~1
  videos.list           ~1   (amortized across pages of 50)
  videos.update          50
  --------------------------
  Per-video total       ~53 (first video in run pays the +1 channels cost)

At the 10-per-run cap, a daily run uses ~510 units max — ~5% of quota.
Leaves plenty of headroom for manual reruns or dry-run previews.

For comparison: the old videos.insert path cost 1,600 units/upload and
capped us at 6 videos/day. Studio-first is ~31x cheaper per video.

This module composes primitives from `platforms.youtube.YouTube` with the
pure helpers in `core.youtube_slots` and `core.youtube_title_cleaner`. The
cron is a thin shell around `schedule_studio_drafts()`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from core.database import insert_post
from core.exceptions import PlatformAPIError
from core.models import Post
from core.youtube_slots import (
    MIN_LEAD_MINUTES,
    AssignedSlot,
    SlotExhaustedError,
    assign_next_slot,
)
from core.youtube_title_cleaner import clean_title
from platforms.youtube import PrivateVideo, YouTube

logger = logging.getLogger(__name__)

_PT = ZoneInfo("America/Los_Angeles")
# Quota unit costs — mirrored from YouTube's documented costs.
_COST_LIST_VIDEOS = 3  # channels (lazy) + playlistItems + videos
_COST_UPDATE = 50


@dataclass
class ScheduledOutcome:
    video_id: str
    original_title: str
    cleaned_title: str
    sonnet_applied: bool
    publish_at_iso: str


@dataclass
class SkippedOutcome:
    video_id: str
    reason: str


@dataclass
class QuotaTracker:
    used: int = 0

    def charge(self, cost: int, *, reason: str) -> None:
        self.used += cost
        logger.debug("Quota +%d (%s) — running total %d", cost, reason, self.used)


@dataclass
class Summary:
    scheduled: list[ScheduledOutcome] = field(default_factory=list)
    skipped: list[SkippedOutcome] = field(default_factory=list)
    quota_used: int = 0
    dry_run: bool = False
    drafts_discovered: int = 0
    backlog: int = 0  # drafts beyond max_per_run left for future runs


def _fmt_publish(iso: str) -> str:
    """Render an ISO "...Z" timestamp as "UTC (PT)" for logs."""
    dt = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    pt = dt.astimezone(_PT)
    return f"{iso} ({pt.strftime('%Y-%m-%d %H:%M %Z')})"


def _is_quota_exceeded(exc: PlatformAPIError) -> bool:
    return exc.status_code == 403 and "quota" in str(exc).lower()


def _min_lead_minutes_from_env() -> int:
    raw = os.environ.get("YOUTUBE_STUDIO_MIN_LEAD_MINUTES")
    if not raw:
        return MIN_LEAD_MINUTES
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "YOUTUBE_STUDIO_MIN_LEAD_MINUTES=%r is not an integer; using default %d",
            raw,
            MIN_LEAD_MINUTES,
        )
        return MIN_LEAD_MINUTES


def schedule_studio_drafts(
    client: YouTube,
    *,
    dry_run: bool = False,
    max_per_run: int = 10,
    now: datetime | None = None,
) -> Summary:
    """Discover Private drafts in Studio, clean titles, and apply schedules.

    Args:
      client: an authenticated YouTube adapter (refresh_credentials already called).
      dry_run: if True, log the exact videos.update payload we would send
        but skip the write. Title cleanup still runs (cheap, and it's the
        most valuable thing to eyeball in a dry-run log).
      max_per_run: cap on schedule writes per run.
      now: override current time (tests). Defaults to datetime.now(UTC).

    Returns a Summary. The function never raises on per-video errors —
    those are appended to `summary.skipped`. It only raises on unexpected
    programmer errors (e.g. a malformed PrivateVideo object).
    """
    now = now or datetime.now(timezone.utc)
    min_lead_minutes = _min_lead_minutes_from_env()
    quota = QuotaTracker()
    summary = Summary(dry_run=dry_run)

    # ── Phase 1: discover ──────────────────────────────────────────
    try:
        videos = client.list_my_private_videos()
        quota.charge(_COST_LIST_VIDEOS, reason="list_my_private_videos")
    except PlatformAPIError as exc:
        if _is_quota_exceeded(exc):
            logger.warning("Quota already exhausted before discovery: %s", exc)
            summary.quota_used = quota.used
            return summary
        raise

    drafts = [v for v in videos if v.publish_at is None]
    already_scheduled = [v for v in videos if v.publish_at is not None]
    summary.drafts_discovered = len(drafts)
    logger.info(
        "Discovered %d Private videos: %d drafts, %d already scheduled",
        len(videos),
        len(drafts),
        len(already_scheduled),
    )

    # Build the "taken" set from manually-scheduled videos so assign_next_slot
    # skips any canonical slot within ±10 min. Entries come in as "...Z".
    taken: set[datetime] = set()
    for v in already_scheduled:
        try:
            taken.add(
                datetime.strptime(v.publish_at, "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc
                )
            )
        except ValueError:
            logger.warning(
                "Unparseable publish_at %r on video %s — ignoring", v.publish_at, v.video_id
            )

    if len(drafts) > max_per_run:
        summary.backlog = len(drafts) - max_per_run
        logger.warning(
            "%d drafts in queue, scheduling %d, %d remain for subsequent runs",
            len(drafts),
            max_per_run,
            summary.backlog,
        )

    # ── Phase 2: schedule ──────────────────────────────────────────
    for draft in drafts[:max_per_run]:
        try:
            _schedule_one(
                draft=draft,
                client=client,
                now=now,
                taken=taken,
                min_lead_minutes=min_lead_minutes,
                dry_run=dry_run,
                quota=quota,
                summary=summary,
            )
        except SlotExhaustedError as exc:
            logger.warning("Slot exhausted — stopping run: %s", exc)
            break
        except PlatformAPIError as exc:
            if _is_quota_exceeded(exc):
                logger.warning("Hit quotaExceeded mid-run — stopping with partial summary")
                summary.skipped.append(
                    SkippedOutcome(video_id=draft.video_id, reason=str(exc))
                )
                break
            safe = client.sanitize_error(exc)
            logger.error("Failed to schedule %s: %s", draft.video_id, safe)
            summary.skipped.append(SkippedOutcome(video_id=draft.video_id, reason=safe))
        except Exception as exc:  # never block the whole run on one bad draft
            safe = client.sanitize_error(exc)
            logger.exception("Unexpected error on %s: %s", draft.video_id, safe)
            summary.skipped.append(SkippedOutcome(video_id=draft.video_id, reason=safe))

    summary.quota_used = quota.used
    logger.info(
        "Run complete: scheduled=%d skipped=%d quota_used=%d dry_run=%s",
        len(summary.scheduled),
        len(summary.skipped),
        summary.quota_used,
        summary.dry_run,
    )
    return summary


def _schedule_one(
    *,
    draft: PrivateVideo,
    client: YouTube,
    now: datetime,
    taken: set[datetime],
    min_lead_minutes: int,
    dry_run: bool,
    quota: QuotaTracker,
    summary: Summary,
) -> None:
    cleaned = clean_title(draft.title)
    slot: AssignedSlot = assign_next_slot(
        now, taken=taken, min_lead_minutes=min_lead_minutes
    )
    # Reserve the slot so the next draft in this run can't pick it.
    taken.add(slot.publish_at)

    final_title = cleaned.final or draft.title  # belt-and-braces if cleaner was a no-op
    payload_preview = {
        "id": draft.video_id,
        "snippet": {"title": final_title, "categoryId": draft.category_id},
        "status": {"privacyStatus": "private", "publishAt": slot.iso},
    }

    logger.info(
        "%s: %r → %r @ %s (sonnet=%s)",
        draft.video_id,
        draft.title,
        final_title,
        _fmt_publish(slot.iso),
        cleaned.sonnet_applied,
    )
    if dry_run:
        logger.info("DRY-RUN videos.update payload: %s", payload_preview)
        summary.scheduled.append(
            ScheduledOutcome(
                video_id=draft.video_id,
                original_title=draft.title,
                cleaned_title=final_title,
                sonnet_applied=cleaned.sonnet_applied,
                publish_at_iso=slot.iso,
            )
        )
        return

    client.update_video_schedule(
        draft.video_id,
        title=final_title,
        category_id=draft.category_id,
        publish_at_iso=slot.iso,
    )
    quota.charge(_COST_UPDATE, reason=f"update {draft.video_id}")

    # Mirror the schedule into the posts table so the dashboard can render it.
    post = Post(
        platform="youtube",
        platform_post_id=draft.video_id,
        status="scheduled",
        title=final_title,
        metadata={
            "source": "studio",
            "publish_at": slot.iso,
            "original_title": draft.title,
            "cleaned_title": final_title,
            "sonnet_applied": cleaned.sonnet_applied,
        },
    )
    try:
        insert_post(post)
    except Exception as exc:
        # DB failure should not roll back the YouTube write — the video is
        # scheduled regardless. Log loudly so the operator can reconcile.
        logger.error(
            "YouTube schedule succeeded but posts insert failed for %s: %s",
            draft.video_id,
            exc,
        )
    summary.scheduled.append(
        ScheduledOutcome(
            video_id=draft.video_id,
            original_title=draft.title,
            cleaned_title=final_title,
            sonnet_applied=cleaned.sonnet_applied,
            publish_at_iso=slot.iso,
        )
    )
