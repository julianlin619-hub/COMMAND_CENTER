"""Tests for core.video_batch.fanout_video.

Verifies the fan-out writes posts rows in the same shape as the single-file
manual upload (so buffer_reconcile + storage_cleanup handle them unchanged) and
applies the right per-platform caption limits / YouTube metadata. All external
calls (DB, Buffer) are monkeypatched in the core.video_batch namespace.
"""

from __future__ import annotations

import core.video_batch as vb
from core.models import Post


class _Recorder:
    """Captures inserted posts, buffer sends, and stamped buffer ids."""

    def __init__(self):
        self.inserted: list[Post] = []
        self.sends: list[dict] = []
        self.stamped: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self._next = 0

    def insert_post(self, post: Post) -> str:
        self.inserted.append(post)
        self._next += 1
        return f"post-{self._next}"

    def send_to_buffer(self, channel_id, caption, media_url, media_type="video",
                       youtube=None, caption_limit=None):
        self.sends.append({
            "channel_id": channel_id,
            "caption": caption,
            "media_url": media_url,
            "youtube": youtube,
            "caption_limit": caption_limit,
        })
        return f"buffer-{len(self.sends)}"

    def update_post(self, post_id, **fields):
        self.stamped.append((post_id, fields.get("platform_post_id")))


def _patch(monkeypatch, rec: _Recorder, *, fail_service: str | None = None):
    monkeypatch.setattr(vb, "insert_post", rec.insert_post)
    monkeypatch.setattr(vb, "update_post", rec.update_post)
    monkeypatch.setattr(vb, "build_proxy_url", lambda pid: f"proxy/{pid}")
    monkeypatch.setattr(vb, "_delete_post", lambda pid: rec.deleted.append(pid))

    def fake_channel(service="tiktok", name=None):
        return f"chan-{service}"

    monkeypatch.setattr(vb, "get_channel_id", fake_channel)

    def fake_send(channel_id, caption, media_url, media_type="video",
                  youtube=None, caption_limit=None):
        if fail_service and channel_id == f"chan-{fail_service}":
            raise RuntimeError(f"{fail_service} boom")
        return rec.send_to_buffer(
            channel_id, caption, media_url, media_type,
            youtube=youtube, caption_limit=caption_limit,
        )

    monkeypatch.setattr(vb, "send_to_buffer", fake_send)


def test_fanout_inserts_three_legs_with_manual_upload_shape(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec)

    result = vb.fanout_video("tiktok/manual/u1/abc.mp4", "A Title", "A caption")

    platforms = [p.platform for p in rec.inserted]
    assert platforms == ["tiktok", "youtube", "x_acq_official"]
    for post in rec.inserted:
        assert post.status == "sent_to_buffer"
        assert post.media_type == "video"
        assert post.media_urls == ["tiktok/manual/u1/abc.mp4"]
        assert post.title == "A Title"
        assert post.caption == "A caption"
        assert post.metadata["source"] == "manual_upload"
        assert post.metadata["storage_cleanup_status"] == "pending"

    assert result["tiktok_buffer_id"] == "buffer-1"
    assert result["youtube_buffer_id"] == "buffer-2"
    assert result["x_buffer_id"] == "buffer-3"


def test_fanout_applies_caption_limits_and_youtube_metadata(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec)

    vb.fanout_video("tiktok/manual/u1/abc.mp4", "My Title", "cap")

    tiktok, youtube, x = rec.sends
    # TikTok uses send_to_buffer's default truncation (no explicit limit).
    assert tiktok["caption_limit"] is None
    assert tiktok["youtube"] is None
    # YouTube gets the title block + 5000 char limit.
    assert youtube["caption_limit"] == vb._YOUTUBE_CAPTION_LIMIT
    assert youtube["youtube"]["title"] == "My Title"
    assert youtube["youtube"]["categoryId"] == "27"
    # X gets the 280 char limit, no youtube block.
    assert x["caption_limit"] == vb._X_CAPTION_LIMIT
    assert x["youtube"] is None


def test_tiktok_failure_raises(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_service="tiktok")
    # TikTok is the primary leg — its failure must propagate so the job fails.
    try:
        vb.fanout_video("tiktok/manual/u1/abc.mp4", "T", "c")
    except RuntimeError as e:
        assert "tiktok boom" in str(e)
    else:
        raise AssertionError("expected TikTok failure to raise")


def test_youtube_failure_is_partial_success(monkeypatch):
    rec = _Recorder()
    _patch(monkeypatch, rec, fail_service="youtube")

    result = vb.fanout_video("tiktok/manual/u1/abc.mp4", "T", "c")

    # TikTok + X still queued; YouTube recorded as an error, its row rolled back.
    assert result["tiktok_buffer_id"]
    assert "youtube_error" in result
    assert "x_buffer_id" in result
    assert "post-2" in rec.deleted  # the youtube leg row was deleted
