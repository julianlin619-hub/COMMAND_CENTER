"""Tests for core.caption_rag.pick_caption — the tweet-bank RAG lookup."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import core.caption_rag as rag


class _FakeClient:
    """Stands in for the Supabase client's rpc(...).execute() call."""

    def __init__(self, data):
        self._data = data
        self.last_params = None

    def rpc(self, name, params):
        self.last_params = params
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self._data))


def _patch(monkeypatch, data, embedding=None):
    monkeypatch.setattr(rag, "embed", lambda text: embedding or [0.1, 0.2, 0.3])
    client = _FakeClient(data)
    monkeypatch.setattr(rag, "get_client", lambda: client)
    return client


def test_picks_highest_engagement_among_neighbours(monkeypatch):
    # All three are on-sentiment neighbours; the strongest (most likes) wins.
    matches = [
        {"tweet_id": "1", "text": "low", "favorite_count": 10, "similarity": 0.92},
        {"tweet_id": "2", "text": "best", "favorite_count": 9000, "similarity": 0.88},
        {"tweet_id": "3", "text": "mid", "favorite_count": 500, "similarity": 0.90},
    ]
    _patch(monkeypatch, matches)
    assert rag.pick_caption("a transcript about hustle") == "best"


def test_handles_null_favorite_count(monkeypatch):
    matches = [
        {"tweet_id": "1", "text": "no likes", "favorite_count": None, "similarity": 0.9},
        {"tweet_id": "2", "text": "some", "favorite_count": 3, "similarity": 0.8},
    ]
    _patch(monkeypatch, matches)
    # None coerces to 0 in the sort, so the tweet with 3 likes wins.
    assert rag.pick_caption("transcript") == "some"


def test_passes_embedding_and_match_count_to_rpc(monkeypatch):
    matches = [{"tweet_id": "1", "text": "t", "favorite_count": 1, "similarity": 0.9}]
    client = _patch(monkeypatch, matches, embedding=[0.5] * 4)
    rag.pick_caption("transcript")
    assert client.last_params["query_embedding"] == [0.5] * 4
    assert client.last_params["match_count"] == rag._TOP_K


def test_empty_transcript_raises(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(ValueError, match="empty"):
        rag.pick_caption("   ")


def test_no_matches_raises(monkeypatch):
    _patch(monkeypatch, [])
    with pytest.raises(RuntimeError, match="match_tweet_bank"):
        rag.pick_caption("a transcript")
