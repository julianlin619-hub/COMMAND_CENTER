# ── Data Models ─────────────────────────────────────────────────────────
# These Pydantic models define the shape of data flowing through the system.
# They serve three purposes:
#   1. Validation — Pydantic checks types at runtime, catching bugs early.
#   2. Serialization — .model_dump() converts them to dicts for Supabase inserts.
#   3. Documentation — field names and types are the source of truth for the schema.
#
# Each model maps roughly to a Supabase table (see supabase/migrations/).

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


# ── Post ────────────────────────────────────────────────────────────────
# Represents a single piece of content destined for one platform.
# A post starts as "draft", moves through "publishing" while being sent to the
# platform API, and ends as either "published" or "failed".
# Status flow:  draft -> publishing -> published
#                                  \-> failed (with error_message set)

class Post(BaseModel):
    # None until Supabase assigns an ID on insert
    id: str | None = None
    # Which platform this post targets: 'youtube', 'instagram', 'tiktok', etc.
    platform: str
    # The ID the platform gives back after publishing (e.g. a YouTube video ID).
    # None until the post is actually published.
    platform_post_id: str | None = None
    # Tracks where the post is in its lifecycle (see status flow above)
    status: Literal["draft", "scheduled", "publishing", "published", "failed", "sent_to_buffer", "buffer_error"] = "draft"
    # Title is used by platforms that support it (YouTube, LinkedIn articles);
    # other platforms ignore it.
    title: str | None = None
    caption: str | None = None
    # What kind of media is attached: 'image', 'video', or 'carousel' (multi-image)
    media_type: str | None = None
    # Supabase Storage paths or external URLs pointing to the media files.
    # For carousel posts, this list has multiple entries.
    media_urls: list[str] = []
    hashtags: list[str] = []
    # The public URL of the published post (e.g. https://youtube.com/watch?v=...).
    # Set after publishing so the dashboard can link to it.
    permalink: str | None = None
    published_at: datetime | None = None
    # When status is "failed", this stores the error so it shows in the dashboard
    error_message: str | None = None


# ── ScheduledPost ───────────────────────────────────────────────────────
# Wraps a Post with a future timestamp. The cron job queries for schedules
# where scheduled_for <= now and picked_up_at is null — meaning "due and
# not yet being processed by another cron run."

class ScheduledPost(BaseModel):
    post: Post
    # When the post should go live. Cron jobs check every 4 hours, so the
    # actual publish time may lag by up to 4 hours after this timestamp.
    scheduled_for: datetime


# ── MediaUploadResult ───────────────────────────────────────────────────
# Returned by platform adapters after uploading media. Some platforms
# (e.g. YouTube) give back a media ID; others (e.g. LinkedIn) give an
# upload URL. The metadata dict holds any other info the platform returns.

class MediaUploadResult(BaseModel):
    platform_media_id: str | None = None
    upload_url: str | None = None
    # Platform-specific upload details (e.g. thumbnail URL, processing status)
    metadata: dict = {}


# ── CronRun ─────────────────────────────────────────────────────────────
# Audit log for cron job executions. Every time a cron fires, it creates a
# CronRun with status="running", then updates it to "success" or "error"
# when done. This lets the dashboard show job history and alert on failures.

class CronRun(BaseModel):
    id: str | None = None
    platform: str
    # What the cron job did: 'post' (publish scheduled posts) or
    # 'content' (source new content from external sources)
    job_type: str
    # Starts as "running", ends as "success" or "failed"
    status: Literal["running", "success", "failed"] = "running"
    posts_processed: int = 0
    error_message: str | None = None
