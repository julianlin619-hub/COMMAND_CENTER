"""LinkedIn platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap LinkedIn's Marketing/Community Management API.
-----------------------------------------------------------------
Key things to know about LinkedIn's API:
  - Auth uses OAuth 2.0 (3-legged).  Access tokens last 60 days; refresh
    tokens last 365 days.  This is generous compared to most platforms.
  - Posting uses the /rest/posts endpoint (v2 API, also called the
    "Community Management API").  Text posts are simple JSON; media posts
    require a separate upload-register-then-upload-binary flow.
  - LinkedIn distinguishes between personal profiles (urn:li:person:xxx)
    and company pages (urn:li:organization:xxx).  The "author" URN must
    be included in every post.
  - Metrics are available via the /organizationalEntityShareStatistics
    endpoint (for company pages) or less granularly for personal profiles.
  - Rate limits are relatively tight — be careful with batch operations.

API docs: https://learn.microsoft.com/en-us/linkedin/marketing/
"""

from platforms.base import PlatformBase
from core.models import MediaUploadResult, Post


class LinkedIn(PlatformBase):
    name = "linkedin"

    def validate_config(self) -> None:
        raise NotImplementedError("TODO: port from existing repo")

    def refresh_credentials(self) -> None:
        # Will call POST /oauth/v2/accessToken with grant_type=refresh_token.
        # LinkedIn tokens are long-lived (60 days), but we still refresh
        # periodically to avoid unexpected expiration during a cron run.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /v2/userinfo to verify the access token is still
        # valid and has the required scopes (w_member_social, r_basicprofile,
        # etc.).
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Will call POST /rest/posts with a JSON body containing:
        #   - author (the person or organization URN)
        #   - commentary (the post text)
        #   - visibility (PUBLIC or CONNECTIONS)
        #   - distribution (MAIN_FEED)
        #   - optional media references (from upload_media)
        # Returns the post URN (e.g., "urn:li:share:123456789").
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # LinkedIn media upload is a two-step process:
        # 1. POST /rest/images (or /rest/videos) to register the upload and
        #    get a pre-signed upload URL.
        # 2. PUT the binary file to that upload URL.
        # Returns a MediaUploadResult containing the media asset URN that
        # create_post will reference.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return LinkedIn's limits: images up to 10 MB (PNG, JPG, GIF),
        # videos up to 200 MB and 10 min, article links with preview images,
        # post text up to 3000 chars, etc.
        raise NotImplementedError("TODO: port from existing repo")
