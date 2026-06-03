"""Tests for core.bank_post_reviewer.

Follows the same mocking pattern as tests/test_tweet_filter.py — regex
stage needs no client, LLM stage uses a MagicMock anthropic client.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from core.bank_post_reviewer import is_postable_bank_post


def _mock_client(json_text: str) -> MagicMock:
    """Build a MagicMock anthropic client that returns `json_text` as the
    model's text block — matches the SDK response shape used in _llm_judge."""
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text=json_text)])
    client = MagicMock()
    client.messages.create.return_value = response
    return client


# ── Stage 1: regex heuristics ─────────────────────────────────────────────


class TestRegexStage:
    def test_empty_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("", client=client)
        assert keep is False
        assert reason == "empty"
        client.messages.create.assert_not_called()

    def test_retweet_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("RT @AlexHormozi: great thread", client=client)
        assert keep is False
        assert reason == "retweet"
        client.messages.create.assert_not_called()

    def test_hyperlink_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("Check this out https://t.co/abc123", client=client)
        assert keep is False
        assert reason == "hyperlink"
        client.messages.create.assert_not_called()

    def test_truncated_ellipsis_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("Here are the 7 reasons why you should...", client=client)
        assert keep is False
        assert reason == "truncated"
        client.messages.create.assert_not_called()

    def test_truncated_unicode_ellipsis_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("Here are the 7 reasons why you should…", client=client)
        assert keep is False
        assert reason == "truncated"
        client.messages.create.assert_not_called()

    def test_too_short_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_bank_post("yes", client=client)
        assert keep is False
        assert reason == "too_short"
        client.messages.create.assert_not_called()


# ── Stage 2: LLM judge ────────────────────────────────────────────────────


class TestLLMStage:
    def test_complete_post_kept(self):
        client = _mock_client('{"keep": true, "reason": "complete"}')
        keep, reason = is_postable_bank_post(
            "Execution beats ideas every time. The market doesn't care about your vision.",
            client=client,
        )
        assert keep is True
        assert reason == "complete"
        client.messages.create.assert_called_once()

    def test_unfulfilled_list_rejected(self):
        client = _mock_client('{"keep": false, "reason": "unfulfilled_list"}')
        keep, reason = is_postable_bank_post(
            "7 ways to get rich (you won't hear these elsewhere)", client=client
        )
        assert keep is False
        assert reason == "unfulfilled_list"

    def test_thread_hook_rejected(self):
        client = _mock_client('{"keep": false, "reason": "thread_hook"}')
        keep, reason = is_postable_bank_post(
            "Here are 5 lessons I learned the hard way 👇",
            client=client,
        )
        assert keep is False
        assert reason == "thread_hook"

    def test_fulfilled_list_kept(self):
        # A post that promises AND delivers the list should be kept.
        text = "3 rules for hiring:\n1. Hire slow\n2. Fire fast\n3. Promote from within"
        client = _mock_client('{"keep": true, "reason": "complete"}')
        keep, reason = is_postable_bank_post(text, client=client)
        assert keep is True
        assert reason == "complete"
