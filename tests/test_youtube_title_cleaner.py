"""Tests for core.youtube_title_cleaner."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.youtube_title_cleaner import (
    CleanedTitle,
    _regex_clean,
    clean_title,
)


class TestRegexClean:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # Alphanumerics + whitespace kept as-is.
            ("How to Win", "How to Win"),
            ("Hello\t\tWorld", "Hello World"),
            ("Café résumé", "Café résumé"),  # Unicode letters kept via \w
            ("  Top 10 Tips  ", "Top 10 Tips"),
            ("one\ntwo\nthree", "one two three"),
            # Allowed punctuation kept.
            ("Doesn't", "Doesn't"),  # apostrophe
            ("What?", "What?"),  # question mark
            ("How to Win!", "How to Win!"),  # bang
            ("Top 10: Best Tips", "Top 10: Best Tips"),  # colon
            ("Hello, World.", "Hello, World."),  # comma + period
            ("foo-bar-baz", "foo-bar-baz"),  # hyphens
            # Disallowed characters stripped.
            ("🎬🎬🎬", ""),
            ("How to Win 🎬", "How to Win"),
            ("Vlog #42", "Vlog 42"),  # hashtag dropped
            ("Part I — Part II", "Part I Part II"),  # em-dash dropped
            ("a | b", "a b"),  # pipe dropped
            # Edge cases.
            ("", ""),
            ("   ", ""),
        ],
    )
    def test_cases(self, raw, expected):
        assert _regex_clean(raw) == expected


def _mock_client_returning(text: str) -> MagicMock:
    """Build a MagicMock anthropic client whose messages.create returns `text`
    as a single text block — matching the SDK's response shape."""
    response = SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)]
    )
    client = MagicMock()
    client.messages.create.return_value = response
    return client


class TestCleanTitle:
    def test_empty_input_skips_api_call(self):
        client = _mock_client_returning('{"cleaned_title": "never used"}')
        result = clean_title("🎬🎬🎬", client=client)
        assert result == CleanedTitle(
            original="🎬🎬🎬", regex_cleaned="", final="", sonnet_applied=False
        )
        client.messages.create.assert_not_called()

    def test_happy_path_removes_version_markers(self):
        client = _mock_client_returning('{"cleaned_title": "How to Win!"}')
        result = clean_title("How to Win V4 Final!", client=client)
        assert result.original == "How to Win V4 Final!"
        # Bang is allowed punctuation now; regex passes it through.
        assert result.regex_cleaned == "How to Win V4 Final!"
        assert result.final == "How to Win!"
        assert result.sonnet_applied is True
        # The user-facing prompt is the regex-cleaned title.
        call_kwargs = client.messages.create.call_args.kwargs
        assert call_kwargs["messages"] == [
            {"role": "user", "content": "How to Win V4 Final!"}
        ]

    def test_happy_path_preserves_clean_title(self):
        # Sonnet is expected to return the title unchanged when it's already clean.
        client = _mock_client_returning('{"cleaned_title": "Top 10 Productivity Tips!"}')
        result = clean_title("Top 10 Productivity Tips!", client=client)
        assert result.final == "Top 10 Productivity Tips!"
        assert result.sonnet_applied is True

    def test_apostrophe_preserved_through_pipeline(self):
        # The real-world failure case: "Having ADD Doesn't Have to Destroy Your Business".
        # With the loosened regex, the apostrophe survives the regex step, and
        # Sonnet (if it obeys its prompt) returns the title unchanged.
        raw = "Having ADD Doesn't Have to Destroy Your Business"
        client = _mock_client_returning(
            '{"cleaned_title": "Having ADD Doesn\'t Have to Destroy Your Business"}'
        )
        result = clean_title(raw, client=client)
        assert result.regex_cleaned == raw
        assert result.final == raw
        assert result.sonnet_applied is True

    def test_api_call_shape_matches_skill_guidance(self):
        """Lock in the payload shape we committed to in the plan."""
        client = _mock_client_returning('{"cleaned_title": "My Title"}')
        clean_title("My Title", client=client)
        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-6"
        assert kwargs["max_tokens"] == 256
        assert kwargs["thinking"] == {"type": "disabled"}
        # Structured output schema locks the response to a single JSON field.
        assert kwargs["output_config"]["format"]["type"] == "json_schema"
        schema = kwargs["output_config"]["format"]["schema"]
        assert schema["required"] == ["cleaned_title"]
        assert schema["additionalProperties"] is False

    def test_api_failure_falls_back_to_regex(self, caplog):
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        with caplog.at_level("WARNING"):
            result = clean_title("How to Win V4!", client=client)
        assert result.final == "How to Win V4!"  # regex-cleaned, no Sonnet step
        assert result.sonnet_applied is False
        assert "fallback" in caplog.text.lower() or "falling back" in caplog.text.lower()

    def test_missing_api_key_falls_back_without_calling_sdk(self, monkeypatch, caplog):
        # No client injected and no ANTHROPIC_API_KEY env var — should short-circuit
        # and return regex-cleaned without ever constructing an anthropic client.
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with caplog.at_level("WARNING"):
            result = clean_title("How to Win V4!")
        assert result.final == "How to Win V4!"
        assert result.sonnet_applied is False
        assert "ANTHROPIC_API_KEY" in caplog.text

    def test_sonnet_empty_response_falls_back(self):
        client = _mock_client_returning('{"cleaned_title": ""}')
        result = clean_title("Some Title V4", client=client)
        # Empty Sonnet response is treated as a failure; regex result is kept.
        assert result.final == "Some Title V4"
        assert result.sonnet_applied is False

    def test_sonnet_malformed_json_falls_back(self):
        client = _mock_client_returning('not json at all')
        result = clean_title("Some Title V4", client=client)
        assert result.final == "Some Title V4"
        assert result.sonnet_applied is False
