"""Tests for the video_batch_jobs claim in core.database.

claim_video_batch_job must be atomic on the 'pending' status: the first claim
wins (returns True, flips to 'processing'); a second claim — a double-click or
a retry racing a still-running processor — must lose (returns False) so we
can't double-process and thus can't double-post to Buffer.

Uses a tiny in-memory fake of the Supabase query builder covering only the
chained calls claim_video_batch_job touches: select/update + eq + limit.
"""

from __future__ import annotations

from types import SimpleNamespace

import core.database as db


class _FakeQuery:
    def __init__(self, store: dict):
        self._store = store
        self._op = None
        self._update: dict = {}
        self._filters: list[tuple[str, object]] = []

    def select(self, *_a):
        self._op = "select"
        return self

    def update(self, fields):
        self._op = "update"
        self._update = fields
        return self

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def limit(self, _n):
        return self

    def _matches(self) -> list[dict]:
        rows = list(self._store.values())
        for col, val in self._filters:
            rows = [r for r in rows if r.get(col) == val]
        return rows

    def execute(self):
        rows = self._matches()
        if self._op == "update":
            for r in rows:
                r.update(self._update)
        return SimpleNamespace(data=rows)


class _FakeClient:
    def __init__(self, store: dict):
        self._store = store

    def table(self, _name):
        # A fresh query builder per call, sharing the row store — mirrors how
        # the real client returns a new builder each .table() call.
        return _FakeQuery(self._store)


def _install(monkeypatch, rows: dict):
    monkeypatch.setattr(db, "get_client", lambda: _FakeClient(rows))


def test_first_claim_wins_second_loses(monkeypatch):
    rows = {"job1": {"id": "job1", "status": "pending", "attempts": 0}}
    _install(monkeypatch, rows)

    assert db.claim_video_batch_job("job1") is True
    assert rows["job1"]["status"] == "processing"
    assert rows["job1"]["attempts"] == 1

    # Second claim: status is no longer 'pending', so the guarded update
    # matches no rows and the claim loses.
    assert db.claim_video_batch_job("job1") is False
    # attempts must not have been bumped by the losing claim.
    assert rows["job1"]["attempts"] == 1


def test_claim_missing_job_returns_false(monkeypatch):
    _install(monkeypatch, {})
    assert db.claim_video_batch_job("nope") is False
