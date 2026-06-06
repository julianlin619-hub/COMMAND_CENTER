"""Tests for the core.buffer additions used by the batch-video fan-out:
YouTube metadata + caption_limit on send_to_buffer, and the name-scoped
channel lookup in get_channel_id.
"""

from __future__ import annotations

import pytest

import core.buffer as buffer


@pytest.fixture(autouse=True)
def _clear_channel_cache():
    """get_channel_id caches per process — reset between tests."""
    buffer._cached_channel_ids.clear()
    yield
    buffer._cached_channel_ids.clear()


def _capture_request(monkeypatch) -> dict:
    """Patch _buffer_request to capture variables and return a success post."""
    captured: dict = {}

    def fake_req(query, variables=None):
        captured["query"] = query
        captured["variables"] = variables
        return {"createPost": {"post": {"id": "b1"}}}

    monkeypatch.setattr(buffer, "_buffer_request", fake_req)
    return captured


# ── send_to_buffer: YouTube metadata + caption_limit ─────────────────────


def test_youtube_metadata_nested_and_tags_dropped(monkeypatch):
    captured = _capture_request(monkeypatch)
    pid = buffer.send_to_buffer(
        "chan", "a caption", "https://proxy/1", "video",
        youtube={"title": "My Title", "categoryId": "27", "tags": []},
        caption_limit=5000,
    )
    assert pid == "b1"
    yt = captured["variables"]["input"]["metadata"]["youtube"]
    assert yt["title"] == "My Title"
    assert yt["categoryId"] == "27"
    # Empty tags list is dropped — some publishers reject tags: [].
    assert "tags" not in yt


def test_youtube_tags_kept_when_present(monkeypatch):
    captured = _capture_request(monkeypatch)
    buffer.send_to_buffer(
        "chan", "cap", "https://proxy/1", "video",
        youtube={"title": "T", "tags": ["a", "b"]},
    )
    assert captured["variables"]["input"]["metadata"]["youtube"]["tags"] == ["a", "b"]


def test_caption_limit_truncates(monkeypatch):
    captured = _capture_request(monkeypatch)
    long_caption = "x" * 500
    buffer.send_to_buffer(
        "chan", long_caption, "https://proxy/1", "video", caption_limit=10,
    )
    text = captured["variables"]["input"]["text"]
    assert len(text) <= 10


def test_no_metadata_key_when_plain_video(monkeypatch):
    captured = _capture_request(monkeypatch)
    buffer.send_to_buffer("chan", "cap", "https://proxy/1", "video", caption_limit=280)
    assert "metadata" not in captured["variables"]["input"]


# ── get_channel_id: name disambiguation ──────────────────────────────────


def test_get_channel_id_filters_by_name(monkeypatch):
    monkeypatch.setenv("BUFFER_ORG_ID", "org1")
    monkeypatch.setattr(
        buffer,
        "_buffer_request",
        lambda *a, **k: {
            "channels": [
                {"id": "stale", "service": "twitter", "name": "legacy_twitter"},
                {"id": "live", "service": "twitter", "name": "acq_official"},
            ]
        },
    )
    cid = buffer.get_channel_id(service="twitter", name="acq_official")
    assert cid == "live"


def test_get_channel_id_name_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("BUFFER_ORG_ID", "org1")
    monkeypatch.setattr(
        buffer,
        "_buffer_request",
        lambda *a, **k: {
            "channels": [{"id": "live", "service": "twitter", "name": "Acq_Official"}]
        },
    )
    assert buffer.get_channel_id(service="twitter", name="acq_official") == "live"


def test_get_channel_id_raises_when_name_absent(monkeypatch):
    monkeypatch.setenv("BUFFER_ORG_ID", "org1")
    monkeypatch.setattr(
        buffer,
        "_buffer_request",
        lambda *a, **k: {
            "channels": [{"id": "x", "service": "twitter", "name": "other"}]
        },
    )
    with pytest.raises(RuntimeError, match="acq_official"):
        buffer.get_channel_id(service="twitter", name="acq_official")


def test_name_and_plain_lookups_cache_separately(monkeypatch):
    monkeypatch.setenv("BUFFER_ORG_ID", "org1")
    calls = {"n": 0}

    def fake_req(*a, **k):
        calls["n"] += 1
        return {
            "channels": [
                {"id": "first", "service": "twitter", "name": "other"},
                {"id": "live", "service": "twitter", "name": "acq_official"},
            ]
        }

    monkeypatch.setattr(buffer, "_buffer_request", fake_req)
    # Plain service lookup wins the first channel; name lookup wins the named one.
    assert buffer.get_channel_id(service="twitter") == "first"
    assert buffer.get_channel_id(service="twitter", name="acq_official") == "live"
    # Two distinct cache keys → two API calls (not one clobbering the other).
    assert calls["n"] == 2
