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
from datetime import datetime, timezone

from supabase import Client, create_client

from core.models import CronRun, EngagementSnapshot, Post

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
    return result.data[0]["id"]


def update_post(post_id: str, **fields) -> None:
    """Update specific fields on a post."""
    client = get_client()
    # Always stamp updated_at so the dashboard can sort by "last modified"
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    client.table("posts").update(fields).eq("id", post_id).execute()


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


def get_due_schedules(platform: str) -> list[dict]:
    """Get schedules that are due and haven't been picked up yet."""
    client = get_client()
    now = datetime.now(timezone.utc).isoformat()
    return (
        client.table("schedules")
        # "*, posts(*)" is a Supabase join: fetch the schedule row AND the
        # related post row in one query (PostgREST embedded resources).
        .select("*, posts(*)")
        # picked_up_at being null means no cron run has claimed this schedule yet.
        # This prevents two overlapping cron runs from publishing the same post twice.
        .is_("picked_up_at", "null")
        # Only grab schedules whose time has arrived
        .lte("scheduled_for", now)
        # Filter to the specific platform this cron job handles
        .eq("posts.platform", platform)
        .execute()
        .data
    )


def mark_schedule_picked_up(schedule_id: str) -> None:
    """Mark a schedule as picked up to prevent double-processing."""
    # Setting picked_up_at to "now" is like a simple lock: any other cron
    # run that queries for due schedules will skip this one because
    # picked_up_at is no longer null.
    client = get_client()
    client.table("schedules").update(
        {"picked_up_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", schedule_id).execute()


# ── Engagement Metrics ───────────────────────────────────────────────────
# We store periodic snapshots of engagement data (not just the latest values)
# so the dashboard can chart trends over time.


def upsert_metrics(post_id: str, snapshot: EngagementSnapshot) -> None:
    """Insert an engagement metrics snapshot."""
    client = get_client()
    data = snapshot.model_dump()
    # Attach our internal post_id so we can join metrics back to posts
    data["post_id"] = post_id
    # We always insert (not upsert) because each snapshot is a new data point
    # in the time series, not a replacement for the previous one.
    client.table("engagement_metrics").insert(data).execute()


def get_metrics(
    post_id: str | None = None,
    platform: str | None = None,
    since: str | None = None,
    limit: int = 100,
) -> list[dict]:
    """Fetch engagement metrics with optional filters."""
    client = get_client()
    query = client.table("engagement_metrics").select("*").order("snapshot_at", desc=True)
    if post_id:
        query = query.eq("post_id", post_id)
    if platform:
        query = query.eq("platform", platform)
    # "since" lets the dashboard request only recent data (e.g. last 7 days)
    # instead of the entire history, keeping responses fast.
    if since:
        query = query.gte("snapshot_at", since)
    query = query.limit(limit)
    return query.execute().data


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
    # Return the auto-generated ID so the caller can update this row later
    return result.data[0]["id"]


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
        data["error_message"] = error_message
    client.table("cron_runs").update(data).eq("id", run_id).execute()
