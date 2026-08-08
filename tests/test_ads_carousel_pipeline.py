"""Tests for core.ads_carousel_pipeline (bank build + permutation batches).

Covers the pure decision logic — the Claude topical filter, the
rejection-sampling permutation generator with its >=3-differ rule, and
the unique-slide render mapping — with the Anthropic client and render
HTTP call mocked. Mirrors the SimpleNamespace + MagicMock mocking
pattern in tests/test_tweet_filter.py.
"""

from __future__ import annotations

import json
import random
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from core.ads_carousel_pipeline import (
    _MAX_SHARED_TWEETS,
    _TWEETS_PER_CAROUSEL,
    _filter_on_topic,
    _render_unique_slides,
    _sample_permutations,
)


def _mock_client_returning(text: str) -> MagicMock:
    """MagicMock anthropic client whose messages.create returns `text` as a
    single text block — matches the SDK response shape used in
    _filter_on_topic."""
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])
    client = MagicMock()
    client.messages.create.return_value = response
    return client


_CANDIDATES = [
    {"tweet_id": "t0", "text": "Revenue solves most problems.", "favorite_count": 100},
    {"tweet_id": "t1", "text": "My dog is cute.", "favorite_count": 9000},
    {"tweet_id": "t2", "text": "Hire slow, fire fast.", "favorite_count": 500},
]


class TestFilterOnTopic:
    def test_keeps_only_returned_indices(self):
        client = _mock_client_returning('{"keep_indices": [0, 2]}')
        kept = _filter_on_topic("business tweets", _CANDIDATES, client=client)
        assert [t["tweet_id"] for t in kept] == ["t0", "t2"]

    def test_empty_keep_list_returns_empty(self):
        client = _mock_client_returning('{"keep_indices": []}')
        assert _filter_on_topic("business tweets", _CANDIDATES, client=client) == []

    def test_out_of_range_indices_ignored(self):
        """A model slip (index 99) shouldn't crash the build — in-range picks
        are still good."""
        client = _mock_client_returning('{"keep_indices": [1, 99, -1]}')
        kept = _filter_on_topic("pets", _CANDIDATES, client=client)
        assert [t["tweet_id"] for t in kept] == ["t1"]

    def test_duplicate_indices_deduped(self):
        client = _mock_client_returning('{"keep_indices": [2, 2, 0]}')
        kept = _filter_on_topic("business", _CANDIDATES, client=client)
        assert [t["tweet_id"] for t in kept] == ["t0", "t2"]

    def test_single_batched_call_with_numbered_list(self):
        client = _mock_client_returning('{"keep_indices": [0]}')
        _filter_on_topic("business", _CANDIDATES, client=client)
        client.messages.create.assert_called_once()
        user_message = client.messages.create.call_args.kwargs["messages"][0]["content"]
        assert "Brief: business" in user_message
        for i, c in enumerate(_CANDIDATES):
            assert f"[{i}] {c['text']}" in user_message

    def test_api_call_shape(self):
        """Same structured-output shape as core/tweet_filter.py."""
        client = _mock_client_returning('{"keep_indices": []}')
        _filter_on_topic("business", _CANDIDATES, client=client)
        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-6"
        assert kwargs["thinking"] == {"type": "disabled"}
        assert kwargs["output_config"]["format"]["type"] == "json_schema"
        schema = kwargs["output_config"]["format"]["schema"]
        assert schema["required"] == ["keep_indices"]
        assert schema["additionalProperties"] is False

    def test_sdk_error_propagates(self):
        """A flaky key must fail the run loudly, not silently build a
        half-filtered bank."""
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        with pytest.raises(RuntimeError, match="boom"):
            _filter_on_topic("business", _CANDIDATES, client=client)

    def test_malformed_json_raises(self):
        client = _mock_client_returning("not json")
        with pytest.raises(Exception):  # json.JSONDecodeError
            _filter_on_topic("business", _CANDIDATES, client=client)


class TestSamplePermutations:
    _BANK = [f"t{i}" for i in range(40)]

    def test_generates_requested_count(self):
        combos = _sample_permutations(self._BANK, [], 20, rng=random.Random(42))
        assert len(combos) == 20

    def test_each_combo_is_nine_distinct_bank_tweets(self):
        combos = _sample_permutations(self._BANK, [], 10, rng=random.Random(1))
        for combo in combos:
            assert len(combo) == _TWEETS_PER_CAROUSEL
            assert len(set(combo)) == _TWEETS_PER_CAROUSEL
            assert set(combo) <= set(self._BANK)

    def test_within_run_combos_differ_by_at_least_three(self):
        combos = _sample_permutations(self._BANK, [], 15, rng=random.Random(7))
        for i, a in enumerate(combos):
            for b in combos[i + 1:]:
                assert len(set(a) & set(b)) <= _MAX_SHARED_TWEETS

    def test_respects_existing_ledger_sets(self):
        """New combos must also differ >=3 from every carousel generated in
        prior runs (the ads_carousels ledger)."""
        existing = [set(self._BANK[:9]), set(self._BANK[9:18])]
        combos = _sample_permutations(self._BANK, existing, 15, rng=random.Random(3))
        for combo in combos:
            for prev in existing:
                assert len(set(combo) & prev) <= _MAX_SHARED_TWEETS

    def test_saturated_space_returns_partial_not_infinite_loop(self):
        """A bank of size+1: any two 7-subsets share >= 6 tweets (> the max
        of 4), so after one carousel exists no second one is possible. Must
        return what it has, not spin forever."""
        tiny_bank = [f"t{i}" for i in range(_TWEETS_PER_CAROUSEL + 1)]
        combos = _sample_permutations(tiny_bank, [], 5, rng=random.Random(0))
        assert len(combos) == 1

    def test_saturated_by_ledger_returns_empty(self):
        tiny_bank = [f"t{i}" for i in range(_TWEETS_PER_CAROUSEL + 1)]
        existing = [set(tiny_bank[:_TWEETS_PER_CAROUSEL])]
        combos = _sample_permutations(tiny_bank, existing, 5, rng=random.Random(0))
        assert combos == []


