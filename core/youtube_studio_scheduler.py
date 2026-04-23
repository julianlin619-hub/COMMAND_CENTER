"""Orchestrates the studio-first YouTube scheduling workflow.

Default YouTube Data API v3 quota: 10,000 units/day.
Studio-first cost per scheduled video:
  channels.list           1   (one-shot, lazy on first list)
  playlistItems.list     ~1
  videos.list            ~1   (amortized across pages of 50)
  captions.list          50
  captions.download     200   (only on success)
  videos.update          50
  ---------------------------
  Per-video total       ~303 (first video in run pays the +1 channels cost)

At the 10-per-run cap, a daily run uses ~3,030 units max — ~30% of quota.
That leaves room for manual reruns or dry-run previews but no longer has
the huge headroom the old cleaner-based flow had.

For comparison: the old videos.insert path cost 1,600 units/upload and
capped us at 6 videos/day. Studio-first is still ~5x cheaper per video,
and the title quality is dramatically better now that we generate from the
actual transcript instead of cleaning up placeholder filenames.

This module composes primitives from `platforms.youtube.YouTube` with the
pure helpers in `core.youtube_slots`, `core.youtube_transcript`, and
`core.youtube_title_generator`. The cron is a thin shell around
`schedule_studio_drafts()`.

Fallback path
-------------
If a draft has no caption transcript (ASR not ready, captions disabled),
the scheduler skips it and records a strike in the
`youtube_title_fallback_tracker` Supabase table. After
`YOUTUBE_TITLE_FALLBACK_AFTER` consecutive skips (default 3), the
scheduler falls back to a cleaned version of the original Studio title
instead of skipping yet again — this prevents zombie drafts that loop
forever without caption tracks. Fallback rows carry
`metadata.title_source="fallback"` so the dashboard can flag them for
operator review. The tracker row is deleted once a draft is scheduled
(either with a generated or a fallback title).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from core.database import (
    bump_title_fallback_tracker,
    clear_title_fallback_tracker,
    get_scheduled_youtube_publish_times,
    get_title_fallback_skip_count,
    insert_post,
)
from core.exceptions import PlatformAPIError
from core.models import Post
from core.youtube_slots import (
    MAX_LOOKAHEAD_DAYS,
    MIN_LEAD_MINUTES,
    AssignedSlot,
    SlotExhaustedError,
    assign_next_slot,
)
from core.youtube_title_generator import generate_title
from core.youtube_transcript import fetch_transcript
from platforms.youtube import PrivateVideo, YouTube

logger = logging.getLogger(__name__)

_PT = ZoneInfo("America/Los_Angeles")
# Quota unit costs — mirrored from YouTube's documented costs.
_COST_LIST_VIDEOS = 3  # channels (lazy) + playlistItems + videos
_COST_LIST_CAPTIONS = 50
_COST_DOWNLOAD_CAPTION = 200
_COST_UPDATE = 50

# After this many consecutive "transcript unavailable" skips, fall back to
# a cleaned version of the original Studio title instead of skipping again.
# Overridable via `YOUTUBE_TITLE_FALLBACK_AFTER` for tests / tuning.
_FALLBACK_AFTER_DEFAULT = 3

# Regex fragments for `_clean_raw_title`. Kept module-level so the
# interpreter compiles them once per process.
_FILE_EXT_RE = re.compile(
    r"\.(mp4|mov|avi|wmv|flv|webm|mkv|m4v)$", flags=re.IGNORECASE
)
_VERSION_MARKER_RE = re.compile(
    r"\b(v\d+|final\d*|draft\d*|wip|edit\d*|cut\d*|rev\d*|rough\d*)\b",
    flags=re.IGNORECASE,
)
_SEPARATOR_RE = re.compile(r"[_\-]+")
_WS_RUN = re.compile(r"\s+")


@dataclass
class ScheduledOutcome:
    video_id: str
    original_title: str
    generated_title: str
    transcript_chars: int
    caption_track_kind: str
    publish_at_iso: str
    title_source: Literal["generated", "fallback"]


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


def _fallback_after_from_env() -> int:
    raw = os.environ.get("YOUTUBE_TITLE_FALLBACK_AFTER")
    if not raw:
        return _FALLBACK_AFTER_DEFAULT
    try:
        parsed = int(raw)
        if parsed < 1:
            raise ValueError("must be >= 1")
        return parsed
    except ValueError:
        logger.warning(
            "YOUTUBE_TITLE_FALLBACK_AFTER=%r is not a positive integer; using default %d",
            raw,
            _FALLBACK_AFTER_DEFAULT,
        )
        return _FALLBACK_AFTER_DEFAULT


def _clean_raw_title(raw: str, *, max_len: int = 100) -> str:
    """Minimal cleanup of a raw Studio title for the fallback path.

    Strips: file extensions, common version markers (v2, v4, final, draft,
    wip, edit2, cut3, rev, rough1, etc.), and replaces underscores/hyphens
    with spaces. Preserves case, apostrophes, and punctuation.

    Returns an empty string if the input is entirely version-marker + junk
    (e.g. `"v2.mp4"`). The caller is expected to substitute a deterministic
    placeholder in that case so we never send an empty title to YouTube.
    """
    cleaned = _FILE_EXT_RE.sub("", raw)
    cleaned = _SEPARATOR_RE.sub(" ", cleaned)
    cleaned = _VERSION_MARKER_RE.sub("", cleaned)
    cleaned = _WS_RUN.sub(" ", cleaned).strip()
    if len(cleaned) > max_len:
        # Truncate at the last space boundary under max_len. Hard-cut if no
        # space exists (single long word).
        head = cleaned[:max_len]
        last_space = head.rfind(" ")
        cleaned = head[:last_space].rstrip() if last_space != -1 else head.rstrip()
    return cleaned


def schedule_studio_drafts(
    client: YouTube,
    *,
    dry_run: bool = False,
    max_per_run: int = 10,
    now_utc: datetime | None = None,
) -> Summary:
    """Discover Private drafts in Studio, title them from transcript, schedule.

    Args:
      client: an authenticated YouTube adapter (refresh_credentials already called).
      dry_run: if True, log the exact videos.update payload we would send
        but skip the write. Transcript fetch and title generation still run
        so the dry-run log is the most useful way to eyeball title quality.
        The fallback tracker is READ in dry-run so the skip/fallback
        decision stays realistic, but never mutated.
      max_per_run: cap on schedule writes per run.
      now_utc: override current time (tests). Defaults to datetime.now(UTC).

    Returns a Summary. The function never raises on per-video errors —
    those are appended to `summary.skipped`. Drafts with no caption track
    are skipped with `reason="transcript unavailable (N/M)"` up to
    `YOUTUBE_TITLE_FALLBACK_AFTER` skips, at which point they're scheduled
    with a cleaned-up raw title and `title_source="fallback"`.
    """
    now_utc = now_utc or datetime.now(timezone.utc)
    fallback_after = _fallback_after_from_env()
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

    # `list_my_private_videos` calls `validate_credentials` lazily, so the
    # channel_id is guaranteed to be populated by now.
    channel_id = client.channel_id

    drafts = [v for v in videos if v.publish_at is None]
    already_scheduled = [v for v in videos if v.publish_at is not None]
    summary.drafts_discovered = len(drafts)
    logger.info(
        "Discovered %d Private videos: %d drafts, %d already scheduled",
        len(videos),
        len(drafts),
        len(already_scheduled),
    )

    # Build the "taken" set from two sources:
    #   (a) YouTube's already-scheduled Private videos — catches schedules
    #       made manually in Studio that never wrote a `posts` row.
    #   (b) Our own prior cron writes via the `posts` table — catches this
    #       channel's scheduled rows even if the YouTube list paginates
    #       past them.
    # The scheduler then adds slots it picks during this run to the same
    # set (in-memory) so two drafts in one run can't collide.
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
    try:
        taken |= get_scheduled_youtube_publish_times()
    except Exception as exc:
        # Swallow — an occupancy read that fails should not abort the run.
        # Worst case: we double-book a slot YouTube will enforce uniqueness
        # on via the update call anyway.
        logger.warning("Posts-table occupancy read failed: %s", exc)
    logger.info("Occupancy set has %d taken slot(s) before scheduling", len(taken))

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
                channel_id=channel_id,
                now_utc=now_utc,
                taken=taken,
                fallback_after=fallback_after,
                dry_run=dry_run,
                quota=quota,
                summary=summary,
            )
        except SlotExhaustedError:
            logger.warning(
                "%s: slot exhausted within %d-day lookahead — skipping draft",
                draft.video_id, MAX_LOOKAHEAD_DAYS,
            )
            summary.skipped.append(
                SkippedOutcome(
                    video_id=draft.video_id,
                    reason=f"slot exhausted ({MAX_LOOKAHEAD_DAYS}d lookahead)",
                )
            )
            continue
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
    channel_id: str,
    now_utc: datetime,
    taken: set[datetime],
    fallback_after: int,
    dry_run: bool,
    quota: QuotaTracker,
    summary: Summary,
) -> None:
    # Phase 1: transcript. If the caption track is missing (common for
    # freshly uploaded drafts — ASR hasn't run yet) we normally skip the
    # draft. After `fallback_after` consecutive skips we promote this draft
    # to the fallback path: clean up its raw Studio title and schedule
    # anyway, so zombie drafts don't loop forever.
    transcript = fetch_transcript(client, draft.video_id, quota=quota)

    if transcript is None:
        # In dry-run, read the current tracker count without mutating, and
        # preview what a real bump would produce (`current + 1`). In
        # wet-run, actually bump and use the returned count.
        if dry_run:
            skip_count = get_title_fallback_skip_count(channel_id, draft.video_id) + 1
        else:
            skip_count = bump_title_fallback_tracker(
                channel_id, draft.video_id, "transcript unavailable"
            )

        if skip_count < fallback_after:
            logger.info(
                "%s: transcript unavailable (%d/%d) — skipping (will retry next run)",
                draft.video_id, skip_count, fallback_after,
            )
            summary.skipped.append(
                SkippedOutcome(
                    video_id=draft.video_id,
                    reason=f"transcript unavailable ({skip_count}/{fallback_after})",
                )
            )
            return

        # Fallback path — take over with the cleaned Studio title.
        cleaned = _clean_raw_title(draft.title)
        if not cleaned:
            # Raw title was all junk (e.g. "v2.mp4" → "" after cleanup).
            # Substitute a deterministic placeholder so the YouTube update
            # call never sends an empty title.
            cleaned = f"Untitled video {draft.video_id[:8]}"
        logger.warning(
            "%s: fallback after %d skips — using cleaned title %r",
            draft.video_id, skip_count, cleaned,
        )
        _finalize_schedule(
            draft=draft,
            client=client,
            channel_id=channel_id,
            now_utc=now_utc,
            taken=taken,
            dry_run=dry_run,
            quota=quota,
            summary=summary,
            final_title=cleaned,
            transcript_chars=0,
            caption_track_kind="",
            title_source="fallback",
            fallback_skip_count=skip_count,
        )
        return

    # Phase 2: title generation. Any failure here (API error, empty JSON,
    # malformed response) is a skip, not a fall-back — a bad title is
    # worse than no publish. The tracker is NOT bumped on title-gen
    # failure: Claude/API outages are transient, and bumping here would
    # mass-fallback drafts during a short incident.
    try:
        final_title = generate_title(transcript.text)
    except Exception as exc:
        logger.warning(
            "%s: title generation failed — skipping: %s", draft.video_id, exc
        )
        summary.skipped.append(
            SkippedOutcome(video_id=draft.video_id, reason="title generation failed")
        )
        return

    _finalize_schedule(
        draft=draft,
        client=client,
        channel_id=channel_id,
        now_utc=now_utc,
        taken=taken,
        dry_run=dry_run,
        quota=quota,
        summary=summary,
        final_title=final_title,
        transcript_chars=len(transcript.text),
        caption_track_kind=transcript.track_kind,
        title_source="generated",
        fallback_skip_count=None,
    )


def _finalize_schedule(
    *,
    draft: PrivateVideo,
    client: YouTube,
    channel_id: str,
    now_utc: datetime,
    taken: set[datetime],
    dry_run: bool,
    quota: QuotaTracker,
    summary: Summary,
    final_title: str,
    transcript_chars: int,
    caption_track_kind: str,
    title_source: Literal["generated", "fallback"],
    fallback_skip_count: int | None,
) -> None:
    """Assign a slot and (optionally) write the YouTube update + posts row.

    Split out of `_schedule_one` so both the transcript-generated path and
    the fallback path share one body — the only differences between them
    are the title, transcript metadata, and `title_source`.
    """
    slot: AssignedSlot = assign_next_slot(
        now_utc, taken=taken, min_lead_minutes=MIN_LEAD_MINUTES
    )
    # Reserve the slot so the next draft in this run can't pick it.
    taken.add(slot.publish_at)

    payload_preview = {
        "id": draft.video_id,
        "snippet": {"title": final_title, "categoryId": draft.category_id},
        "status": {"privacyStatus": "private", "publishAt": slot.iso},
    }

    logger.info(
        "%s: %r → %r @ %s (track=%s, %d chars, source=%s)",
        draft.video_id,
        draft.title,
        final_title,
        _fmt_publish(slot.iso),
        caption_track_kind or "-",
        transcript_chars,
        title_source,
    )
    if dry_run:
        logger.info("DRY-RUN videos.update payload: %s", payload_preview)
        summary.scheduled.append(
            ScheduledOutcome(
                video_id=draft.video_id,
                original_title=draft.title,
                generated_title=final_title,
                transcript_chars=transcript_chars,
                caption_track_kind=caption_track_kind,
                publish_at_iso=slot.iso,
                title_source=title_source,
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

    # Successful schedule clears the tracker so a future caption-loss on
    # the same video starts the counter from zero.
    try:
        clear_title_fallback_tracker(channel_id, draft.video_id)
    except Exception as exc:
        logger.warning(
            "Tracker clear failed for %s — row will age out on next fallback: %s",
            draft.video_id, exc,
        )

    # Mirror the schedule into the posts table so the dashboard can render it.
    metadata: dict = {
        "source": "studio",
        "publish_at": slot.iso,
        "original_title": draft.title,
        "generated_title": final_title,
        "transcript_chars": transcript_chars,
        "caption_track_kind": caption_track_kind,
        "title_source": title_source,
    }
    if fallback_skip_count is not None:
        metadata["fallback_skip_count"] = fallback_skip_count
    post = Post(
        platform="youtube",
        platform_post_id=draft.video_id,
        status="scheduled",
        title=final_title,
        metadata=metadata,
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
            generated_title=final_title,
            transcript_chars=transcript_chars,
            caption_track_kind=caption_track_kind,
            publish_at_iso=slot.iso,
            title_source=title_source,
        )
    )
