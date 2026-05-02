"""YouTube Data API v3 adapter — studio-first scheduling workflow.

Videos are uploaded manually to YouTube Studio as Private drafts; this
adapter discovers those drafts and applies a publish schedule via
`videos.update`. Direct uploads through `videos.insert` are intentionally
not supported (1600 quota units/upload, ~6 videos/day ceiling). The full
workflow lives in `core.youtube_studio_scheduler`; this file only exposes
the API primitives it uses.

Authentication: Google OAuth 2.0 with a long-lived refresh token in env
vars. The refresh token needs `youtube.force-ssl` (for videos.update and
captions.download) and `youtube.readonly` (for channel/playlist/video
reads). See `scripts/generate_youtube_refresh_token.py`.

API docs: https://developers.google.com/youtube/v3
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import httpx

from core.auth import refresh_oauth_token
from core.exceptions import (
    NonRetryablePlatformError,
    PlatformAPIError,
    PlatformAuthError,
    PlatformRateLimitError,
)
from core.models import MediaUploadResult, Post
from core.retry import with_retry
from platforms.base import PlatformBase

logger = logging.getLogger(__name__)

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_API_BASE = "https://www.googleapis.com/youtube/v3"
_REQUEST_TIMEOUT = 15.0
_DEFAULT_CATEGORY_ID = "22"  # "People & Blogs" — YouTube's default for new uploads


@dataclass(frozen=True)
class CaptionTrack:
    """A single caption track attached to a video.

    `track_kind` is YouTube's `snippet.trackKind` — "standard" for
    uploader-provided tracks, "asr" for auto-generated ones. `language`
    is a BCP-47 tag (e.g. "en", "en-US", "es"). The scheduler prefers
    standard + English tracks when present.
    """

    id: str
    track_kind: str
    language: str


@dataclass(frozen=True)
class PrivateVideo:
    """A Private video in the authenticated user's uploads.

    `publish_at` is None for drafts (ready to schedule) and a tz-aware ISO
    string for videos already scheduled (either by this cron or manually
    in Studio). The scheduler splits the list on this field.

    `has_been_published` is True when YouTube's records show the video
    was previously made public (cron schedule fired, or manual publish in
    Studio) and was later reverted to Private. Once a video has been
    published once, YouTube refuses any future `publishAt` on it with a
    misleading `invalidPublishAt` error — so the scheduler must skip
    these. We detect the case by comparing two timestamps that the API
    exposes:
        - playlistItems.snippet.publishedAt = when the video was added to
          the channel's "uploads" playlist (i.e. true upload time)
        - videos.snippet.publishedAt = first-publish time (or upload time
          if never published)
    If the two differ by more than a small tolerance, the video has been
    published before.
    """

    video_id: str
    title: str
    category_id: str
    uploaded_at: str  # playlistItems.snippet.publishedAt — true upload time
    published_at: str  # videos.snippet.publishedAt — first-publish or upload time
    publish_at: str | None  # status.publishAt — scheduled publish time
    has_been_published: bool = False


class YouTube(PlatformBase):
    name = "youtube"

    def __init__(self) -> None:
        self._access_token: str | None = None
        self._channel_id: str | None = None
        self._uploads_playlist_id: str | None = None

    # ── Config / auth ────────────────────────────────────────────────

    def validate_config(self) -> None:
        self._check_env_vars(
            "YOUTUBE_CLIENT_ID",
            "YOUTUBE_CLIENT_SECRET",
            "YOUTUBE_REFRESH_TOKEN",
        )

    def refresh_credentials(self) -> None:
        self._access_token = refresh_oauth_token(
            token_url=_TOKEN_URL,
            client_id_env="YOUTUBE_CLIENT_ID",
            client_secret_env="YOUTUBE_CLIENT_SECRET",
            refresh_token_env="YOUTUBE_REFRESH_TOKEN",
        )

    @with_retry()
    def validate_credentials(self) -> bool:
        """Confirm the token owns a channel; cache channel + uploads playlist IDs.

        If `YOUTUBE_CHANNEL_ID` is set, asserts the owned channel matches —
        this guards against a misrouted refresh token pointing at the wrong
        account. Side-effect: populates `_channel_id` and
        `_uploads_playlist_id` for later calls.

        Cost: 1 quota unit.
        """
        resp = httpx.get(
            f"{_API_BASE}/channels",
            params={"part": "id,contentDetails", "mine": "true"},
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        _raise_for_youtube_error(resp)
        items = resp.json().get("items") or []
        if not items:
            raise PlatformAuthError(
                "channels.list returned no items — token has no owned channel"
            )
        self._channel_id = items[0]["id"]
        self._uploads_playlist_id = (
            items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
        )

        expected = os.environ.get("YOUTUBE_CHANNEL_ID")
        if expected and expected != self._channel_id:
            raise PlatformAuthError(
                f"Channel ID mismatch: token authenticates as {self._channel_id}, "
                f"but YOUTUBE_CHANNEL_ID is set to {expected}"
            )
        return True

    @property
    def channel_id(self) -> str:
        """Owned channel ID. Requires validate_credentials to have run.

        Exposed so the studio-first scheduler can key its per-draft retry
        tracker on (channel_id, video_id). `list_my_private_videos()` calls
        `validate_credentials()` lazily, so reading `client.channel_id`
        immediately after the discovery call is safe in practice.
        """
        if self._channel_id is None:
            raise PlatformAuthError(
                "YouTube.channel_id accessed before validate_credentials ran"
            )
        return self._channel_id

    # ── Studio-first primitives ──────────────────────────────────────

    @with_retry()
    def list_my_private_videos(self, *, max_results: int = 50) -> list[PrivateVideo]:
        """Return recent Private videos, oldest upload first.

        Includes both unscheduled drafts (publish_at is None) and videos
        already scheduled (publish_at is set). The scheduler splits the
        list — drafts go to the scheduling queue, scheduled videos become
        "taken" slots for conflict avoidance.

        Cost: ~2 quota units (playlistItems.list + videos.list, amortized
        across pages of 50). Falls back to an implicit validate_credentials
        call if credentials haven't been validated yet — that costs an
        extra 1 unit on the first invocation.
        """
        if self._uploads_playlist_id is None:
            self.validate_credentials()
        assert self._uploads_playlist_id is not None

        # We pull `snippet` from playlistItems (not just contentDetails) so we
        # can capture each item's `snippet.publishedAt` — the time the video
        # was added to the channel's uploads playlist, which is the original
        # upload time. We compare it with `videos.snippet.publishedAt` below
        # to detect videos that were previously published and reverted to
        # Private (YouTube refuses to reschedule those).
        playlist_resp = httpx.get(
            f"{_API_BASE}/playlistItems",
            params={
                "part": "contentDetails,snippet",
                "playlistId": self._uploads_playlist_id,
                "maxResults": str(max_results),
            },
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        _raise_for_youtube_error(playlist_resp)
        # Build {video_id: upload_time_iso} so we can join against the
        # videos.list response by ID.
        upload_times: dict[str, str] = {}
        for item in playlist_resp.json().get("items", []):
            vid = item.get("contentDetails", {}).get("videoId")
            if not vid:
                continue
            upload_times[vid] = item.get("snippet", {}).get("publishedAt", "")
        video_ids = list(upload_times.keys())
        if not video_ids:
            return []

        videos_resp = httpx.get(
            f"{_API_BASE}/videos",
            params={"part": "snippet,status", "id": ",".join(video_ids)},
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        _raise_for_youtube_error(videos_resp)

        results: list[PrivateVideo] = []
        for v in videos_resp.json().get("items", []):
            status = v.get("status", {})
            if status.get("privacyStatus") != "private":
                continue
            snippet = v.get("snippet", {})
            uploaded_at = upload_times.get(v["id"], "")
            published_at = snippet.get("publishedAt", "")
            results.append(
                PrivateVideo(
                    video_id=v["id"],
                    title=snippet.get("title", ""),
                    category_id=snippet.get("categoryId", _DEFAULT_CATEGORY_ID),
                    uploaded_at=uploaded_at,
                    published_at=published_at,
                    publish_at=status.get("publishAt"),
                    has_been_published=_was_previously_published(
                        uploaded_at, published_at
                    ),
                )
            )
        # Oldest upload first — earliest drafts get scheduled first.
        results.sort(key=lambda v: v.published_at)
        return results

    @with_retry()
    def update_video_schedule(
        self,
        video_id: str,
        *,
        title: str,
        category_id: str,
        publish_at_iso: str,
    ) -> None:
        """Apply a scheduled publish to a Private video.

        Sends `part=snippet,status` and updates only title, category, and
        publishAt. `privacyStatus` must stay "private" — that's what lets
        publishAt take effect; once publishAt fires, YouTube flips the
        video to "public" automatically. Description, tags, madeForKids,
        and other metadata are not touched (Studio settings stand).

        Cost: 50 quota units.
        """
        payload = {
            "id": video_id,
            "snippet": {
                "title": title,
                # categoryId is required when updating snippet; we echo the
                # current value rather than overriding, so a video you
                # manually recategorized in Studio keeps its category.
                "categoryId": category_id,
            },
            "status": {
                "privacyStatus": "private",
                "publishAt": publish_at_iso,
            },
        }
        resp = httpx.put(
            f"{_API_BASE}/videos",
            params={"part": "snippet,status"},
            json=payload,
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        # Log the exact payload we sent when the update fails — YouTube's
        # error messages are generic (e.g. invalidPublishAt is a catch-all),
        # so seeing the payload side-by-side with the rejection is often the
        # only way to tell what's actually being rejected.
        if not resp.is_success:
            logger.error(
                "videos.update rejected for %s — payload: %s", video_id, payload
            )
        _raise_for_youtube_error(resp)

    # ── Captions ─────────────────────────────────────────────────────

    @with_retry()
    def list_caption_tracks(self, video_id: str) -> list[CaptionTrack]:
        """List all caption tracks attached to a video.

        Returns both uploader-provided ("standard") and auto-generated
        ("asr") tracks. Empty list is a valid result — new uploads often
        have no ASR track yet while YouTube processes audio.

        Cost: 50 quota units.
        """
        resp = httpx.get(
            f"{_API_BASE}/captions",
            params={"part": "snippet", "videoId": video_id},
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        _raise_for_youtube_error(resp)
        items = resp.json().get("items", [])
        tracks: list[CaptionTrack] = []
        for it in items:
            snippet = it.get("snippet", {})
            tracks.append(
                CaptionTrack(
                    id=it["id"],
                    track_kind=snippet.get("trackKind", ""),
                    language=snippet.get("language", ""),
                )
            )
        return tracks

    @with_retry()
    def download_caption(self, track_id: str) -> str:
        """Download a caption track's body as WEBVTT text.

        Requires the `youtube.force-ssl` scope — a 403 here almost always
        means the refresh token was minted without it, and is mapped to
        `PlatformAuthError` by `_raise_for_youtube_error`. The scheduler
        catches that and skips the draft.

        Cost: 200 quota units.
        """
        resp = httpx.get(
            f"{_API_BASE}/captions/{track_id}",
            params={"tfmt": "vtt"},
            headers=self._auth_headers(),
            timeout=_REQUEST_TIMEOUT,
        )
        _raise_for_youtube_error(resp)
        return resp.text

    # ── PlatformBase holdovers ───────────────────────────────────────
    # Direct uploads are not supported in studio-first. Kept only to satisfy
    # the abstract interface so `YouTube()` can be instantiated.

    def create_post(self, post: Post) -> str:
        raise NotImplementedError(
            "YouTube uploads are manual via Studio; scheduling is handled by "
            "core.youtube_studio_scheduler"
        )

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        raise NotImplementedError(
            "YouTube uploads are manual via Studio; scheduling is handled by "
            "core.youtube_studio_scheduler"
        )

    def get_media_constraints(self) -> dict:
        # Not actively consumed by the studio-first flow (Studio enforces
        # constraints at manual upload time). Surfaced here only to satisfy
        # the PlatformBase interface.
        return {
            "max_video_duration_sec": 12 * 3600,
            "max_file_size_gb": 256,
            "supported_formats": ["mp4", "mov", "avi", "wmv", "flv", "webm"],
            "max_title_length": 100,
            "max_description_length": 5000,
        }

    # ── Internal helpers ─────────────────────────────────────────────

    def _auth_headers(self) -> dict[str, str]:
        if not self._access_token:
            raise PlatformAuthError(
                "YouTube adapter has no access token — call refresh_credentials() first"
            )
        return {"Authorization": f"Bearer {self._access_token}"}


def _was_previously_published(uploaded_at: str, published_at: str) -> bool:
    """Detect whether YouTube records show this video was previously public.

    A Private video that has never been made public has
    `videos.snippet.publishedAt == playlistItems.snippet.publishedAt`
    (both equal the original upload time). Once the video has gone public
    even briefly, `videos.snippet.publishedAt` is rewritten to the publish
    moment and stays there even if the privacy is reverted to Private.
    A non-trivial difference therefore means the video has already been
    published — and YouTube will reject any future `publishAt` on it with
    a `400 invalidPublishAt` error.

    We compare with a 60-second tolerance. The two timestamps come from
    different parts of the API and occasionally differ by a few seconds
    even on never-published videos (e.g. when the video and the playlist
    item are recorded by separate services). 60s is generous enough to
    absorb that drift while still catching real prior-publish events,
    which differ by hours or days.

    Returns False (i.e. "treat as fresh, attempt to schedule") if either
    timestamp is missing or unparseable — the conservative choice, since
    the scheduler will at worst hit one rejected videos.update call which
    is now non-retryable.
    """
    from datetime import datetime, timezone

    if not uploaded_at or not published_at:
        return False
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    try:
        u = datetime.strptime(uploaded_at, fmt).replace(tzinfo=timezone.utc)
        p = datetime.strptime(published_at, fmt).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return abs((p - u).total_seconds()) > 60


def _raise_for_youtube_error(response: httpx.Response) -> None:
    """Map a YouTube API error response to our exception hierarchy.

    Logs the full response body on error. The scheduler inspects
    `PlatformAPIError.status_code` (and the message) to handle
    `403 quotaExceeded` specially — a generic 403 stays an auth error.
    """
    if response.is_success:
        return
    status = response.status_code
    try:
        body = response.json()
    except Exception:  # pragma: no cover — only hit on non-JSON errors
        body = {"raw": response.text}
    logger.error("YouTube API %s error: %s", status, body)

    # Try to extract the "reason" field YouTube includes on 403s
    # (e.g. "quotaExceeded", "forbidden", "insufficientPermissions"). The
    # scheduler uses it to tell quota-exhaustion apart from hard auth fails.
    reason = ""
    try:
        errors = body.get("error", {}).get("errors", [])
        if errors:
            reason = errors[0].get("reason", "")
    except AttributeError:
        pass

    if status == 401:
        raise PlatformAuthError(f"YouTube API 401: {body}")
    if status == 403:
        # quotaExceeded bubbles up as a PlatformAPIError with a status of 403
        # so the scheduler can catch it specifically. All other 403s are auth
        # errors (insufficient scope, wrong channel, etc.).
        if reason in {"quotaExceeded", "rateLimitExceeded", "dailyLimitExceeded"}:
            raise PlatformAPIError(
                f"YouTube quota exceeded ({reason}): {body}", status_code=403
            )
        raise PlatformAuthError(f"YouTube API 403 ({reason}): {body}")
    if status == 429:
        retry_after = None
        header = response.headers.get("retry-after")
        if header:
            try:
                retry_after = float(header)
            except ValueError:
                retry_after = None
        raise PlatformRateLimitError(
            f"YouTube rate limited: {body}", retry_after=retry_after
        )
    # `invalidPublishAt` is YouTube's catch-all for "I refuse to schedule this
    # video" — most commonly hit when the video has already been published
    # once and reverted to Private (the cron's `has_been_published` filter
    # should catch most of these upstream, but a race between discovery and
    # update is possible). It's a permanent 400 — retrying just burns 50
    # quota units per attempt for nothing.
    if status == 400 and reason == "invalidPublishAt":
        raise NonRetryablePlatformError(
            f"YouTube API 400 ({reason}): {body}", status_code=400
        )
    raise PlatformAPIError(f"YouTube API {status}: {body}", status_code=status)
