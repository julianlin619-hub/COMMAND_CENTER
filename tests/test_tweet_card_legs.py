"""Tests for the Pinterest leg of cron/_tweet_card_legs.py.

The FB/LI/IG legs predate this file and are exercised indirectly through the
pipelines; these tests pin down what's *different* about the Pinterest leg:
  - it publishes the tweet text as the Buffer body (every other leg ships a
    blank caption because the text is already rendered on the card);
  - it carries the board block + raised caption limit into send_to_buffer and
    the replay payload;
  - a missing board skips the leg with 'skipped_no_board' (distinct from the
    missing-channel skip) without touching the other legs.

We patch the module's DB/Buffer seams so no network or Supabase is touched.
"""

from __future__ import annotations

import cron._tweet_card_legs as legs


def _patch_send_path(monkeypatch):
    """Stub the insert → proxy-url → Buffer-send → handoff chain, capturing calls."""
    captured: dict = {}
    monkeypatch.setattr(legs, "post_caption_exists", lambda platform, caption: False)
    monkeypatch.setattr(legs, "insert_post", lambda post: "post-1")
    monkeypatch.setattr(legs, "build_proxy_url", lambda post_id: f"https://proxy/{post_id}")

    def fake_send(channel_id, body, media_url, media_type=None, **kwargs):
        captured["send"] = {
            "channel_id": channel_id, "body": body,
            "media_url": media_url, "media_type": media_type, **kwargs,
        }
        return "buffer-1"

    def fake_handoff(post_id, buffer_post_id, **kwargs):
        captured["handoff"] = {"post_id": post_id, **kwargs}

    monkeypatch.setattr(legs, "send_to_buffer", fake_send)
    monkeypatch.setattr(legs, "record_buffer_handoff", fake_handoff)
    return captured


def _fanout(**overrides):
    """Call the fan-out with a full set of defaults, overriding per test."""
    args = {
        "tweet_caption": "the tweet text",
        "fb_storage_path": "generated/fb.png",
        "ig_storage_path": None,
        "fb_channel_id": "fb-ch",
        "li_channel_id": "li-ch",
        "ig_channel_id": None,
        "pin_channel_id": "pin-ch",
        "pin_board_service_id": "board-111",
        "source_tag": "outlier",
    }
    args.update(overrides)
    return legs.fanout_extra_legs_for_one_tweet(**args)


def test_pinterest_leg_publishes_tweet_text_with_board(monkeypatch):
    captured = _patch_send_path(monkeypatch)
    result = _fanout()

    assert result["pinterest"]["status"] == "sent"
    # Every send in this run goes through the same captured dict; the
    # pinterest leg runs first in fanout_extra_legs_for_one_tweet, so pick
    # its call out by re-running with only the pinterest leg live.
    captured.clear()
    result = _fanout(fb_channel_id=None, li_channel_id=None)
    send = captured["send"]
    # Unlike FB/LI (blank body), Pinterest publishes the tweet text …
    assert send["body"] == "the tweet text"
    # … onto the configured board, reusing the FB image, untruncated.
    assert send["pinterest"] == {"boardServiceId": "board-111"}
    assert send["caption_limit"] == legs.PINTEREST_CAPTION_LIMIT
    # The replay payload carries the same board + limit for reconcile.
    handoff = captured["handoff"]
    assert handoff["pinterest"] == {"boardServiceId": "board-111"}
    assert handoff["caption_limit"] == legs.PINTEREST_CAPTION_LIMIT
    assert handoff["body"] == "the tweet text"


def test_pinterest_leg_skips_without_board_but_other_legs_ship(monkeypatch):
    _patch_send_path(monkeypatch)
    result = _fanout(pin_board_service_id=None)

    assert result["pinterest"]["status"] == "skipped_no_board"
    assert result["facebook"]["status"] == "sent"
    assert result["linkedin"]["status"] == "sent"


def test_pinterest_leg_skips_without_channel(monkeypatch):
    _patch_send_path(monkeypatch)
    result = _fanout(pin_channel_id=None, pin_board_service_id=None)
    assert result["pinterest"]["status"] == "skipped_no_channel"


def test_fb_li_legs_still_ship_blank_captions(monkeypatch):
    captured = _patch_send_path(monkeypatch)
    _fanout(pin_channel_id=None, pin_board_service_id=None, li_channel_id=None)
    # Only the FB leg sent — confirm its published body stays blank.
    assert captured["send"]["body"] == ""


def test_summarize_leg_failures_counts_pinterest(monkeypatch):
    ok = {"status": "sent"}
    fail = {"status": "buffer_failed"}
    summary = legs.summarize_leg_failures([
        {"facebook": ok, "linkedin": ok, "instagram": ok, "pinterest": fail},
    ])
    assert summary == "pinterest leg failures: 1"
