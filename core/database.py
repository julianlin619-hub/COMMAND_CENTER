"""Supabase client and all database operations."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from supabase import Client, create_client

from core.models import CronRun, EngagementSnapshot, Post

logger = logging.getLogger(__name__)

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


def insert_post(post: Post) -> str:
    """Insert a post record. Returns the post ID."""
    client = get_client()
    data = post.model_dump(exclude_none=True, exclude={"id"})
    result = client.table("posts").insert(data).execute()
    return result.data[0]["id"]


def update_post(post_id: str, **fields) -> None:
    """Update specific fields on a post."""
    client = get_client()
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
    query = query.range(offset, offset + limit - 1)
    return query.execute().data


# ── Schedules ────────────────────────────────────────────────────────────


def get_due_schedules(platform: str) -> list[dict]:
    """Get schedules that are due and haven't been picked up yet."""
    client = get_client()
    now = datetime.now(timezone.utc).isoformat()
    return (
        client.table("schedules")
        .select("*, posts(*)")
        .is_("picked_up_at", "null")
        .lte("scheduled_for", now)
        .eq("posts.platform", platform)
        .execute()
        .data
    )


def mark_schedule_picked_up(schedule_id: str) -> None:
    """Mark a schedule as picked up to prevent double-processing."""
    client = get_client()
    client.table("schedules").update(
        {"picked_up_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", schedule_id).execute()


# ── Engagement Metrics ───────────────────────────────────────────────────


def upsert_metrics(post_id: str, snapshot: EngagementSnapshot) -> None:
    """Insert an engagement metrics snapshot."""
    client = get_client()
    data = snapshot.model_dump()
    data["post_id"] = post_id
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
    if since:
        query = query.gte("snapshot_at", since)
    query = query.limit(limit)
    return query.execute().data


# ── Cron Runs ────────────────────────────────────────────────────────────


def log_cron_start(platform: str, job_type: str) -> str:
    """Log the start of a cron run. Returns the run ID."""
    client = get_client()
    result = (
        client.table("cron_runs")
        .insert({"platform": platform, "job_type": job_type, "status": "running"})
        .execute()
    )
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
