"""Tests for core.youtube_title_generator."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from core.youtube_title_generator import (
    _MAX_TITLE_CHARS,
    _truncate_on_space,
    generate_title,
)


def _mock_client_returning(text: str) -> MagicMock:
    """Build a MagicMock anthropic client whose messages.create returns `text`
    as a single text block — matching the SDK response shape."""
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])
    client = MagicMock()
    client.messages.create.return_value = response
    return client


class TestGenerateTitle:
    def test_happy_path_returns_title(self):
        client = _mock_client_returning('{"title": "The $100M Offer Nobody Teaches"}')
        result = generate_title("transcript about business offers...", client=client)
        assert result == "The $100M Offer Nobody Teaches"

    def test_strips_whitespace(self):
        client = _mock_client_returning('{"title": "  padded title  "}')
        assert generate_title("some transcript", client=client) == "padded title"

    def test_api_call_shape(self):
        client = _mock_client_returning('{"title": "A Title"}')
        generate_title("my transcript goes here", client=client)
        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-6"
        assert kwargs["max_tokens"] == 128
        assert kwargs["thinking"] == {"type": "disabled"}
        assert kwargs["messages"] == [
            {"role": "user", "content": "my transcript goes here"}
        ]
        assert kwargs["output_config"]["format"]["type"] == "json_schema"
        schema = kwargs["output_config"]["format"]["schema"]
        assert schema["required"] == ["title"]
        assert schema["additionalProperties"] is False

    def test_sdk_error_propagates(self):
        client = MagicMock()
        client.messages.create.side_effect = RuntimeError("boom")
        with pytest.raises(RuntimeError, match="boom"):
            generate_title("a transcript", client=client)

    def test_malformed_json_raises(self):
        client = _mock_client_returning("not json at all")
        with pytest.raises(Exception):  # json.JSONDecodeError
            generate_title("a transcript", client=client)

    def test_empty_title_raises(self):
        client = _mock_client_returning('{"title": ""}')
        with pytest.raises(ValueError, match="empty title"):
            generate_title("a transcript", client=client)

    def test_missing_title_field_raises(self):
        client = _mock_client_returning('{"headline": "wrong key"}')
        with pytest.raises(ValueError, match="empty title"):
            generate_title("a transcript", client=client)

    def test_empty_transcript_raises_without_api_call(self):
        client = MagicMock()
        with pytest.raises(ValueError, match="empty"):
            generate_title("   ", client=client)
        client.messages.create.assert_not_called()

    def test_oversized_title_truncated_on_space(self):
        long = "word " * 30  # 150 chars-ish
        long = long.strip()
        client = _mock_client_returning(f'{{"title": "{long}"}}')
        result = generate_title("a transcript", client=client)
        assert len(result) <= _MAX_TITLE_CHARS
        # Must break on a space boundary — no trailing partial word.
        assert not result.endswith("wor")
        # Must not end with a trailing space.
        assert result == result.rstrip()


class TestTruncateOnSpace:
    def test_under_limit_unchanged(self):
        assert _truncate_on_space("short", 100) == "short"

    def test_breaks_on_last_space(self):
        text = "one two three four five"
        # Limit 15 → "one two three f" → last space at index 13 → "one two three"
        assert _truncate_on_space(text, 15) == "one two three"

    def test_hard_cuts_when_no_space(self):
        assert _truncate_on_space("loooooongword", 5) == "loooo"