class TestRenderUniqueSlides:
    def _generate_response(self, ids: list[str]) -> dict:
        # Response order deliberately scrambled — the pipeline must re-map
        # by id, not trust list order.
        return {
            "generated": [
                {"id": i, "text": f"text-{i}", "storagePath": f"ads/tweet-{i}.png"}
                for i in reversed(ids)
            ],
            "errors": [],
        }

    def test_maps_storage_paths_by_id(self):
        texts = {"t1": "One.", "t2": "Two.", "cta-1": "CTA"}
        with patch("core.ads_carousel_pipeline.generate_content") as gen:
            gen.return_value = self._generate_response(list(texts))
            paths = _render_unique_slides(texts, dashboard_url="http://x", cron_secret="s")
        assert paths == {
            "t1": "ads/tweet-t1.png",
            "t2": "ads/tweet-t2.png",
            "cta-1": "ads/tweet-cta-1.png",
        }
        assert gen.call_args.kwargs["platform"] == "ads"

    def test_chunks_large_batches(self):
        """>50 slides must split across multiple render calls so no single
        request risks the content-gen client's timeout."""
        texts = {f"t{i}": f"Tweet {i}." for i in range(120)}
        with patch("core.ads_carousel_pipeline.generate_content") as gen:
            gen.side_effect = lambda **kw: self._generate_response(
                [t["id"] for t in kw["tweets"]]
            )
            paths = _render_unique_slides(texts, dashboard_url="http://x", cron_secret="s")
        assert len(paths) == 120
        assert gen.call_count == 3  # 50 + 50 + 20
        for call in gen.call_args_list:
            assert len(call.kwargs["tweets"]) <= 50

    def test_missing_slide_raises(self):
        """ALL slides must render — a carousel with a missing slide is worse
        than no carousel."""
        texts = {"t1": "One.", "t2": "Two."}
        with patch("core.ads_carousel_pipeline.generate_content") as gen:
            gen.return_value = self._generate_response(["t1"])  # t2 dropped
            with pytest.raises(RuntimeError, match="dropped"):
                _render_unique_slides(texts, dashboard_url="http://x", cron_secret="s")

    def test_route_error_raises(self):
        with patch("core.ads_carousel_pipeline.generate_content") as gen:
            gen.return_value = {"error": "No active ads template found"}
            with pytest.raises(RuntimeError, match="No active ads template"):
                _render_unique_slides({"t1": "One."}, dashboard_url="http://x", cron_secret="s")


class TestGenerateDryRun:
    def test_dry_run_skips_drive_and_ledger(self, monkeypatch, capsys):
        """End-to-end main() in generate mode with everything mocked:
        dry_run must never touch Drive or insert ledger rows, and must
        report folder_url: null."""
        import core.ads_carousel_pipeline as pipeline

        bank_rows = [{"tweet_id": f"t{i}", "text": f"Tweet {i}."} for i in range(40)]

        def fake_fetch_all(table, columns):
            return bank_rows if table == "ads_bank" else []

        monkeypatch.setattr(
            "sys.stdin",
            SimpleNamespace(read=lambda: json.dumps({
                "mode": "generate", "count": 3, "cta_text": "CTA", "dry_run": True,
            })),
        )
        monkeypatch.setattr("sys.argv", ["ads_carousel_pipeline"])
        monkeypatch.setattr(pipeline, "log_env_diagnostics", MagicMock())
        monkeypatch.setattr(pipeline, "log_cron_start", MagicMock(return_value="run1"))
        finish = MagicMock()
        monkeypatch.setattr(pipeline, "log_cron_finish", finish)
        monkeypatch.setattr(pipeline, "_fetch_all", fake_fetch_all)
        monkeypatch.setattr(
            pipeline, "_render_unique_slides",
            MagicMock(side_effect=lambda texts, **kw: {
                sid: f"ads/tweet-{sid}.png" for sid in texts
            }),
        )
        token = MagicMock()
        monkeypatch.setattr(pipeline, "get_access_token", token)
        db_client = MagicMock()
        monkeypatch.setattr(pipeline, "get_client", MagicMock(return_value=db_client))

        pipeline.main()

        token.assert_not_called()
        db_client.table.assert_not_called()  # no ledger inserts
        finish.assert_called_once_with("run1", status="success", posts_processed=0)
        summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert summary["status"] == "success"
        assert summary["dry_run"] is True
        assert summary["generated"] == 3
        assert summary["folder_url"] is None
        # 3 carousels × 9 tweets can overlap, but CTA always adds one more
        # unique slide.
        assert summary["unique_slides"] >= _TWEETS_PER_CAROUSEL + 1
