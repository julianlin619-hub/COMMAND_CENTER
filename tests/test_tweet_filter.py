"""Tests for core.tweet_filter.

Two-stage filter: regex heuristics first (no client needed), then a
Claude semantic judge that we mock. Mirrors the mocking pattern in
`tests/test_youtube_title_generator.py` — SimpleNamespace + MagicMock to
match the anthropic SDK response shape.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.tweet_filter import is_postable_tweet


def _mock_client_returning(text: str) -> MagicMock:
    """Build a MagicMock anthropic client whose messages.create returns `text`
    as a single text block — matches the SDK response shape used in
    core/tweet_filter._llm_judge."""
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])
    client = MagicMock()
    client.messages.create.return_value = response
    return client


class TestRegexStage:
    """Stage 1 — no client is needed because regex rejects before LLM call.

    Passing a MagicMock client and asserting it was never called confirms
    we short-circuited at the regex stage rather than accidentally falling
    through to the LLM.
    """

    def test_empty_string_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("", client=client)
        assert keep is False
        assert reason == "empty"
        client.messages.create.assert_not_called()

    def test_whitespace_only_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("   \n  ", client=client)
        assert keep is False
        assert reason == "empty"
        client.messages.create.assert_not_called()

    def test_retweet_prefix_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet(
            "RT @AlexHormozi: Be happy to pay the price or be resentful. "
            "But it's not going to change the cost of getting what you want.",
            client=client,
        )
        assert keep is False
        assert reason == "retweet"
        client.messages.create.assert_not_called()

    def test_retweet_prefix_case_insensitive(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("rt @someone: this is a real tweet body that's long enough", client=client)
        assert keep is False
        assert reason == "retweet"

    def test_https_url_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet(
            "Read this great article https://example.com/article it's amazing",
            client=client,
        )
        assert keep is False
        assert reason == "hyperlink"
        client.messages.create.assert_not_called()

    def test_tco_shortlink_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet(
            "Just wrote about scaling teams t.co/abc123 check it out",
            client=client,
        )
        assert keep is False
        assert reason == "hyperlink"

    def test_www_link_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet(
            "More on this at www.acquisition.com really worth reading",
            client=client,
        )
        assert keep is False
        assert reason == "hyperlink"

    def test_ascii_ellipsis_truncation_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("My assistant lost $20,000...", client=client)
        assert keep is False
        assert reason == "truncated"
        client.messages.create.assert_not_called()

    def test_unicode_ellipsis_truncation_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("My assistant lost $20,000…", client=client)
        assert keep is False
        assert reason == "truncated"

    def test_too_short_rejected(self):
        client = MagicMock()
        keep, reason = is_postable_tweet("Short tweet.", client=client)
        assert keep is False
        assert reason == "too_short"
        client.messages.create.assert_not_called()

    def test_retweet_beats_other_tags(self):
        """`RT @x: hi` matches both retweet and too_short — retweet should win
        because it's the more specific/useful tag for logging."""
        client = MagicMock()
        keep, reason = is_postable_tweet("RT @x: hi", client=client)
        assert reason == "retweet"


class TestLLMStage:
    """Stage 2 — runs only after regex passes. We feed clean-looking text
    and mock the Anthropic response to control the verdict."""

    _CLEAN_TWEET = (
        "Hire slow, fire fast. Every founder learns this the hard way "
        "after their first bad hire."
    )

    def test_llm_keeps_complete_tweet(self):
        client = _mock_client_returning('{"keep": true, "reason": "complete"}')
        keep, reason = is_postable_tweet(self._CLEAN_TWEET, client=client)
        assert keep is True
        assert reason == "complete"
        client.messages.create.assert_called_once()

    def test_llm_rejects_fragment(self):
        client = _mock_client_returning('{"keep": false, "reason": "fragment"}')
        keep, reason = is_postable_tweet(
            "and that's why every founder eventually has to learn this lesson",
            client=client,
        )
        assert keep is False
        assert reason == "fragment"

    def test_llm_rejects_reply(self):
        client = _mock_client_returning('{"keep": false, "reason": "reply"}')
        keep, reason = is_postable_tweet(
            "yes this is exactly what I have been saying for years now",
            client=client,
        )
        assert keep is False
        assert reason == "reply"

    def test_api_call_shape(self):
        """The LLM call uses the same shape as youtube_title_generator —
        Sonnet 4.6, thinking disabled, structured JSON schema."""
        client = _mock_client_returning('{"keep": true, "reason": "complete"}')
        is_postable_tweet(self._CLEAN_TWEET, client=client)
        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-6"
        assert kwargs["thinking"] == {"type": "disabled"}
        assert kwargs["messages"] == [{"role": "user", "content": self._CLEAN_TWEET}]
        assert kwargs["output_config"]["format"]["type"] == "json_schema"
        schema = kwargs["output_config"]["format"]["schema"]
        assert set(schema["required"]) == {"keep", "reason"}
        assert schema["additionalProperties"] is False

    def test_sdk_error_propagates(self):
        """A flaky API key shouldn't silently fall through to "keep" — the
        cron caller catches and skips, but the filter itself raises."""
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        with pytest.raises(RuntimeError, match="boom"):
            is_postable_tweet(self._CLEAN_TWEET, client=client)

    def test_malformed_json_raises(self):
        client = _mock_client_returning("not json at all")
        with pytest.raises(Exception):  # json.JSONDecodeError
            is_postable_tweet(self._CLEAN_TWEET, client=client)

    def test_missing_keep_field_raises(self):
        client = _mock_client_returning('{"reason": "complete"}')
        with pytest.raises(KeyError):
            is_postable_tweet(self._CLEAN_TWEET, client=client)
