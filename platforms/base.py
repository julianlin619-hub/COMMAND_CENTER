"""Abstract base class that every platform module implements.

STRATEGY PATTERN — This is the heart of the platforms/ package.
-----------------------------------------------------------------
This file defines PlatformBase, an abstract base class (ABC). Every platform
adapter (YouTube, Instagram, TikTok, LinkedIn, X, Threads) inherits from
PlatformBase and implements the exact same set of methods.

Why does this matter?  Because the rest of the codebase (cron jobs, core logic)
never needs to know *which* platform it's talking to.  It just calls methods
like `create_post()` or `get_post_metrics()` on whatever PlatformBase subclass
it receives.  This is the "strategy pattern" — swap in any strategy (platform)
and the calling code stays the same.

Quick glossary for learners:
  - ABC (Abstract Base Class): A class you can't instantiate directly. It exists
    only to be subclassed.  If you try `PlatformBase()` you'll get a TypeError.
  - @abstractmethod: Marks a method that *must* be overridden in every subclass.
    Python will refuse to instantiate a subclass that's missing any abstract
    method.  This guarantees every adapter provides the full interface.
"""

from __future__ import annotations

# `ABC` gives us the abstract base class machinery.
# `abstractmethod` is the decorator that enforces "you must implement this."
from abc import ABC, abstractmethod

# These are our shared Pydantic data models (defined in core/models.py).
# Using them here means every platform adapter speaks the same data language —
# the cron job doesn't need to translate between different return types.
from core.models import EngagementSnapshot, MediaUploadResult, Post


class PlatformBase(ABC):
    """Contract for platform modules.

    Every platform file implements this interface. Core logic calls these
    methods — it never touches platform APIs directly.
    """

    # Every subclass sets this to its platform name (e.g. "youtube").
    # This string matches the platform_enum values in the database, so we can
    # look up the right adapter class by name at runtime.
    name: str  # e.g. "youtube", "instagram" — matches platform_enum

    # ── Authentication ──────────────────────────────────────────
    # Each platform has its own auth scheme (OAuth2, API keys, etc.).
    # These two methods let the cron job refresh tokens before they expire
    # and verify that credentials are still usable.

    @abstractmethod
    def refresh_credentials(self) -> None:
        """Refresh OAuth/API tokens. Updates internal state."""
        ...

    @abstractmethod
    def validate_credentials(self) -> bool:
        """Check if current credentials are still valid. No side effects."""
        ...

    # ── Posting ─────────────────────────────────────────────────
    # The core publishing action.  The cron job reads a scheduled post from
    # Supabase, builds a Post model, and passes it here.  The adapter
    # translates it into whatever the platform's API expects.

    @abstractmethod
    def create_post(self, post: Post) -> str:
        """Publish a post immediately.

        Returns the platform-native post ID (stored as platform_post_id).
        Raises PlatformAPIError on failure.
        """
        ...

    # ── Media ───────────────────────────────────────────────────
    # Some platforms require you to upload media (images/videos) in a
    # separate step *before* creating the post.  Others accept media
    # inline with the post creation call.  These methods handle both cases.

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

        The dashboard UI uses these constraints to validate files *before*
        upload, so the user gets instant feedback ("video too long", etc.)
        instead of waiting for the platform API to reject it later.

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
    # After a post is published, the cron job periodically calls this to
    # pull engagement data (likes, views, comments, etc.) back into Supabase.
    # Each platform returns different field names, so the adapter's job is to
    # map them into our unified EngagementSnapshot model.

    @abstractmethod
    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        """Fetch current engagement metrics for a single post.

        Maps platform-specific field names to the unified EngagementSnapshot.
        """
        ...
