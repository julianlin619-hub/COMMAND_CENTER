"""YouTube platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap the YouTube Data API v3.
-----------------------------------------------------------------
YouTube's API is one of the more complex ones:
  - Auth uses OAuth 2.0 with refresh tokens (Google-style).  Tokens expire
    after ~1 hour, so refresh_credentials() will use the refresh token to
    get a new access token.
  - Uploading a video is a resumable, multi-part upload (can be large files).
    The API returns a video ID that you then use for everything else.
  - "Creating a post" here means uploading a video with title, description,
    tags, and privacy status (public/unlisted/private).
  - Metrics come from the YouTube Analytics API (a separate API from the
    Data API), or from the videos.list endpoint for basic stats like
    viewCount and likeCount.

API docs: https://developers.google.com/youtube/v3
"""

from platforms.base import PlatformBase
from core.models import EngagementSnapshot, MediaUploadResult, Post


class YouTube(PlatformBase):
    name = "youtube"

    def refresh_credentials(self) -> None:
        # Will use Google's OAuth 2.0 token refresh flow.
        # Google access tokens expire every ~3600 seconds, so the cron job
        # should call this before each batch of API calls.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will make a lightweight API call (e.g., channels.list for the
        # authenticated user) to confirm the token is still valid.
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Will call the videos.insert endpoint to upload and publish a video.
        # Returns the YouTube video ID (e.g., "dQw4w9WgXcQ").
        # Needs to handle: title, description, tags, categoryId,
        # privacyStatus, and the video file itself.
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # YouTube handles video upload as part of videos.insert (create_post),
        # so this may return a no-op result.  Alternatively, for thumbnails
        # or supplementary images, this would use thumbnails.set.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return YouTube's limits: max 256 GB or 12 hours video,
        # supported formats (mp4, mov, avi, etc.), max title/description
        # lengths, thumbnail size limits, etc.
        raise NotImplementedError("TODO: port from existing repo")

    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        # Will call videos.list with part=statistics to fetch viewCount,
        # likeCount, commentCount, etc., then map those into an
        # EngagementSnapshot.
        raise NotImplementedError("TODO: port from existing repo")
