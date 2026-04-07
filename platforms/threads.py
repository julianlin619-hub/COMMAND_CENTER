"""Threads platform implementation. Placeholder — will be filled from existing repo."""

from platforms.base import PlatformBase
from core.models import EngagementSnapshot, MediaUploadResult, Post


class Threads(PlatformBase):
    name = "threads"

    def refresh_credentials(self) -> None:
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        raise NotImplementedError("TODO: port from existing repo")

    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        raise NotImplementedError("TODO: port from existing repo")
