from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


class Post(BaseModel):
    id: str | None = None
    platform: str
    platform_post_id: str | None = None
    status: str = "draft"
    title: str | None = None
    caption: str | None = None
    media_type: str | None = None  # 'image', 'video', 'carousel'
    media_urls: list[str] = []
    hashtags: list[str] = []
    permalink: str | None = None
    published_at: datetime | None = None
    error_message: str | None = None


class ScheduledPost(BaseModel):
    post: Post
    scheduled_for: datetime


class EngagementSnapshot(BaseModel):
    platform_post_id: str
    platform: str
    views: int = 0
    likes: int = 0
    comments: int = 0
    shares: int = 0
    saves: int = 0
    clicks: int = 0
    impressions: int = 0
    reach: int = 0
    watch_time_sec: int = 0
    followers_delta: int = 0
    extra: dict = {}


class MediaUploadResult(BaseModel):
    platform_media_id: str | None = None
    upload_url: str | None = None
    metadata: dict = {}


class CronRun(BaseModel):
    id: str | None = None
    platform: str
    job_type: str  # 'post', 'metrics'
    status: str = "running"
    posts_processed: int = 0
    error_message: str | None = None
