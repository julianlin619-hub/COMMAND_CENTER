"""X (Twitter) platform implementation. Placeholder — will be filled from existing repo.

STUB FILE — This adapter will wrap the X (formerly Twitter) API v2.
-----------------------------------------------------------------
Key things to know about X's API:
  - Auth supports both OAuth 1.0a (user context) and OAuth 2.0 with PKCE.
    For automated posting on behalf of a user, OAuth 2.0 user context with
    refresh tokens is the modern approach.  Access tokens expire in ~2 hours;
    refresh tokens don't expire but can be revoked.
  - Posting a tweet is a single POST /2/tweets call with a JSON body.
    Media attachments must be uploaded separately first via the v1.1 media
    upload endpoint (yes, media upload is still on API v1.1).
  - X has strict rate limits — 1,500 tweets per month on the free tier,
    more on Basic/Pro plans.  Rate limiting is crucial here.
  - Metrics come from GET /2/tweets/{id} with tweet.fields=public_metrics
    (impressions, likes, retweets, replies, bookmarks, quotes).

API docs: https://developer.x.com/en/docs/x-api
"""

from platforms.base import PlatformBase
from core.models import EngagementSnapshot, MediaUploadResult, Post


class X(PlatformBase):
    name = "x"

    def refresh_credentials(self) -> None:
        # Will call POST /2/oauth2/token with grant_type=refresh_token
        # to get a new access token.  X access tokens expire every ~2 hours,
        # so this must run before each cron batch.
        raise NotImplementedError("TODO: port from existing repo")

    def validate_credentials(self) -> bool:
        # Will call GET /2/users/me to verify the token is valid and has
        # the required scopes (tweet.read, tweet.write, users.read, etc.).
        raise NotImplementedError("TODO: port from existing repo")

    def create_post(self, post: Post) -> str:
        # Will call POST /2/tweets with JSON body containing:
        #   - text (up to 280 chars, or 25,000 for long-form on premium)
        #   - optional media.media_ids (from upload_media)
        #   - optional poll, reply_settings, etc.
        # Returns the tweet ID string.
        raise NotImplementedError("TODO: port from existing repo")

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        # Uses the v1.1 media upload endpoint (POST media/upload) — this is
        # still on API v1.1 even though posting is on v2.  For images, it's
        # a simple multipart upload.  For videos, it's a chunked upload
        # (INIT -> APPEND -> FINALIZE -> poll STATUS).
        # Returns a MediaUploadResult with the media_id_string that
        # create_post will attach to the tweet.
        raise NotImplementedError("TODO: port from existing repo")

    def get_media_constraints(self) -> dict:
        # Will return X's limits: images up to 5 MB (JPG, PNG, GIF, WEBP),
        # videos up to 512 MB and 140 sec (or longer for premium),
        # GIFs up to 15 MB, text up to 280 chars, max 4 images per tweet
        # or 1 video/GIF, etc.
        raise NotImplementedError("TODO: port from existing repo")

    def get_post_metrics(self, platform_post_id: str) -> EngagementSnapshot:
        # Will call GET /2/tweets/{id} with:
        #   tweet.fields=public_metrics,non_public_metrics,organic_metrics
        # to fetch impression_count, like_count, retweet_count, reply_count,
        # bookmark_count, quote_count.  Maps these into an EngagementSnapshot.
        # Note: non_public_metrics and organic_metrics require the tweet
        # author's token (not just any app token).
        raise NotImplementedError("TODO: port from existing repo")
