"""Tests for core.scheduler.process_due_posts.

Focus: the Buffer-handoff deferral added so the scheduler path (Threads) is
covered by cron.buffer_reconcile. A `publishes_via_buffer=True` adapter must
leave the post in 'sent_to_buffer' (awaiting confirmation) with its replay
payload, while a normal adapter still marks 'published' immediately.

Pure-logic: we patch the DB functions process_due_posts imports, so nothing
external is touched.
"""

from __future__ import annotations

import core.scheduler as scheduler


class _FakeClient:
    def __init__(self, *, publishes_via_buffer, replay=None):
        self.publishes_via_buffer = publishes_via_buffer
        self._replay = replay

    def create_post(self, post):
        return "buf123"

    def buffer_replay(self, post):
        return self._replay


def _patch(monkeypatch, post_row):
    monkeypatch.setattr(
        scheduler, "get_due_schedules",
        lambda platform: [{"id": "s1", "posts": post_row}],
    )
    monkeypatch.setattr(scheduler, "mark_schedule_picked_up", lambda sid: True)
    monkeypatch.setattr(scheduler.time, "sleep", lambda s: None)

    updates: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        scheduler, "update_post",
        lambda post_id, **fields: updates.append((post_id, fields)),
    )
    return updates


def test_buffer_backed_adapter_defers_to_sent_to_buffer(monkeypatch):
    post_row = {"id": "p1", "platform": "threads", "status": "scheduled",
                "caption": "hi", "metadata": {"source": "bank"}}
    updates = _patch(monkeypatch, post_row)
    client = _FakeClient(publishes_via_buffer=True, replay={"channel_id": "ch9"})

    processed = scheduler.process_due_posts(client, "threads")

    assert processed == 1
    # First update marks 'publishing'; the final one is the handoff.
    _, final = updates[-1]
    assert final["status"] == "sent_to_buffer"
    assert final["platform_post_id"] == "buf123"
    assert "published_at" not in final  # not live yet
    # Replay payload is merged into the row's existing metadata.
    assert final["metadata"]["source"] == "bank"
    assert final["metadata"]["buffer_replay"] == {"channel_id": "ch9"}


def test_normal_adapter_marks_published(monkeypatch):
    post_row = {"id": "p1", "platform": "snapchat", "status": "scheduled", "caption": "hi"}
    updates = _patch(monkeypatch, post_row)
    client = _FakeClient(publishes_via_buffer=False)

    processed = scheduler.process_due_posts(client, "snapchat")

    assert processed == 1
    _, final = updates[-1]
    assert final["status"] == "published"
    assert final["platform_post_id"] == "buf123"
    assert "published_at" in final  # live immediately
