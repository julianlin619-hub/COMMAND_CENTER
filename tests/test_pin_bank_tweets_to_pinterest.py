"""Tests for scripts/pin_bank_tweets_to_pinterest.py.

The script is not a package (scripts/ has no __init__.py), so we load it
by file path. Every DB / Buffer / dashboard seam is monkeypatched on the
loaded module — no network, no Supabase.

What these pin down:
  - the pick is most-liked-first, skips tweets already on Pinterest, drops
    blank text, honours LIMIT, and reuses an existing Facebook card;
  - DRY_RUN neither renders nor sends;
  - rendering batches only the picks without a card and drops failed ones;
  - every send goes through send_leg with the tweet text as the pin body,
    the board block, and the raised caption limit;
  - a Buffer rate-limit failure stops the run instead of burning the window.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pin_bank_tweets_to_pinterest.py"


@pytest.fixture
def script():
    spec = importlib.util.spec_from_file_location("pin_bank_tweets_to_pinterest", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _pick(tweet_id: str, text: str = "the tweet", storage_path: str | None = None) -> dict:
    return {"tweet_id": tweet_id, "text": text, "favorite_count": 7000, "storage_path": storage_path}


def _bank_rows() -> list[dict]:
    # Deliberately unsorted: the script must impose most-liked-first itself.
    return [
        {"tweet_id": 1, "text": "mid tweet https://t.co/abc", "favorite_count": 7000},
        {"tweet_id": 2, "text": "top tweet", "favorite_count": 9000},
        {"tweet_id": 3, "text": "pinned tweet", "favorite_count": 8000},
        {"tweet_id": 4, "text": "low tweet", "favorite_count": 6600},
        {"tweet_id": 5, "text": "   ", "favorite_count": 9999},
    ]


def test_env_int_treats_blank_as_default(script, monkeypatch):
    # Actions passes an emptied input as "" — int("") would crash.
    monkeypatch.setenv("LIMIT", "")
    assert script._env_int("LIMIT", 100) == 100
    monkeypatch.setenv("LIMIT", " 25 ")
    assert script._env_int("LIMIT", 100) == 25
    monkeypatch.delenv("LIMIT")
    assert script._env_int("LIMIT", 100) == 100


def test_pick_is_most_liked_first_skips_pinned_and_honours_limit(script, monkeypatch):
    dedup_calls: list[tuple[str, str]] = []

    def fake_exists(platform, caption):
        dedup_calls.append((platform, caption))
        return caption == "pinned tweet"

    monkeypatch.setattr(
        script, "select_bank_content_with_likes", lambda count, min_likes: _bank_rows(),
    )
    monkeypatch.setattr(script, "post_caption_exists", fake_exists)
    monkeypatch.setattr(
        script, "existing_facebook_image",
        lambda caption: "generated/facebook/1.png" if caption == "mid tweet" else None,
    )

    picks = script.pick_candidates(limit=2, min_likes=6500)

    # 9999 is blank (skipped), 9000 top, 8000 already pinned, 7000 mid, 6600 cut by LIMIT.
    assert [p["tweet_id"] for p in picks] == ["2", "1"]
    # The t.co link is stripped so the caption matches what the cron would write.
    assert picks[1]["text"] == "mid tweet"
    # Dedup is checked against the Pinterest rows only.
    assert {platform for platform, _ in dedup_calls} == {"pinterest"}
    # Reuse an existing Facebook card where one exists; render the rest.
    assert picks[0]["storage_path"] is None
    assert picks[1]["storage_path"] == "generated/facebook/1.png"


def test_dry_run_neither_renders_nor_sends(script, monkeypatch):
    monkeypatch.setenv("DRY_RUN", "1")
    monkeypatch.setenv("LIMIT", "")
    seen: dict = {}
    monkeypatch.setattr(script, "log_env_diagnostics", lambda *a, **k: None)
    monkeypatch.setattr(script, "get_channel_id", lambda service: "pin-ch")
    monkeypatch.setattr(script, "get_pinterest_board_service_id", lambda name: "board-1")

    def fake_pick(limit, min_likes):
        seen["limit"] = limit
        return [_pick("1")]

    def must_not_run(*a, **k):
        raise AssertionError("render/send must not run in DRY_RUN")

    monkeypatch.setattr(script, "pick_candidates", fake_pick)
    monkeypatch.setattr(script, "render_extra_platforms", must_not_run)
    monkeypatch.setattr(script, "send_leg", must_not_run)

    script.main()  # no SystemExit
    assert seen["limit"] == 100  # blank LIMIT input falls back to the default


def test_render_missing_batches_and_drops_failed_renders(script, monkeypatch):
    monkeypatch.setattr(script, "RENDER_BATCH_SIZE", 2)
    calls: list[list[str]] = []

    def fake_render(*, dashboard_url, cron_secret, tweets):
        calls.append([t["id"] for t in tweets])
        # Tweet "3" never comes back from the dashboard.
        return {
            "facebook": {
                t["id"]: f"generated/facebook/{t['id']}.png" for t in tweets if t["id"] != "3"
            },
            "instagram": {},
        }

    monkeypatch.setattr(script, "render_extra_platforms", fake_render)
    picks = [
        _pick("1", storage_path="generated/facebook/1.png"),  # reused, not re-rendered
        _pick("2"),
        _pick("3"),
        _pick("4"),
    ]

    ready = script.render_missing(picks, dashboard_url="https://dash", cron_secret="s")

    assert calls == [["2", "3"], ["4"]]
    assert [p["tweet_id"] for p in ready] == ["1", "2", "4"]
    assert ready[1]["storage_path"] == "generated/facebook/2.png"


def _capture_sends(script, monkeypatch, statuses: list[str]) -> list[dict]:
    calls: list[dict] = []

    def fake_send(**kwargs):
        calls.append(kwargs)
        status = statuses[len(calls) - 1]
        return {
            "status": status,
            "post_id": "post-1",
            "buffer_post_id": "buffer-1" if status == "sent" else None,
            "error": "Buffer RATE_LIMIT_EXCEEDED: rate limit hit" if status == "buffer_failed" else None,
        }

    monkeypatch.setattr(script, "send_leg", fake_send)
    monkeypatch.setattr(script.time, "sleep", lambda seconds: None)
    return calls


def test_send_all_ships_tweet_text_to_the_board(script, monkeypatch):
    calls = _capture_sends(script, monkeypatch, ["sent", "duplicate"])
    picks = [_pick("1", storage_path="generated/facebook/1.png"), _pick("2", storage_path="x.png")]

    queued, skipped, failed = script.send_all(picks, channel_id="pin-ch", board_service_id="board-1")

    assert (queued, skipped, failed) == (1, 1, 0)
    first = calls[0]
    assert first["platform"] == "pinterest"
    assert first["channel_id"] == "pin-ch"
    assert first["storage_path"] == "generated/facebook/1.png"
    # Unlike FB/LI, Pinterest publishes the tweet text as the description …
    assert first["buffer_body"] == first["caption"] == "the tweet"
    # … onto the configured board, untruncated.
    assert first["extra_send_kwargs"] == {
        "pinterest": {"boardServiceId": "board-1"},
        "caption_limit": script.PINTEREST_CAPTION_LIMIT,
    }
    assert first["source_tag"] == script.SOURCE_TAG


def test_send_all_stops_on_rate_limit(script, monkeypatch):
    calls = _capture_sends(script, monkeypatch, ["sent", "buffer_failed", "sent"])
    picks = [_pick("1", storage_path="a"), _pick("2", storage_path="b"), _pick("3", storage_path="c")]

    queued, skipped, failed = script.send_all(picks, channel_id="pin-ch", board_service_id="board-1")

    assert (queued, skipped, failed) == (1, 0, 1)
    assert len(calls) == 2  # the third pick is never attempted


def _patch_main_seams(script, monkeypatch, picks):
    monkeypatch.delenv("DRY_RUN", raising=False)
    monkeypatch.setenv("DASHBOARD_URL", "https://dash")
    monkeypatch.setenv("CRON_SECRET", "s")
    monkeypatch.setattr(script, "log_env_diagnostics", lambda *a, **k: None)
    monkeypatch.setattr(script, "get_channel_id", lambda service: "pin-ch")
    monkeypatch.setattr(script, "get_pinterest_board_service_id", lambda name: "board-1")
    monkeypatch.setattr(script, "pick_candidates", lambda limit, min_likes: picks)


def test_main_real_run_renders_then_sends(script, monkeypatch):
    picks = [_pick("1", storage_path="generated/facebook/1.png"), _pick("2")]
    _patch_main_seams(script, monkeypatch, picks)
    monkeypatch.setattr(
        script, "render_extra_platforms",
        lambda **k: {"facebook": {"2": "generated/facebook/2.png"}, "instagram": {}},
    )
    calls = _capture_sends(script, monkeypatch, ["sent", "sent"])

    script.main()  # no SystemExit: everything shipped

    assert [c["storage_path"] for c in calls] == [
        "generated/facebook/1.png", "generated/facebook/2.png",
    ]


def test_main_exits_nonzero_when_a_render_is_dropped(script, monkeypatch):
    picks = [_pick("1"), _pick("2")]
    _patch_main_seams(script, monkeypatch, picks)
    monkeypatch.setattr(
        script, "render_extra_platforms",
        lambda **k: {"facebook": {"1": "generated/facebook/1.png"}, "instagram": {}},
    )
    calls = _capture_sends(script, monkeypatch, ["sent"])

    with pytest.raises(SystemExit) as exc:
        script.main()

    assert exc.value.code == 1
    assert len(calls) == 1  # the rendered pick still shipped
