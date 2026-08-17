"""Tests for cron.instagram_carousel_pipeline selection logic.

Covers the pure-ish helpers — the day-counter/used-tweet history read, the
bank-only carousel selection (dedup gates + likes-descending slide order),
and the solo-breakout filter (retweet/reply/dedup gates). The render/send
phases are exercised end-to-end via
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


def _pick(monkeypatch, *, bank, used_ids=frozenset(), used_captions=frozenset(), count=5):
    monkeypatch.setattr(
        pipeline, "select_bank_content_with_likes", lambda *a, **k: bank
    )
    monkeypatch.setattr(
        pipeline,
        "post_caption_exists",
        lambda platform, caption: (platform, caption) in used_captions,
    )
    return pipeline._pick_carousel_tweets(
        bank_path="data/TweetMasterBank.csv",
        min_likes=6500,
        count=count,
        used_tweet_ids=set(used_ids),
    )


def _apify(tweet_id, text, likes=7000):
    return {"id": tweet_id, "text": text, "like_count": likes}


def _bank(tweet_id, text, likes=7000):
    return {"tweet_id": tweet_id, "text": text, "favorite_count": likes}


def test_pick_is_bank_only_and_stops_at_count(monkeypatch):
    bank = [_bank(f"b{i}", f"Bank tweet number {i}.") for i in range(8)]
    picked = _pick(monkeypatch, bank=bank)
    assert len(picked) == 5
    assert all(t["source"] == "bank" for t in picked)


def test_pick_applies_all_three_dedup_gates(monkeypatch):
    picked = _pick(
        monkeypatch,
        bank=[
            _bank("used-id", "Fine text, used id."),
            _bank("b2", "Already posted text."),
            _bank("b3", "Ship daily."),
            # Fingerprint-duplicate of b3 within the same run.
            _bank("b4", "SHIP DAILY!!"),
            _bank("b5", "Fresh and unused."),
        ],
        used_ids={"used-id"},
        used_captions={("instagram", "Already posted text.")},
        count=5,
    )
    assert [t["tweet_id"] for t in picked] == ["b3", "b5"]


def test_pick_ranks_slides_by_likes_descending(monkeypatch):
    # The returned order IS the slide order: most-liked first, whatever
    # order the bank sampler returned the candidates in.
    picked = _pick(
        monkeypatch,
        bank=[
            _bank("b1", "Bank one.", likes=8000),
            _bank("b2", "Bank two.", likes=20000),
            _bank("b3", "Bank three.", likes=9000),
        ],
    )
    assert [t["tweet_id"] for t in picked] == ["b2", "b3", "b1"]
    assert [t["favorite_count"] for t in picked] == [20000, 9000, 8000]


def test_pick_returns_short_set_when_exhausted(monkeypatch):
    # Caller (main) treats < count as "skip the run" — the helper just
    # reports what it found.
    picked = _pick(monkeypatch, bank=[_bank("b1", "Bank one.")])
    assert len(picked) == 1


# ── _pick_solo_breakouts ─────────────────────────────────────────────────


def _solo(monkeypatch, tweets, *, used_ids=frozenset(), used_captions=frozenset()):
    monkeypatch.setattr(
        pipeline,
        "post_caption_exists",
        lambda platform, caption: (platform, caption) in used_captions,
    )
    return pipeline._pick_solo_breakouts(tweets, set(used_ids))


def test_solo_skips_retweets_and_replies(monkeypatch):
    picked = _solo(
        monkeypatch,
        [
            _apify("s1", "RT @someone: not our content."),
            _apify("s2", "@someone replying to a thread."),
            _apify("s3", "A genuine breakout tweet."),
        ],
    )
    assert [t["tweet_id"] for t in picked] == ["s3"]


def test_solo_applies_dedup_gates(monkeypatch):
    picked = _solo(
        monkeypatch,
        [
            # On a previous carousel (pre-2026-08-17 the Apify pathway
            # shipped recent tweets as slides).
            _apify("used-id", "Fine text, used id."),
            # Already a solo post / carousel slide-1 caption.
            _apify("s2", "Already posted text."),
            _apify("s3", "Ship daily."),
            # Fingerprint-duplicate within the same run.
            _apify("s4", "SHIP DAILY!!"),
        ],
        used_ids={"used-id"},
        used_captions={("instagram", "Already posted text.")},
    )
    assert [t["tweet_id"] for t in picked] == ["s3"]


def test_solo_keeps_newest_first_order_and_likes(monkeypatch):
    picked = _solo(
        monkeypatch,
        [_apify("s1", "Newest.", likes=9000), _apify("s2", "Older.", likes=15000)],
    )
    # No re-ranking: each breakout is its own post, so Apify's
    # newest-first order is simply preserved.
    assert [t["tweet_id"] for t in picked] == ["s1", "s2"]
    assert [t["favorite_count"] for t in picked] == [9000, 15000]


# ── misc ─────────────────────────────────────────────────────────────────


def test_text_fingerprint_collapses_formatting():
    assert pipeline._text_fingerprint("Ship DAILY!") == pipeline._text_fingerprint("ship daily")
    assert pipeline._text_fingerprint("a") != pipeline._text_fingerprint("b")


def test_series_label_is_unique_per_day():
    # The label is the TikTok mirror row's dedup caption — per-day
    # uniqueness is what the (platform, md5(caption)) index keys on.
    assert pipeline._series_label(7) != pipeline._series_label(8)
    assert "7" in pipeline._series_label(7)
