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
