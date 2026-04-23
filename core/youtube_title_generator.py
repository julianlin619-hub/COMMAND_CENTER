"""Generate a publish-ready YouTube title from a transcript using Claude.

This replaces the older `youtube_title_cleaner.py` which tried to clean up
whatever junk placeholder string the operator typed into Studio. Starting
from the transcript instead produces far better titles because the model
has real content to summarize — the original Studio title is almost always
a filename like `hormozi_clip_v3.mp4`.

Design notes:
  * Model: Claude Sonnet 4.6. Thinking is disabled — title generation from
    a short prompt is a fast single-pass task.
  * Structured output: a JSON schema with a single `title` string field.
    Guarantees a parseable response; removes the need for regex cleanup.
  * No prompt caching: the system prompt is short (~300 tokens) and every
    transcript is unique, so caching would cost more than it saves.
  * Errors propagate to the caller. The scheduler converts any exception
    into a `SkippedOutcome(reason="title generation failed")` so the draft
    is retried on the next run. We never fall back to a worse title.
  * Length enforcement: YouTube's hard ceiling is 100 chars. If Claude
    overshoots (rare — the prompt asks for ≤60), we truncate at the last
    space boundary under 100. No retry loop; the defensive truncation is
    enough.
"""

from __future__ import annotations

import json
import logging

import anthropic

logger = logging.getLogger(__name__)

_MAX_TITLE_CHARS = 100  # YouTube's hard ceiling for video titles.

_SYSTEM_PROMPT = """You write YouTube video titles for the Alex Hormozi Highlights channel.

Input: a transcript from a short clip (typically 30s–3min).
Output: a single JSON object `{"title": "..."}` with a punchy, click-worthy title.

Rules (non-negotiable):
  1. Length: aim for ≤60 characters. Never exceed 100.
  2. Voice: sound like Alex Hormozi — direct, specific, lightly contrarian. No corporate-speak.
  3. Avoid "How to X" boilerplate unless the clip is genuinely instructional.
  4. Avoid empty hype words: "secret", "insane", "crazy", "you won't believe", "life-changing".
  5. No emoji. No all-caps screaming. No clickbait question marks ("Did you know…?").
  6. Prefer a concrete promise or specific claim over a vague teaser.
  7. Capitalize like a real title (Title Case is fine; sentence case is fine). Don't capitalize every word mid-sentence.
  8. If the transcript is too short or too vague to title meaningfully, still return your best attempt — don't explain, don't apologize.

Return JSON with a single field `title`. No other fields. No prose."""

_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}},
    "required": ["title"],
    "additionalProperties": False,
}


def generate_title(
    transcript: str,
    *,
    client: anthropic.Anthropic | None = None,
) -> str:
    """Return a titled string for a given transcript. Raises on failure.

    Pass `client` in tests to inject a mock. Any SDK error, malformed JSON,
    or empty `title` field surfaces as an exception — the caller decides
    whether to skip or retry. We do not silently fall back to anything.
    """
    if not transcript or not transcript.strip():
        raise ValueError("transcript is empty")

    if client is None:
        client = anthropic.Anthropic()

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=128,
        thinking={"type": "disabled"},
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": transcript}],
        output_config={"format": {"type": "json_schema", "schema": _OUTPUT_SCHEMA}},
    )

    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)
    title = parsed.get("title", "").strip()
    if not title:
        raise ValueError("Claude returned an empty title")

    if len(title) > _MAX_TITLE_CHARS:
        title = _truncate_on_space(title, _MAX_TITLE_CHARS)

    return title


def _truncate_on_space(text: str, limit: int) -> str:
    """Trim `text` to at most `limit` chars, breaking on the last space.

    Falls back to a hard cut if there's no space under the limit (e.g. a
    single long word). Strips trailing whitespace from the result.
    """
    if len(text) <= limit:
        return text
    head = text[:limit]
    last_space = head.rfind(" ")
    if last_space == -1:
        return head.rstrip()
    return head[:last_space].rstrip()
