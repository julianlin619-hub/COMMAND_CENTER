"""Abstract base class that every platform module implements."""

from __future__ import annotations

from abc import ABC, abstractmethod

from core.models import EngagementSnapshot, MediaUploadResult, Post


class PlatformBase(ABC):
    """Contract for platform modules.

    Every platform file implements this interface. Core logic calls these
    methods — it never touches platform APIs directly.
    """

    name: str  # e.g. "youtube", "instagram" — matches platform_enum

    # ── Authentication ──────────────────────────────────────────

    @abstractmethod
    def refresh_credentials(self) -> None:
        """Refresh OAuth/API tokens. Updates internal state."""
        ...

    @abstractmethod
    def validate_credentials(self) -> bool:
        """Check if current credentials are still valid. No side effects."""
        ...

    # ── Posting ─────────────────────────────────────────────────

    @abstractmethod
    def create_post(self, post: Post) -> str:
        """Publish a post immediately.

        Returns the platform-native post ID (stored as platform_post_id).
        Raises PlatformAPIError on failure.
        """
        ...

    # ── Media ───────────────────────────────────────────────────

    @abstractmethod
    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        """Upload a media file to the platform if required before posting.

        Args:
            local_path: Path to the local media file.
            media_type: 'image' or 'video'.

        Returns:
            MediaUploadResult with platform_media_id and any upload metadata.
            Platforms that handle media inline with create_post return
            MediaUploadResult with platform_media_id=None.
        """
        ...

    @abstractmethod
    def get_media_constraints(self) -> dict:
        """Return platform-specific media requirements.

        Example return value:
            {
                "max_video_duration_sec": 60,
                "max_file_size_mb": 100,
                "supported_formats": ["mp4", "mov"],
                "aspect_ratios": ["9:16", "1:1"],
                "max_caption_length": 2200,
            }
        """
        ...

    # ── Analytics ───────────────────────────────────────────────

    @abstractmethod
    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        """Fetch current engagement metrics for a single post.

        Maps platform-specific field names to the unified EngagementSnapshot.
        """
        ...
