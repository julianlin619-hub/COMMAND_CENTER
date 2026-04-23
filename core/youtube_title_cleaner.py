"""Clean up raw YouTube video titles for publication.

Two steps:

  1. Regex strip (deterministic, local)
     Keep letters, digits, whitespace, and common English title punctuation
     (apostrophes, hyphens, colons, commas, periods, question marks,
     exclamation marks). Drop everything else — emoji, hashtags, pipes, em
     dashes, and other stylistic junk. Collapse runs of whitespace. Trim.

  2. Claude Sonnet pass (semantic)
     Send the regex-cleaned string to Claude Sonnet 4.6 with instructions to
     remove internal version markers that survived the regex pass — things
     like "V4", "Final", "Draft", "WIP", "edit2" — while preserving real
     content ("Top 10 Tips", "Part III"). The model returns JSON
     (`{"cleaned_title": "..."}`) so parsing is never ambiguous.

If the Sonnet call fails for any reason (missing API key, network blip,
rate limit), we log a WARNING and fall back to the regex-cleaned string.
Title cleanup must never block scheduling — a slightly-less-clean title is
strictly better than a failed cron run.

Notes on design choices:
  * No prompt caching — titles are short and always different, and the
    system prompt is nowhere near the 2048-token minimum for Sonnet 4.6.
    Caching would cost more than it saves.
  * Thinking is disabled — title cleanup doesn't benefit from reasoning,
    and disabling thinking cuts latency and cost.
  * output_config.format with a JSON schema guarantees a parseable result.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass

import anthropic

logger = logging.getLogger(__name__)

# Allow alphanumerics (including Unicode letters via \w), whitespace, and the
# punctuation marks real English YouTube titles actually use. Hyphen is
# escaped for safety even though it's at the end of the class.
_DISALLOWED = re.compile(r"[^\w\s'\-:,.?!]", flags=re.UNICODE)
_WS_RUN = re.compile(r"\s+")

_SYSTEM_PROMPT = """You clean up YouTube video titles for publication.

Your ONLY job: remove internal version markers that snuck into the title.
Remove tokens like: V1, V2, V4, v2, Final, FINAL, Final2, Draft, WIP, edit, edit2, cut, cut3, rev, rough, rough1.
Do NOT remove: real numbers in the title (e.g. "Top 10 Tips"), Roman numerals that belong to the title (e.g. "Part III"), or short legitimate words that happen to look like markers in isolation but fit the surrounding title.

Rules (non-negotiable):
  1. Preserve the EXACT capitalization of every letter you keep. "Destroy" stays "Destroy". "ADD" stays "ADD". "doesnt" stays "doesnt". Never change a letter's case for any reason.
  2. Preserve all punctuation and apostrophes from the input exactly as written.
  3. Preserve word order and spelling. Do not paraphrase, reword, pluralize, or fix anything.
  4. If the title has no version markers, return it UNCHANGED, byte-for-byte.
  5. If in doubt whether something is a marker or real content, KEEP IT.
  6. Collapse any double spaces left behind by a removal; otherwise preserve whitespace.
  7. Never return an empty string if the input was non-empty.

Examples (input → cleaned_title):
  "My Video V4 Final"                      → "My Video"
  "Top 10 Productivity Tips"               → "Top 10 Productivity Tips"
  "Having ADD Doesn't Have to Destroy You" → "Having ADD Doesn't Have to Destroy You"
  "Interview Draft2 with Sarah"            → "Interview with Sarah"

Return JSON with a single field `cleaned_title`."""

_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"cleaned_title": {"type": "string"}},
    "required": ["cleaned_title"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class CleanedTitle:
    original: str
    regex_cleaned: str
    final: str  # after Sonnet, or == regex_cleaned if Sonnet was skipped/failed
    sonnet_applied: bool


def _regex_clean(raw: str) -> str:
    """Strip disallowed characters; collapse whitespace; trim.

    Keeps: word characters (incl. Unicode letters), whitespace, and the
    English title punctuation `' - : , . ? !`. Drops everything else.
    """
    stripped = _DISALLOWED.sub("", raw)
    collapsed = _WS_RUN.sub(" ", stripped)
    return collapsed.strip()


def _call_sonnet(regex_cleaned: str, *, client: anthropic.Anthropic | None = None) -> str:
    """Ask Claude Sonnet to remove internal version markers.

    Raises on any SDK error — the caller catches and falls back.
    """
    if client is None:
        client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=256,
        thinking={"type": "disabled"},
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": regex_cleaned}],
        output_config={"format": {"type": "json_schema", "schema": _OUTPUT_SCHEMA}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)
    cleaned = parsed["cleaned_title"].strip()
    # Belt-and-braces: if Sonnet returns something suspiciously empty, keep the regex output.
    if not cleaned:
        raise ValueError("Sonnet returned empty cleaned_title")
    return cleaned


def clean_title(
    raw: str,
    *,
    client: anthropic.Anthropic | None = None,
) -> CleanedTitle:
    """Clean a raw YouTube title. Always returns; never raises.

    If `ANTHROPIC_API_KEY` is missing or the API call fails, falls back to
    the regex-cleaned string and logs a WARNING. Pass `client` in tests to
    inject a mock.
    """
    regex_cleaned = _regex_clean(raw)

    # Nothing meaningful left — skip the API call entirely.
    if not regex_cleaned:
        return CleanedTitle(
            original=raw, regex_cleaned="", final="", sonnet_applied=False
        )

    # No API key → skip cleanly and log once per call. Explicit check beats
    # waiting for anthropic.Anthropic() to raise AuthenticationError at
    # request time, which happens inside the retry-ready call path.
    if client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        logger.warning(
            "ANTHROPIC_API_KEY not set — falling back to regex-only title cleanup."
        )
        return CleanedTitle(
            original=raw,
            regex_cleaned=regex_cleaned,
            final=regex_cleaned,
            sonnet_applied=False,
        )

    try:
        final = _call_sonnet(regex_cleaned, client=client)
        return CleanedTitle(
            original=raw,
            regex_cleaned=regex_cleaned,
            final=final,
            sonnet_applied=True,
        )
    except Exception as exc:
        logger.warning(
            "Sonnet title cleanup failed, falling back to regex-cleaned title: %s",
            exc,
        )
        return CleanedTitle(
            original=raw,
            regex_cleaned=regex_cleaned,
            final=regex_cleaned,
            sonnet_applied=False,
        )
