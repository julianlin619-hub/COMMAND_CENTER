"""Tests for core.database.record_buffer_handoff.

Verifies it stamps platform_post_id and merges a buffer_replay block into the
row's base metadata (update_post sets the jsonb column wholesale, so the merge
must happen here). We patch update_post so no DB is touched.
"""

from __future__ import annotations

import core.database as db


def test_record_buffer_handoff_merges_replay_and_omits_empty_post_types(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(
        db, "update_post",
        lambda post_id, **fields: captured.update({"post_id": post_id, **fields}),
    )

    db.record_buffer_handoff(
        "p1", "buf1",
        channel_id="ch1",
        body="Agree?",
        media_type="video",
        base_metadata={"source": "outlier"},
    )

    assert captured["post_id"] == "p1"
    assert captured["platform_post_id"] == "buf1"
    md = captured["metadata"]
    assert md["source"] == "outlier"  # base metadata preserved
    assert md["buffer_replay"] == {
        "channel_id": "ch1", "body": "Agree?", "media_type": "video",
    }
    # Unset post-type hints are omitted, not stored as None.
    assert "facebook_post_type" not in md["buffer_replay"]
    assert "instagram_post_type" not in md["buffer_replay"]


def test_record_buffer_handoff_carries_post_types_and_defaults_metadata(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(
        db, "update_post",
        lambda post_id, **fields: captured.update({"post_id": post_id, **fields}),
    )

    db.record_buffer_handoff(
        "p2", "buf2",
        channel_id="ig1",
        body="Agree?",
        media_type="image",
        instagram_post_type="post",
    )

    md = captured["metadata"]
    # No base_metadata → metadata is just the replay block.
    assert set(md.keys()) == {"buffer_replay"}
    assert md["buffer_replay"]["instagram_post_type"] == "post"
