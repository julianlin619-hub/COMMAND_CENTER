"""Tests for cron.instagram_solo_pipeline — the every-second-day 6pm IG post.

Covers the pure helpers: the 6pm-Pacific / 2-day-grid due-time computation, the
fresh-breakout filter (retweet/reply/dedup gates), and the fresh-first /
bank-fallback choice of the ONE tweet that ships each day. The render/send
phase is exercised end-to-end via
`SOLO_DRY_RUN=1 python -m cron.instagram_solo_pipeline` against a live
dashboard; here we patch the module's imported dependencies so nothing
external is touched.
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import cron.instagram_solo_pipeline as solo


PACIFIC = ZoneInfo("America/Los_Angeles")


def _apify(tweet_id, text, likes=7000):
    return {"id": tweet_id, "text": text, "like_count": likes}


def _bank(tweet_id, text, likes=7000):
    return {"tweet_id": tweet_id, "text": text, "favorite_count": likes}


# ── _next_post_time ──────────────────────────────────────────────────────


def test_next_post_time_is_6pm_pacific_same_day_when_run_in_the_morning():
    # The Render cron fires at 12:00 UTC = 5am PDT, so with no earlier solo
    # post the post is due 6pm that same local day (= 01:00 UTC the next
    # day during PDT).
    now = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
    due = solo._next_post_time(now)
    assert due.astimezone(PACIFIC).strftime("%Y-%m-%d %H:%M") == "2026-10-24 18:00"
    assert due.astimezone(timezone.utc).isoformat() == "2026-10-25T01:00:00+00:00"


def test_next_post_time_rolls_to_tomorrow_after_6pm():
    # A manual run at 9pm Pacific must not ask Buffer for a time in the past.
    now = datetime(2026, 10, 24, 21, 0, tzinfo=PACIFIC)
    due = solo._next_post_time(now)
    assert due.astimezone(PACIFIC).strftime("%Y-%m-%d %H:%M") == "2026-10-25 18:00"


def test_next_post_time_exactly_6pm_rolls_forward():
    now = datetime(2026, 10, 24, 18, 0, tzinfo=PACIFIC)
    assert solo._next_post_time(now).day == 25


def test_next_post_time_tracks_pst_after_dst_ends():
    # 6pm local is 02:00 UTC once Pacific falls back to PST in November —
    # the hour is pinned by timezone name, not a fixed UTC offset.
    now = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
    due = solo._next_post_time(now)
    assert due.astimezone(PACIFIC).hour == 18
    assert due.astimezone(timezone.utc).isoformat() == "2026-11-21T02:00:00+00:00"


def test_next_post_time_keeps_two_day_gap_after_previous_post():
    # Previous post went out Oct 23 6pm. A run on Oct 24 morning must NOT
    # schedule Oct 24 — the next slot on the 2-day grid is Oct 25.
    now = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
    last = datetime(2026, 10, 23, 18, 0, tzinfo=PACIFIC)
    due = solo._next_post_time(now, last)
    assert due.astimezone(PACIFIC).strftime("%Y-%m-%d %H:%M") == "2026-10-25 18:00"


def test_next_post_time_same_day_when_gap_already_satisfied():
    now = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
    last = datetime(2026, 10, 22, 18, 0, tzinfo=PACIFIC)
    assert solo._next_post_time(now, last).day == 24


def test_next_post_time_chains_hand_runs_onto_successive_slots():
    # Running the pipeline three times in a row pre-queues three posts on
    # Oct 25 / 27 / 29 — the gap rule, not the cron schedule, spaces them.
    now = datetime(2026, 10, 24, 21, 0, tzinfo=PACIFIC)  # after 6pm → first slot Oct 25
    first = solo._next_post_time(now, None)
    second = solo._next_post_time(now, first)
    third = solo._next_post_time(now, second)
    assert [d.astimezone(PACIFIC).day for d in (first, second, third)] == [25, 27, 29]
    assert all(d.astimezone(PACIFIC).hour == 18 for d in (first, second, third))


# ── _pick_solo_breakouts ─────────────────────────────────────────────────


def _fresh(monkeypatch, tweets, *, used_ids=frozenset(), used_captions=frozenset()):
    monkeypatch.setattr(
        solo,
        "post_caption_exists",
        lambda platform, caption: (platform, caption) in used_captions,
    )
    return solo._pick_solo_breakouts(tweets, set(used_ids))


def test_breakouts_skip_retweets_and_replies(monkeypatch):
    picked = _fresh(
        monkeypatch,
        [
            _apify("s1", "RT @someone: not our content."),
            _apify("s2", "@someone replying to a thread."),
            _apify("s3", "A genuine breakout tweet."),
        ],
    )
    assert [t["tweet_id"] for t in picked] == ["s3"]


def test_breakouts_apply_dedup_gates(monkeypatch):
    picked = _fresh(
        monkeypatch,
        [
            # Already a slide on a past carousel.
            _apify("used-id", "Fine text, used id."),
            # Already posted to Instagram (solo or carousel slide 1).
            _apify("s2", "Already posted text."),
            _apify("s3", "Ship daily."),
            # Fingerprint-duplicate within the same run.
            _apify("s4", "SHIP DAILY!!"),
        ],
        used_ids={"used-id"},
        used_captions={("instagram", "Already posted text.")},
    )
    assert [t["tweet_id"] for t in picked] == ["s3"]


# ── _choose_tweet ──────────────────────────────────────────────────


def _choose(monkeypatch, breakouts, *, bank):
    # The bank fallback goes through the carousel module's picker, which
    # reads the bank + caption gate from ITS module globals.
    import cron.instagram_carousel_pipeline as carousel

    monkeypatch.setattr(carousel, "select_bank_content_with_likes", lambda *a, **k: bank)
    monkeypatch.setattr(carousel, "post_caption_exists", lambda *a, **k: False)
    return solo._choose_tweet(breakouts, bank_min_likes=4000, used_tweet_ids=set())


def test_choose_prefers_the_most_liked_fresh_breakout(monkeypatch):
    breakouts = [
        {"tweet_id": "f1", "text": "Newest.", "normalized": "Newest.", "favorite_count": 9000},
        {"tweet_id": "f2", "text": "Older.", "normalized": "Older.", "favorite_count": 15000},
    ]
    chosen = _choose(monkeypatch, breakouts, bank=[_bank("b1", "Bank line.", likes=50000)])
    # Fresh beats bank even when the bank tweet has more likes, and among
    # fresh tweets the strongest ships first.
    assert chosen["tweet_id"] == "f2"
    assert chosen["source"] == "fresh"


def test_choose_falls_back_to_one_bank_tweet(monkeypatch):
    # The bank sampler is random; the picker simply takes the first
    # candidate that clears the dedup gates and ships exactly one.
    chosen = _choose(
        monkeypatch,
        [],
        bank=[_bank("b1", "Decent.", likes=5000), _bank("b2", "Other.", likes=12000)],
    )
    assert chosen["tweet_id"] == "b1"
    assert chosen["source"] == "bank"


def test_choose_returns_none_when_bank_is_exhausted(monkeypatch):
    assert _choose(monkeypatch, [], bank=[]) is None
