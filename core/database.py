"""Supabase client and all database operations.

This module is the only place that talks to Supabase. Every other module
(scheduler, cron jobs, platform adapters) calls functions here instead of
importing the Supabase client directly. That keeps DB logic in one place
and makes it easy to swap the database layer if needed.

We use the Supabase *service key* (not the anon key) because cron jobs
run server-side with no user session. The service key bypasses Row Level
Security, so access control is handled at the application layer.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta, timezone

from supabase import Client, create_client

from core.models import CronRun, Post

logger = logging.getLogger(__name__)

# ── Singleton Client ────────────────────────────────────────────────────
# We keep a single Supabase client for the lifetime of the process.
# This avoids creating a new HTTP connection on every DB call, which
# would be slow and wasteful. The module-level _client variable acts
# as a cache: None means "not yet created."

_client: Client | None = None


def get_client() -> Client:
    """Get or create the Supabase client singleton."""
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        _client = create_client(url, key)
    return _client


# ── Posts ────────────────────────────────────────────────────────────────
# CRUD operations for the `posts` table. Posts are created by the dashboard
# and updated by cron jobs as they move through the publishing lifecycle.


def insert_post(post: Post) -> str:
    """Insert a post record. Returns the post ID."""
    client = get_client()
    # exclude_none=True: don't send null fields — let Supabase use its defaults.
    # exclude={"id"}: the DB auto-generates the UUID; we never set it ourselves.
    data = post.model_dump(exclude_none=True, exclude={"id"})
    result = client.table("posts").insert(data).execute()
    # Guard against empty result.data — happens when RLS rejects the insert
    # or a unique constraint (e.g. dedup index from migration 004) fires.
    # Without this guard, callers would see a bare IndexError with no context.
    if not result.data:
        raise RuntimeError(
            "insert_post returned no rows — check RLS policies and dedup constraint"
        )
    return result.data[0]["id"]


def update_post(post_id: str, **fields) -> None:
    """Update specific fields on a post.

    Raises RuntimeError if the update touches zero rows — the row is missing,
    was deleted, or RLS blocked the write. Silently no-oping here would leave
    posts stuck in transitional states (e.g. "publishing" forever when the
    scheduler can't flip them to "published"/"failed") and hide real DB/RLS
    misconfiguration behind a healthy-looking cron run.
    """
    client = get_client()
    # Always stamp updated_at so the dashboard can sort by "last modified"
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    # Sanitize error messages before storing — exception text from HTTP
    # libraries can contain tokens, API keys, or auth headers.
    if fields.get("error_message"):
        fields["error_message"] = sanitize_error_message(fields["error_message"])
    result = client.table("posts").update(fields).eq("id", post_id).execute()
    # Empty data means the UPDATE matched no row. Callers inside `except`
    # blocks that use update_post to stamp a failure state should wrap this
    # call in their own try/except so a DB outage there doesn't shadow the
    # original platform error — see scheduler.process_due_posts and the
    # Buffer-send pipelines for the pattern.
    if not result.data:
        raise RuntimeError(
            f"update_post({post_id}) returned no rows — row missing or RLS blocked"
        )


def get_posts(
    platform: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Fetch posts with optional filters."""
    client = get_client()
    query = client.table("posts").select("*").order("created_at", desc=True)
    if platform:
        query = query.eq("platform", platform)
    if status:
        query = query.eq("status", status)
    # range() implements pagination: range(0, 49) returns the first 50 rows.
    # Supabase range is inclusive on both ends, so we subtract 1 from the limit.
    query = query.range(offset, offset + limit - 1)
    return query.execute().data


# ── Schedules ────────────────────────────────────────────────────────────
# The `schedules` table links a post to a future publish time. The cron job
# queries for "due" schedules — ones where the time has passed but no cron
# has claimed them yet.


# If a schedule has been "picked up" for longer than this without completing,
# it's probably stuck (the cron worker crashed after claiming it). Reset it
# so the next cron run can retry. 30 minutes is generous — even a slow video
# upload should finish well within that.
STALE_PICKUP_MINUTES = 30


def _reset_stale_pickups(platform: str) -> int:
    """Reset schedules that were picked up but never completed.

    When a cron worker crashes after claiming a schedule (setting picked_up_at)
    but before updating the post status to published/failed, the schedule gets
    stuck — no other cron run will pick it up because picked_up_at is set.

    This function finds schedules that have been in "picked up" state for too
    long and resets them by clearing picked_up_at. The associated post is also
    reset from "publishing" back to "scheduled" so it re-enters the queue.

    Returns the number of schedules reset.
    """
    client = get_client()
    cutoff = (
        datetime.now(timezone.utc) - timedelta(minutes=STALE_PICKUP_MINUTES)
    ).isoformat()

    # Find schedules that were picked up before the cutoff and whose
    # associated post is still in "publishing" state (never completed)
    stale = (
        client.table("schedules")
        .select("id, post_id, posts!inner(status)")
        .not_.is_("picked_up_at", "null")
        .lte("picked_up_at", cutoff)
        .eq("posts.platform", platform)
        .eq("posts.status", "publishing")
        .execute()
        .data
    )

    for schedule in stale:
        client.table("schedules").update(
            {"picked_up_at": None}
        ).eq("id", schedule["id"]).execute()
        client.table("posts").update(
            {"status": "scheduled", "updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", schedule["post_id"]).execute()
        logger.warning(
            "Reset stale schedule %s (post %s) — picked up >%d min ago without completing",
            schedule["id"], schedule["post_id"], STALE_PICKUP_MINUTES,
        )

    return len(stale)


def get_due_schedules(platform: str) -> list[dict]:
    """Get schedules that are due and haven't been picked up yet.

    Also resets any schedules that have been stuck in "picked up" state
    for more than STALE_PICKUP_MINUTES, so they can be retried.
    """
    client = get_client()

    # First, unstick any schedules that a crashed worker left behind
    reset_count = _reset_stale_pickups(platform)
    if reset_count:
        logger.info("Reset %d stale %s schedule(s)", reset_count, platform)

    now = datetime.now(timezone.utc).isoformat()
    return (
        client.table("schedules")
        .select("*, posts!inner(*)")
        .is_("picked_up_at", "null")
        .lte("scheduled_for", now)
        .eq("posts.platform", platform)
        .execute()
        .data
    )


def insert_schedule(post_id: str, scheduled_for: datetime) -> str:
    """Create a schedule linking a post to a publish time. Returns the schedule ID.

    Used by content sourcing (cron Phase 0) to schedule auto-generated posts
    for immediate or future publishing. The normal flow is:
      1. insert_post() creates the post record
      2. insert_schedule() links it to a publish time
      3. get_due_schedules() finds it when the time arrives
    """
    client = get_client()
    result = (
        client.table("schedules")
        .insert({"post_id": post_id, "scheduled_for": scheduled_for.isoformat()})
        .execute()
    )
    if not result.data:
        raise RuntimeError(
            f"insert_schedule for post {post_id} returned no rows — check RLS / FK constraint"
        )
    return result.data[0]["id"]


def mark_schedule_picked_up(schedule_id: str) -> bool:
    """Atomically claim a schedule. Returns True if this call won the claim.

    Only updates if picked_up_at is still null — this means two concurrent
    cron runs calling this on the same schedule will have exactly one winner.
    The loser gets an empty result and should skip the schedule.
    """
    client = get_client()
    result = (
        client.table("schedules")
        .update({"picked_up_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", schedule_id)
        .is_("picked_up_at", "null")
        .execute()
    )
    return len(result.data) > 0


def post_caption_exists(platform: str, caption: str) -> bool:
    """Check if a post with this exact caption already exists for a platform.

    Used by content sourcing to avoid creating duplicate posts. For example,
    if an Apify tweet was already sourced in a previous cron run, we skip it.

    Mirrors the partial unique index from migration 004: rows with status
    'failed' or 'buffer_error' don't count as existing, so the next cron run
    can retry a caption whose previous send failed.
    """
    client = get_client()
    result = (
        client.table("posts")
        .select("id")
        .eq("platform", platform)
        .eq("caption", caption)
        .not_.in_("status", ["failed", "buffer_error"])
        .limit(1)
        .execute()
    )
    return len(result.data) > 0


# ── YouTube studio-first scheduler helpers ──────────────────────────────
# Used by core.youtube_studio_scheduler to (a) read occupied publish slots
# from prior cron runs so two runs never double-book the same slot, and
# (b) count per-draft skip occurrences so we can fall back to a cleaned
# raw title after N consecutive "transcript unavailable" skips. See the
# fallback tracker migration for the table definition.


def get_scheduled_youtube_publish_times(horizon_days: int = 14) -> set[datetime]:
    """Return tz-aware UTC datetimes of studio-scheduled YouTube publishes.

    Pulls `status='scheduled'`, `platform='youtube'`, `metadata.source='studio'`
    rows whose `metadata.publish_at` falls in the window [now, now+horizon_days].
    Past publish_ats are excluded — they've already fired on YouTube and
    aren't useful for slot-conflict avoidance.

    Used as one source of the "taken slots" set the scheduler passes to
    `assign_next_slot`; the other source is YouTube's own list of already-
    scheduled Private videos (which catches manual Studio schedules that
    don't write to `posts`).
    """
    client = get_client()
    now_utc = datetime.now(timezone.utc)
    horizon_cutoff = now_utc + timedelta(days=horizon_days)

    # Supabase doesn't support strict range filters on jsonb->>'key' via the
    # SDK as cleanly as plain columns, so we filter server-side on the
    # cheap conditions and do the publish_at parse + window check in Python.
    result = (
        client.table("posts")
        .select("metadata")
        .eq("platform", "youtube")
        .eq("status", "scheduled")
        .filter("metadata->>source", "eq", "studio")
        .execute()
    )

    taken: set[datetime] = set()
    for row in result.data:
        raw = (row.get("metadata") or {}).get("publish_at")
        if not raw:
            continue
        try:
            # Posts are written with "...Z" suffix (see core.youtube_slots._to_iso_z).
            dt = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            logger.warning("Unparseable publish_at in posts.metadata: %r", raw)
            continue
        # Only keep future publishes — past ones have already fired.
        if now_utc <= dt < horizon_cutoff:
            taken.add(dt)
    return taken


def get_title_fallback_skip_count(channel_id: str, video_id: str) -> int:
    """Return the current skip_count for (channel_id, video_id), or 0."""
    client = get_client()
    result = (
        client.table("youtube_title_fallback_tracker")
        .select("skip_count")
        .eq("channel_id", channel_id)
        .eq("video_id", video_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return 0
    return int(result.data[0]["skip_count"])


def bump_title_fallback_tracker(
    channel_id: str, video_id: str, reason: str
) -> int:
    """Upsert the tracker row, incrementing skip_count. Returns the new count.

    Not atomic against concurrent writers — but the studio scheduler
    processes drafts sequentially inside a single cron run, and tracker
    rows are keyed on a unique video_id, so two writers racing on the
    same row is not a realistic case. The read-then-upsert pattern is
    simpler than PostgREST's RPC surface and fine for our concurrency.
    """
    client = get_client()
    current = get_title_fallback_skip_count(channel_id, video_id)
    new_count = current + 1
    now_iso = datetime.now(timezone.utc).isoformat()
    row: dict = {
        "channel_id": channel_id,
        "video_id": video_id,
        "skip_count": new_count,
        "last_skipped_at": now_iso,
        "last_reason": reason,
    }
    # first_skipped_at is only set on insert (keeps a true "first seen" date).
    if current == 0:
        row["first_skipped_at"] = now_iso
    (
        client.table("youtube_title_fallback_tracker")
        .upsert(row, on_conflict="channel_id,video_id")
        .execute()
    )
    return new_count


def clear_title_fallback_tracker(channel_id: str, video_id: str) -> None:
    """Delete the tracker row for a draft. Idempotent — missing row is fine."""
    client = get_client()
    (
        client.table("youtube_title_fallback_tracker")
        .delete()
        .eq("channel_id", channel_id)
        .eq("video_id", video_id)
        .execute()
    )


# ── Cron Runs ────────────────────────────────────────────────────────────
# Every cron execution logs a start and finish record. This gives visibility
# into whether jobs are running, how long they take, and when they fail.


def log_cron_start(platform: str, job_type: str) -> str:
    """Log the start of a cron run. Returns the run ID."""
    client = get_client()
    result = (
        client.table("cron_runs")
        .insert({"platform": platform, "job_type": job_type, "status": "running"})
        .execute()
    )
    if not result.data:
        raise RuntimeError(
            f"log_cron_start for {platform}/{job_type} returned no rows — check RLS / schema"
        )
    # Return the auto-generated ID so the caller can update this row later
    return result.data[0]["id"]


def sanitize_error_message(message: str) -> str:
    """Strip potential credentials from error messages before storing in the DB.

    Cron jobs catch exceptions and log str(e) — but exception messages can
    contain tokens, API keys, or URLs with query-string secrets leaked by
    HTTP libraries. This function redacts anything that looks like a secret
    so it never lands in the cron_runs table (which the dashboard reads).
    """
    # Redact Bearer tokens: "Bearer eyJhb..." → "Bearer [REDACTED]"
    message = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", message)
    # Redact URL query params that look like tokens/keys:
    #   ?token=abc123&key=xyz → ?token=[REDACTED]&key=[REDACTED]
    message = re.sub(
        r"([?&](token|key|secret|api_key|apikey|access_token|refresh_token)=)[^\s&]+",
        r"\1[REDACTED]",
        message,
        flags=re.IGNORECASE,
    )
    # Redact long alphanumeric strings (64+ chars) that look like API keys/tokens.
    # Preserves UUIDs (36 chars with hyphens) and short identifiers.
    message = re.sub(r"[A-Za-z0-9_\-]{64,}", "[REDACTED_KEY]", message)
    return message


def log_cron_finish(
    run_id: str,
    status: str,
    posts_processed: int = 0,
    error_message: str | None = None,
) -> None:
    """Log the end of a cron run."""
    client = get_client()
    data: dict = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "posts_processed": posts_processed,
    }
    if error_message:
        # Sanitize before storing — error messages from HTTP libraries can
        # contain tokens, API keys, or auth headers in the exception text
        data["error_message"] = sanitize_error_message(error_message)
    # Swallow DB failures here: this function is called from the `finally`-
    # style end of every cron phase, so raising would replace the real run
    # outcome with a DB error and leave operators chasing the wrong cause.
    # A transient Supabase blip should not hide the underlying success/fail.
    try:
        client.table("cron_runs").update(data).eq("id", run_id).execute()
    except Exception as e:
        logger.error("log_cron_finish failed for run_id=%s: %s", run_id, e)
