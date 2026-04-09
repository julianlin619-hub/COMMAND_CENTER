"""Facebook platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap the Facebook Graph API.
-----------------------------------------------------------------
Key things to know about Facebook's API:
  - Auth uses OAuth 2.0. Page posts require a Page Access Token (long-lived).
    User tokens expire in ~60 days; page tokens can be made non-expiring.
  - Posting to a page is POST /{page-id}/feed with message, link, or
    attached media. Photos go through /{page-id}/photos, videos through
    /{page-id}/videos.
  - Rate limits are app-level: 200 calls per user per hour for most endpoints.
  - Metrics come from /{post-id}/insights for page post metrics
    (impressions, reach, engagement, reactions, shares, comments).

API docs: https://developers.facebook.com/docs/graph-api
"""

from platforms.base import PlatformBase
from core.models import MediaUploadResult, Post


class Facebook(PlatformBase):
    name = "facebook"

    def refresh_credentials(self) -> None:
        # Will exchange a short-lived token for a long-lived one via
        # GET /oauth/access_token?grant_type=fb_exchange_token.
        # Long-lived page tokens don't expire, so this may be a no-op
        # once initially set up.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /me to verify the token is valid and has
        # the required permissions (pages_manage_posts, pages_read_engagement).
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Will call POST /{page-id}/feed with:
        #   - message (text content)
        #   - optional link, or attached media IDs from upload_media
        # Returns the post ID string.
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # Photos: POST /{page-id}/photos with multipart upload
        # Videos: POST /{page-id}/videos with resumable upload for large files
        # Returns a MediaUploadResult with the media ID.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return Facebook's limits: images up to 10 MB (JPG, PNG, GIF),
        # videos up to 10 GB and 240 min, text up to 63,206 chars,
        # max 10 images per post, etc.
        raise NotImplementedError("TODO: port from existing repo")
