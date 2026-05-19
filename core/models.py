# ── Data Models ─────────────────────────────────────────────────────────
# These Pydantic models define the shape of data flowing through the system.
# They serve three purposes:
#   1. Validation — Pydantic checks types at runtime, catching bugs early.
#   2. Serialization — .model_dump() converts them to dicts for Supabase inserts.
#   3. Documentation — field names and types are the source of truth for the schema.
#
# Each model maps roughly to a Supabase table (see supabase/migrations/).

from __future__ import annotations

import logging
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, field_validator

logger = logging.getLogger(__name__)


# ── Post ────────────────────────────────────────────────────────────────
# Represents a single piece of content destined for one platform.
# A post starts as "draft", moves through "publishing" while being sent to the
# platform API, and ends as either "published" or "failed".
# Status flow:  draft -> publishing -> published
#                                  \-> failed (with error_message set)

class Post(BaseModel):
    # None until Supabase assigns an ID on insert
    id: str | None = None
    # Which platform this post targets. Pinned to the same set as the SQL
    # enum (`platform_enum` in supabase/migrations/20260412105430_initial_schema.sql) so a
    # typo surfaces at Pydantic validation time instead of later as a
    # cryptic Postgres constraint-violation error.
    platform: Literal[
        "youtube",
        "instagram",
        "instagram_2nd",
        "tiktok",
        "linkedin",
        "facebook",
        "threads",
        "threads_leila",
        "linkedin_leila",
        # acq_official X (Twitter) handle. Used as a fan-out destination on
        # manual TikTok uploads so each uploaded reel also lands in Buffer's
        # X queue under the acq_official channel. Added in migration
        # 20260514120000_x_acq_official_enum.sql.
        "x_acq_official",
        # Snapchat Spotlight. Published via headless Chromium (Playwright)
        # against the Public Profile Web Uploader — no upload API exists for
        # unattended posting. Session cookies live in the platform_session_state
        # table. Added in migration 20260519120000_add_snapchat_enum.sql.
        "snapchat",
    ]
    # The ID the platform gives back after publishing (e.g. a YouTube video ID).
    # None until the post is actually published.
    platform_post_id: str | None = None
    # Tracks where the post is in its lifecycle (see status flow above).
    status: Literal[
        "draft",
        "scheduled",
        "publishing",
        "published",
        "failed",
        "sent_to_buffer",
        "buffer_error",
    ] = "draft"
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
    # Platform-specific structured metadata. For the YouTube studio-first
    # cron, stores {"source": "studio", "publish_at": "<ISO-8601 UTC>",
    # "original_title": ..., "generated_title": ..., "transcript_chars": int,
    # "caption_track_kind": "standard"|"asr"|"",
    # "title_source": "generated"|"fallback",
    # "fallback_skip_count": int (only on fallback rows, records how many
    # consecutive "transcript unavailable" skips occurred before fallback)}.
    metadata: dict = {}

    # Coerce a DB-returned NULL for hashtags into an empty list.
    #
    # The hashtags column is nullable in Postgres, so any route that inserts
    # a posts row without setting it (e.g. /api/ig-pipeline, and previously
    # /api/snapchat-pipeline) leaves the column as NULL. process_due_posts
    # then hydrates the row into Post() and Pydantic v2 rejects None for a
    # `list[str]` field with a type_error. That crashes the publisher cron
    # before it can even attempt the platform call.
    #
    # mode='before' runs prior to type validation, so None gets rewritten to
    # [] before Pydantic checks the type. The cron-side fix is here (defense
    # in depth); the route-side fix is to insert hashtags=[] explicitly so
    # the column never goes NULL in the first place. Both are cheap, and
    # the model-side belt catches anything a future route forgets.
    @field_validator("hashtags", mode="before")
    @classmethod
    def _coerce_none_hashtags(cls, v: list[str] | None) -> list[str]:
        if v is None:
            # DEBUG (not WARNING) because this is the validator catching
            # the bug, not the bug itself — INFO/WARNING would noise up the
            # cron logs every time we hydrate a Buffer-era posts row that
            # legitimately has NULL hashtags. Grep this string when a
            # specific route is suspected of forgetting hashtags=[] on
            # insert; the column is non-null in the Pydantic contract so
            # an explicit [] from the caller is the long-term fix.
            logger.debug(
                "Post.hashtags coerced from NULL — caller should pass [] "
                "explicitly on insert"
            )
            return []
        return v


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
