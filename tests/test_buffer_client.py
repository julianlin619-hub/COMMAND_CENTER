"""Tests for core.buffer rate-limit handling and post-state parsing.

Pure-logic tests with a hand-built fake of httpx.post — we never hit Buffer.
Covers:
  - _graphql_rate_limited: detecting RATE_LIMIT_EXCEEDED (the new API's HTTP-200
    rate-limit shape) and parsing the wait hint;
  - _buffer_request: retrying a GraphQL-level rate limit then succeeding, and
    giving up when the wait hint exceeds the backoff cap;
  - get_buffer_post_state: parsing sentAt/status into the reconcile cron's dict.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

import core.buffer as buffer


class _FakeResponse:
    """Minimal stand-in for httpx.Response for the fields _buffer_request reads."""

    def __init__(self, *, status_code=200, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {"data": {}}
        self.headers = headers or {}
        self.reason_phrase = "OK"
        self.text = ""

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> dict:
        return self._body


def _install_token(monkeypatch):
    monkeypatch.setenv("BUFFER_ACCESS_TOKEN", "test-token")


# ── _graphql_rate_limited ────────────────────────────────────────────────


def test_graphql_rate_limited_detects_code_and_hint():
    errors = [{"message": "slow down", "extensions": {"code": "RATE_LIMIT_EXCEEDED", "retryAfter": 12}}]
    limited, wait = buffer._graphql_rate_limited(errors)
    assert limited is True
    assert wait == 12.0


def test_graphql_rate_limited_matches_message_substring_with_default_wait():
    errors = [{"message": "API rate limit reached"}]
    limited, wait = buffer._graphql_rate_limited(errors)
    assert limited is True
    assert wait == buffer._DEFAULT_BACKOFF_SECONDS


def test_graphql_rate_limited_ignores_other_errors():
    errors = [{"message": "Field 'foo' not found", "extensions": {"code": "GRAPHQL_VALIDATION_FAILED"}}]
    limited, _ = buffer._graphql_rate_limited(errors)
    assert limited is False


# ── _buffer_request retry behavior ───────────────────────────────────────


def test_buffer_request_retries_graphql_rate_limit_then_succeeds(monkeypatch):
    _install_token(monkeypatch)
    rate_limited = _FakeResponse(
        body={"errors": [{"message": "rate limited", "extensions": {"code": "RATE_LIMIT_EXCEEDED", "retryAfter": 1}}]}
    )
    ok = _FakeResponse(body={"data": {"ok": 1}})
    responses = iter([rate_limited, ok])

    monkeypatch.setattr(buffer.httpx, "post", lambda *a, **k: next(responses))
    sleeps: list[float] = []
    monkeypatch.setattr(buffer.time, "sleep", lambda s: sleeps.append(s))

    data = buffer._buffer_request("query {}", {})

    assert data == {"ok": 1}
    assert sleeps == [1.0]  # honored the retryAfter hint exactly once


def test_buffer_request_gives_up_when_wait_exceeds_cap(monkeypatch):
    _install_token(monkeypatch)
    # Wait hint is larger than the backoff cap → don't sleep, raise immediately
    # so the post is left for the next run instead of stalling the cron.
    huge = buffer._MAX_BACKOFF_SECONDS + 100
    rate_limited = _FakeResponse(
        body={"errors": [{"message": "rate limited", "extensions": {"code": "RATE_LIMIT_EXCEEDED", "retryAfter": huge}}]}
    )
    monkeypatch.setattr(buffer.httpx, "post", lambda *a, **k: rate_limited)
    slept = []
    monkeypatch.setattr(buffer.time, "sleep", lambda s: slept.append(s))

    with pytest.raises(RuntimeError, match="rate limit"):
        buffer._buffer_request("query {}", {})
    assert slept == []  # never waited a too-long cooldown inside the cron


def test_buffer_request_raises_on_401(monkeypatch):
    _install_token(monkeypatch)
    monkeypatch.setattr(buffer.httpx, "post", lambda *a, **k: _FakeResponse(status_code=401))
    with pytest.raises(RuntimeError, match="invalid or expired"):
        buffer._buffer_request("query {}", {})


# ── get_buffer_post_state ────────────────────────────────────────────────


def test_get_buffer_post_state_published(monkeypatch):
    monkeypatch.setattr(
        buffer,
        "_buffer_request",
        lambda *a, **k: {"post": {"id": "p1", "sentAt": "2026-05-30T18:00:00Z", "status": "sent"}},
    )
    state = buffer.get_buffer_post_state("p1")
    assert state["status"] == "sent"
    assert state["sentAt"] == datetime(2026, 5, 30, 18, 0, tzinfo=timezone.utc)


def test_get_buffer_post_state_still_queued(monkeypatch):
    monkeypatch.setattr(
        buffer,
        "_buffer_request",
        lambda *a, **k: {"post": {"id": "p1", "sentAt": None, "status": "buffer"}},
    )
    state = buffer.get_buffer_post_state("p1")
    assert state == {"status": "buffer", "sentAt": None}


def test_get_buffer_post_state_unknown_post(monkeypatch):
    monkeypatch.setattr(buffer, "_buffer_request", lambda *a, **k: {"post": None})
    assert buffer.get_buffer_post_state("nope") is None


# ── send_to_buffer asset shapes (single vs carousel) ─────────────────────


def _capture_create_post(monkeypatch):
    """Stub _buffer_request to capture the CreatePost input and succeed."""
    captured: dict = {}

    def fake_request(query, variables=None):
        captured.update((variables or {}).get("input", {}))
        return {"createPost": {"post": {"id": "bp1"}}}

    monkeypatch.setattr(buffer, "_buffer_request", fake_request)
    return captured


def test_send_to_buffer_single_url_unchanged(monkeypatch):
    captured = _capture_create_post(monkeypatch)
    post_id = buffer.send_to_buffer("ch1", "hello", "https://x/img.png", media_type="image")
    assert post_id == "bp1"
    assert captured["assets"] == [{"image": {"url": "https://x/img.png"}}]


def test_send_to_buffer_url_list_builds_carousel_assets(monkeypatch):
    captured = _capture_create_post(monkeypatch)
    urls = [f"https://x/img{i}.png" for i in range(3)]
    buffer.send_to_buffer(
        "ch1", "", urls, media_type="image", instagram_post_type="post",
    )
    # One image asset per URL, in order — this is what Buffer's IG
    # integration publishes as a carousel.
    assert captured["assets"] == [{"image": {"url": u}} for u in urls]
    assert captured["metadata"]["instagram"] == {
        "type": "post",
        "shouldShareToFeed": True,
    }


def test_send_to_buffer_empty_url_list_raises(monkeypatch):
    _capture_create_post(monkeypatch)
    with pytest.raises(ValueError, match="at least one media URL"):
        buffer.send_to_buffer("ch1", "", [], media_type="image")


def test_send_to_buffer_pinterest_metadata_and_caption_limit(monkeypatch):
    captured = _capture_create_post(monkeypatch)
    long_caption = "x" * 300  # over the default 150 limit, under Pinterest's 500
    buffer.send_to_buffer(
        "ch1", long_caption, "https://x/img.png",
        media_type="image",
        pinterest={"boardServiceId": "113659609"},
        caption_limit=500,
    )
    # The board block is passed through under metadata.pinterest, and the
    # raised caption_limit keeps the full text (no 150-char truncation).
    assert captured["metadata"]["pinterest"] == {"boardServiceId": "113659609"}
    assert captured["text"] == long_caption


# ── get_pinterest_board_service_id ───────────────────────────────────────


def _install_board_channels(monkeypatch, channels):
    """Stub _buffer_request with a fixed channels payload and clear the cache."""
    monkeypatch.setenv("BUFFER_ORG_ID", "org1")
    monkeypatch.setattr(buffer, "_cached_pinterest_board_ids", {})
    monkeypatch.setattr(
        buffer, "_buffer_request", lambda query, variables=None: {"channels": channels}
    )


def test_get_pinterest_board_service_id_matches_case_insensitively(monkeypatch):
    _install_board_channels(monkeypatch, [
        {"service": "facebook", "metadata": {}},
        {"service": "pinterest", "metadata": {"boards": [
            {"id": "b1", "name": "Business Tactics", "serviceId": "111"},
            {"id": "b2", "name": "Life quotes", "serviceId": "222"},
        ]}},
    ])
    assert buffer.get_pinterest_board_service_id("business tactics") == "111"


def test_get_pinterest_board_service_id_unknown_board_lists_available(monkeypatch):
    _install_board_channels(monkeypatch, [
        {"service": "pinterest", "metadata": {"boards": [
            {"id": "b1", "name": "Business Tactics", "serviceId": "111"},
        ]}},
    ])
    with pytest.raises(RuntimeError, match="Business Tactics"):
        buffer.get_pinterest_board_service_id("Nope")


def test_get_pinterest_board_service_id_no_channel_raises(monkeypatch):
    _install_board_channels(monkeypatch, [{"service": "facebook", "metadata": {}}])
    with pytest.raises(RuntimeError, match="No pinterest channel"):
        buffer.get_pinterest_board_service_id("Business Tactics")
