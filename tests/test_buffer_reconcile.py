"""Tests for cron.buffer_reconcile.

Covers the failure-status classifier and the main() reconcile loop, which
resolves each unconfirmed Buffer handoff to published / buffer_error / queued.
We patch the module's imported dependencies (Buffer + DB) so nothing external
is touched; the real integration is exercised via
`python -m cron.buffer_reconcile`.
"""

from __future__ import annotations

from datetime import datetime, timezone

import cron.buffer_reconcile as reconcile


def test_is_failure_status():
    assert reconcile._is_failure_status("error") is True
    assert reconcile._is_failure_status("FAILED") is True
    assert reconcile._is_failure_status("publish_error") is True
    # Non-failure / queued / published statuses must not match.
    assert reconcile._is_failure_status("sent") is False
    assert reconcile._is_failure_status("buffer") is False
    assert reconcile._is_failure_status("draft") is False
    assert reconcile._is_failure_status(None) is False


def _patch_common(monkeypatch, posts, states):
    """Wire up the module's deps. `states` maps buffer_post_id -> state dict."""
    monkeypatch.setattr(reconcile, "log_env_diagnostics", lambda *a, **k: None)
    monkeypatch.setattr(reconcile, "log_cron_start", lambda *a, **k: "run-1")
    finished: dict = {}
    monkeypatch.setattr(
        reconcile, "log_cron_finish",
        lambda run_id, **k: finished.update(k),
    )
    monkeypatch.setattr(reconcile, "get_posts_awaiting_buffer_confirmation", lambda: posts)
    monkeypatch.setattr(reconcile, "get_buffer_post_state", lambda bid: states.get(bid))

    updates: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        reconcile, "update_post",
        lambda post_id, **fields: updates.append((post_id, fields)),
    )
    return finished, updates


def test_main_resolves_published_failed_and_queued(monkeypatch):
    sent_at = datetime(2026, 5, 30, 18, 0, tzinfo=timezone.utc)
    posts = [
        {"id": "a", "platform": "linkedin", "platform_post_id": "ba"},  # published
        {"id": "b", "platform": "facebook", "platform_post_id": "bb"},  # failed
        {"id": "c", "platform": "instagram", "platform_post_id": "bc"},  # queued
        {"id": "d", "platform": "tiktok", "platform_post_id": "bd"},     # no record
    ]
    states = {
        "ba": {"status": "sent", "sentAt": sent_at},
        "bb": {"status": "error", "sentAt": None},
        "bc": {"status": "buffer", "sentAt": None},
        "bd": None,
    }
    finished, updates = _patch_common(monkeypatch, posts, states)

    reconcile.main()

    by_id = dict(updates)
    # Published row mirrors Buffer's sentAt.
    assert by_id["a"]["status"] == "published"
    assert by_id["a"]["published_at"] == sent_at.isoformat()
    # Failed row surfaces a buffer_error with the Buffer status in the reason.
    assert by_id["b"]["status"] == "buffer_error"
    assert "error" in by_id["b"]["error_message"]
    # Queued and no-record rows are left untouched.
    assert "c" not in by_id
    assert "d" not in by_id
    # Run succeeds; 2 posts resolved (1 published + 1 failed).
    assert finished["status"] == "success"
    assert finished["posts_processed"] == 2


def test_main_isolates_per_post_errors(monkeypatch):
    posts = [
        {"id": "a", "platform": "linkedin", "platform_post_id": "ba"},
        {"id": "b", "platform": "facebook", "platform_post_id": "bb"},
    ]
    sent_at = datetime(2026, 5, 30, 18, 0, tzinfo=timezone.utc)
    states = {"ba": {"status": "sent", "sentAt": sent_at}, "bb": {"status": "sent", "sentAt": sent_at}}
    finished, updates = _patch_common(monkeypatch, posts, states)

    # First update_post raises; the loop must continue and still process "b".
    calls: list[str] = []

    def flaky_update(post_id, **fields):
        calls.append(post_id)
        if post_id == "a":
            raise RuntimeError("transient DB blip")

    monkeypatch.setattr(reconcile, "update_post", flaky_update)

    reconcile.main()

    assert calls == ["a", "b"]  # b was still attempted after a failed
    assert finished["status"] == "failed"  # one error → run marked failed
