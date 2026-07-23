"""Tests for cron.instagram_carousel_pipeline selection logic.

Covers the pure-ish helpers — the day-counter/used-tweet history read and
the 5-tweet outlier selection (Apify-first ordering, bank top-up, the three
dedup gates). The render/send phases are exercised end-to-end via
`CAROUSEL_DRY_RUN=1 python -m cron.instagram_carousel_pipeline` against a
live dashboard; here we patch the module's imported dependencies so nothing
external is touched.
"""

from __future__ import annotations

import cron.instagram_carousel_pipeline as pipeline


# ── fakes ────────────────────────────────────────────────────────────────


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Chainable stand-in for the posts-table select the history read does."""

    def __init__(self, data):
        self._data = data

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        return _FakeResult(self._data)


class _FakeClient:
    def __init__(self, data):
        self._data = data

    def table(self, _name):
        return _FakeQuery(self._data)


def _carousel_row(status, tweet_ids):
    return {
        "status": status,
        "metadata": {"source": "carousel", "tweet_ids": tweet_ids},
    }


# ── _fetch_carousel_history ──────────────────────────────────────────────


def test_history_counts_live_rows_and_unions_tweet_ids(monkeypatch):
    rows = [
        _carousel_row("published", ["1", "2"]),
        _carousel_row("sent_to_buffer", ["3"]),
        # Failed rows advance nothing and release their tweets.
        _carousel_row("buffer_error", ["4", "5"]),
    ]
    monkeypatch.setattr(pipeline, "get_client", lambda: _FakeClient(rows))

    day, used = pipeline._fetch_carousel_history()

    assert day == 3  # 2 live rows -> next is Day 3
    assert used == {"1", "2", "3"}  # buffer_error tweets stay available


def test_history_empty_starts_at_day_one(monkeypatch):
    monkeypatch.setattr(pipeline, "get_client", lambda: _FakeClient([]))
    day, used = pipeline._fetch_carousel_history()
    assert day == 1
    assert used == set()


# ── _pick_carousel_tweets ────────────────────────────────────────────────


def _pick(monkeypatch, *, apify, bank, used_ids=frozenset(), used_captions=frozenset(), count=5):
    monkeypatch.setattr(pipeline, "fetch_apify_tweets", lambda *a, **k: apify)
    monkeypatch.setattr(
        pipeline, "select_bank_content_with_likes", lambda *a, **k: bank
    )
    monkeypatch.setattr(
        pipeline,
        "post_caption_exists",
        lambda platform, caption: (platform, caption) in used_captions,
    )
    return pipeline._pick_carousel_tweets(
        twitter_handle="AlexHormozi",
        bank_path="data/TweetMasterBank.csv",
        min_likes=6500,
        count=count,
        max_items=15,
        used_tweet_ids=set(used_ids),
    )


def _apify(tweet_id, text, likes=7000):
    return {"id": tweet_id, "text": text, "like_count": likes}


def _bank(tweet_id, text, likes=7000):
    return {"tweet_id": tweet_id, "text": text, "favorite_count": likes}


def test_pick_prefers_apify_then_tops_up_from_bank(monkeypatch):
    picked = _pick(
        monkeypatch,
        apify=[_apify("a1", "Recent one."), _apify("a2", "Recent two.")],
        bank=[_bank("b1", "Bank one."), _bank("b2", "Bank two."), _bank("b3", "Bank three.")],
    )
    assert [t["tweet_id"] for t in picked] == ["a1", "a2", "b1", "b2", "b3"]
    assert [t["source"] for t in picked] == ["outlier"] * 2 + ["bank"] * 3


def test_pick_stops_at_count_without_touching_bank(monkeypatch):
    apify = [_apify(f"a{i}", f"Recent tweet number {i}.") for i in range(8)]
    picked = _pick(monkeypatch, apify=apify, bank=[_bank("b1", "Bank one.")])
    assert len(picked) == 5
    assert all(t["source"] == "outlier" for t in picked)


def test_pick_applies_all_three_dedup_gates(monkeypatch):
    picked = _pick(
        monkeypatch,
        apify=[
            _apify("used-id", "Fine text, used id."),
            _apify("a2", "Already posted text."),
            _apify("a3", "Ship daily."),
            # Fingerprint-duplicate of a3 within the same run.
            _apify("a4", "SHIP DAILY!!"),
            _apify("a5", "Fresh and unused."),
        ],
        bank=[],
        used_ids={"used-id"},
        used_captions={("instagram", "Already posted text.")},
        count=5,
    )
    assert [t["tweet_id"] for t in picked] == ["a3", "a5"]


def test_pick_returns_short_set_when_exhausted(monkeypatch):
    # Caller (main) treats < count as "skip the run" — the helper just
    # reports what it found.
    picked = _pick(monkeypatch, apify=[], bank=[_bank("b1", "Bank one.")])
    assert len(picked) == 1


# ── misc ─────────────────────────────────────────────────────────────────


def test_text_fingerprint_collapses_formatting():
    assert pipeline._text_fingerprint("Ship DAILY!") == pipeline._text_fingerprint("ship daily")
    assert pipeline._text_fingerprint("a") != pipeline._text_fingerprint("b")


def test_title_template_formats_day():
    assert pipeline.DEFAULT_TITLE_TEMPLATE.format(day=7) == (
        "Brutally honest advice to my younger self (Day 7)"
    )
