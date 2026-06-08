"""Tests for core.caption_rag.pick_caption — the retrieve-then-rerank lookup.

Retrieval (pgvector) is faked via a stub Supabase client; the LLM rerank is
faked via a stub Anthropic client injected through pick_caption(client=...).
No network, deterministic.
"""

from __future__ import annotations

import json
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


class _FakeAnthropic:
    """Stands in for anthropic.Anthropic — returns a fixed rerank index.

    `.messages.create(...)` returns a response shaped like the real SDK's
    (a `content` list of typed blocks). Pass `index` for the chosen candidate,
    or `exc` to simulate the call raising.
    """

    def __init__(self, index=None, exc=None):
        self._index = index
        self._exc = exc
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._exc is not None:
            raise self._exc
        text = json.dumps({"index": self._index})
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


def _patch_retrieval(monkeypatch, data, embedding=None):
    """Patch embed() and get_client() so retrieval returns `data`."""
    monkeypatch.setattr(rag, "embed", lambda text: embedding or [0.1, 0.2, 0.3])
    client = _FakeClient(data)
    monkeypatch.setattr(rag, "get_client", lambda: client)
    return client


_MATCHES = [
    {"tweet_id": "1", "text": "discipline beats motivation", "favorite_count": 10, "similarity": 0.92},
    {"tweet_id": "2", "text": "buy time like a rich person", "favorite_count": 9000, "similarity": 0.88},
    {"tweet_id": "3", "text": "focus is a superpower", "favorite_count": 500, "similarity": 0.90},
]


def test_rerank_picks_the_llm_choice_not_engagement(monkeypatch):
    # The LLM picks candidate #1 (discipline). It must win even though #2 has
    # vastly more likes — meaning, not engagement, drives the choice now.
    _patch_retrieval(monkeypatch, _MATCHES)
    fake_llm = _FakeAnthropic(index=1)
    assert rag.pick_caption("a clip about discipline", client=fake_llm) == "discipline beats motivation"
    # Engagement is hidden from the model: the prompt must not leak favorite_count.
    sent = fake_llm.calls[0]["messages"][0]["content"]
    assert "9000" not in sent
    assert "buy time like a rich person" in sent  # texts ARE shown


def test_rerank_choice_of_third_candidate(monkeypatch):
    _patch_retrieval(monkeypatch, _MATCHES)
    fake_llm = _FakeAnthropic(index=3)
    assert rag.pick_caption("a clip about focus", client=fake_llm) == "focus is a superpower"


def test_falls_back_to_engagement_when_rerank_raises(monkeypatch):
    # Simulate the rerank call failing even after retries: patch the wrapped
    # call to raise directly (no real backoff sleeps). pick_caption should fall
    # back to the highest-engagement neighbour rather than fail.
    _patch_retrieval(monkeypatch, _MATCHES)

    def _boom(client, content):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr(rag, "_create_rerank_message", _boom)
    # #2 has the most likes → wins the fallback.
    assert rag.pick_caption("transcript", client=_FakeAnthropic()) == "buy time like a rich person"


def test_falls_back_when_index_out_of_range(monkeypatch):
    _patch_retrieval(monkeypatch, _MATCHES)
    fake_llm = _FakeAnthropic(index=99)  # nonsense index → unusable → fallback
    assert rag.pick_caption("transcript", client=fake_llm) == "buy time like a rich person"


def test_fallback_handles_null_favorite_count(monkeypatch):
    matches = [
        {"tweet_id": "1", "text": "no likes", "favorite_count": None, "similarity": 0.9},
        {"tweet_id": "2", "text": "some", "favorite_count": 3, "similarity": 0.8},
    ]
    _patch_retrieval(monkeypatch, matches)
    fake_llm = _FakeAnthropic(index=99)  # force fallback
    # None coerces to 0 in the sort, so the tweet with 3 likes wins.
    assert rag.pick_caption("transcript", client=fake_llm) == "some"


def test_over_length_tweet_excluded_from_rerank_prompt(monkeypatch):
    # A tweet over the 1100-char cap must never reach the model: it's dropped
    # before the candidates are numbered, so the rerank judges only short ones.
    long_text = "x" * (rag._MAX_CAPTION_CHARS + 1)
    matches = [
        {"tweet_id": "1", "text": long_text, "favorite_count": 10, "similarity": 0.99},
        {"tweet_id": "2", "text": "short and punchy", "favorite_count": 5, "similarity": 0.80},
    ]
    _patch_retrieval(monkeypatch, matches)
    # After filtering, only the short tweet remains → it is candidate #1.
    fake_llm = _FakeAnthropic(index=1)
    assert rag.pick_caption("transcript", client=fake_llm) == "short and punchy"
    sent = fake_llm.calls[0]["messages"][0]["content"]
    assert long_text not in sent
    assert "short and punchy" in sent


def test_fallback_skips_over_length_tweet(monkeypatch):
    # The over-length tweet has the most likes, but the cap is hard: the
    # engagement fallback must choose the best tweet *within* the cap instead.
    matches = [
        {"tweet_id": "1", "text": "y" * (rag._MAX_CAPTION_CHARS + 1), "favorite_count": 9999, "similarity": 0.99},
        {"tweet_id": "2", "text": "within the cap", "favorite_count": 3, "similarity": 0.70},
    ]
    _patch_retrieval(monkeypatch, matches)
    fake_llm = _FakeAnthropic(index=99)  # nonsense index → force fallback
    assert rag.pick_caption("transcript", client=fake_llm) == "within the cap"


def test_all_over_cap_degrades_instead_of_failing(monkeypatch):
    # If every retrieved tweet exceeds the cap, we keep the full set rather than
    # fail the upload — a long caption beats no caption.
    a = "a" * (rag._MAX_CAPTION_CHARS + 1)
    b = "b" * (rag._MAX_CAPTION_CHARS + 5)
    matches = [
        {"tweet_id": "1", "text": a, "favorite_count": 1, "similarity": 0.9},
        {"tweet_id": "2", "text": b, "favorite_count": 50, "similarity": 0.8},
    ]
    _patch_retrieval(monkeypatch, matches)
    fake_llm = _FakeAnthropic(index=99)  # force fallback over the degraded set
    # Highest-engagement of the full set wins; a caption is still returned.
    assert rag.pick_caption("transcript", client=fake_llm) == b


def test_passes_embedding_and_match_count_to_rpc(monkeypatch):
    client = _patch_retrieval(monkeypatch, _MATCHES, embedding=[0.5] * 4)
    rag.pick_caption("transcript", client=_FakeAnthropic(index=1))
    assert client.last_params["query_embedding"] == [0.5] * 4
    assert client.last_params["match_count"] == rag._TOP_K


def test_empty_transcript_raises(monkeypatch):
    _patch_retrieval(monkeypatch, [])
    with pytest.raises(ValueError, match="empty"):
        rag.pick_caption("   ", client=_FakeAnthropic(index=1))


def test_no_matches_raises(monkeypatch):
    # An empty bank is the one genuinely fatal case (no candidates to caption with).
    _patch_retrieval(monkeypatch, [])
    with pytest.raises(RuntimeError, match="match_tweet_bank"):
        rag.pick_caption("a transcript", client=_FakeAnthropic(index=1))
