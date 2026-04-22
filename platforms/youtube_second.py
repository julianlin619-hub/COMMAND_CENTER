"""YouTube second-channel direct-upload adapter.

This adapter exists as a thin Python-side declaration of the platform so
core/models validation, env-var checks, and any future CLI/reconciliation
tooling have a consistent home. **Runtime uploading happens in the
dashboard (Next.js API routes + browser XHR)**, not here — the browser
streams bytes directly to YouTube's resumable endpoint, bypassing both
Render and Supabase Storage.

Deliberately decoupled from the existing `platforms/youtube.py` stub:
we treat youtube_second as a separate platform end-to-end so the two
channels can be iterated on independently. No import, no subclassing.
"""

from __future__ import annotations

from platforms.base import PlatformBase
from core.models import MediaUploadResult, Post


class YouTubeSecond(PlatformBase):
    name = "youtube_second"

    def validate_config(self) -> None:
        # Only the refresh-token script and potential reconciliation tooling
        # ever construct this adapter in Python. The dashboard Node runtime
        # reads these same env vars through process.env.
        self._check_env_vars(
            "YOUTUBE_SECOND_CLIENT_ID",
            "YOUTUBE_SECOND_CLIENT_SECRET",
            "YOUTUBE_SECOND_REFRESH_TOKEN",
        )

    def refresh_credentials(self) -> None:
        raise NotImplementedError(
            "youtube_second runtime lives in dashboard/src/app/api/youtube-second/*. "
            "If you need a Python-side token refresh, implement it here."
        )

    def validate_credentials(self) -> bool:
        raise NotImplementedError(
            "youtube_second credential validation is handled by the Node runtime."
        )

    def create_post(self, post: Post) -> str:
        raise NotImplementedError(
            "youtube_second does not publish from Python. Uploads happen "
            "browser-direct via the /api/youtube-second/upload-init flow."
        )

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        raise NotImplementedError(
            "youtube_second does not upload media from Python. The browser "
            "streams the file directly to YouTube's resumable endpoint."
        )

    def get_media_constraints(self) -> dict:
        # Mirror the limits enforced by the upload-init route so any Python
        # caller (future validation CLI, reconciliation job) sees the same
        # numbers as the dashboard.
        return {
            "max_file_size_bytes": 256 * 1024 * 1024 * 1024,  # 256 GB
            "max_title_length": 100,
            "supported_formats": ["mp4", "mov", "webm", "avi", "mkv"],
            "media_types": ["video"],
        }
