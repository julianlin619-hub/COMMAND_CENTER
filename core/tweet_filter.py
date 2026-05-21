"""Decide whether an Apify-sourced tweet is "postable" as a standalone quote card.

The LinkedIn-Leila cron renders each fresh @LeilaHormozi tweet onto a
1080×1080 square image and queues it on Buffer. That image stands alone —
no thread context, no link preview, no parent tweet. Anything Apify returns
that isn't a complete, self-contained piece of Leila's writing reads as
junk on LinkedIn.

Examples of junk that triggered this module:
  - `RT @AlexHormozi: …` — retweets carry someone else's voice and the
    "RT @handle:" prefix looks terrible on a quote card.
  - `Check this out https://t.co/xyz` — the link target is gone once you
    strip the tweet onto a square; the post becomes a dangling reference.
  - `My assistant lost $20,000…` — clearly the caption of a screenshot
    quote-tweet, truncated and meaningless without the image it cited.

Two-stage filter:

  Stage 1 — cheap regex pass. Catches the obvious patterns above with no
  network call. Reuses the same hyperlink regex as
  `cron/threads_leila_cron.py` so the two pipelines stay consistent on
  what counts as a "link-bearing" tweet.

  Stage 2 — Claude semantic judge. Reached only for tweets that pass the
  regex pass. Decides whether the text reads as a complete standalone
  thought from Leila Hormozi, or whether it's a fragment / reply /
  screenshot caption that regex couldn't catch.

Errors from the Anthropic SDK propagate — the caller treats failure as
"skip this tweet" so a flaky API key or rate limit doesn't fan out into
a flood of unfiltered posts. Same philosophy as
`core/youtube_title_generator.py:errors propagate to the caller`.
"""

from __future__ import annotations

import json
import logging
import re

import anthropic

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — regex heuristics
# ─────────────────────────────────────────────────────────────────────────────

# Same hyperlink pattern as cron/threads_leila_cron.py:75-78. Catches:
#   - http:// or https:// followed by any non-whitespace
#   - www. followed by a domain-ish token
#   - bare t.co/... shortlinks (defensive; Apify usually includes the
#     https:// prefix but has occasionally stripped it)
_HYPERLINK_RE = re.compile(
    r"(https?://\S+|www\.\S+|\bt\.co/\S+)",
    re.IGNORECASE,
)

# Retweet prefix as Apify returns it (raw tweet body). Case-insensitive
# because some scraper versions normalize "Rt @" / "rt @" differently.
_RETWEET_RE = re.compile(r"^\s*RT\s+@", re.IGNORECASE)

# Quote-card text needs enough body to look intentional on a 1080×1080
# canvas. Anything shorter than this is almost always a reply fragment
# ("yes", "exactly this", "lol same"). Tuned by eye against past Leila
# posts — her shortest standalone-quotable tweets sit around 30-40 chars,
# so 25 is a conservative floor.
_MIN_TWEET_CHARS = 25


def _regex_reject(text: str) -> str | None:
    """Return a short reason tag if regex rejects the tweet, else None.

    Order matters — more specific patterns come first so the reason tag
    in the log line is the most useful one ("retweet" beats "too_short"
    for `RT @x: hi`).
    """
    stripped = text.strip()
    if not stripped:
        return "empty"
    if _RETWEET_RE.match(stripped):
        return "retweet"
    if _HYPERLINK_RE.search(stripped):
        return "hyperlink"
    # Both ASCII triple-dot and Unicode ellipsis (U+2026). Apify has
    # returned both depending on whether Twitter's own truncation or the
    # author's typed text is at the end.
    if stripped.endswith("...") or stripped.endswith("…"):
        return "truncated"
    if len(stripped) < _MIN_TWEET_CHARS:
        return "too_short"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Claude semantic judge
# ─────────────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You decide whether a tweet from Leila Hormozi (@LeilaHormozi, founder of Acquisition.com) is ready to be rendered as a standalone 1080×1080 quote-card image on LinkedIn.

The card shows only the tweet text — no thread context, no parent tweet, no link preview, no images. The viewer sees one self-contained block of writing on a black background.

## Your job

Return JSON: `{"keep": boolean, "reason": "short_tag"}`.

KEEP if the tweet reads as a complete, self-contained statement, observation, piece of advice, or rhetorical question that Leila could have written as a standalone LinkedIn post.

REJECT if the tweet is any of:

1. **A fragment of a longer tweet or thread** — starts mid-sentence, ends on a cliffhanger, or references "it" / "that" / "this" / "they" with no antecedent inside the tweet itself.
2. **A reply that only makes sense given the parent tweet** — answering a question we can't see, or agreeing with a statement we can't see ("yes exactly", "this is so true", "agreed 100%").
3. **A caption for an image or screenshot that isn't carrying over** — phrases like "look at this", "see below", "👇", or text that's clearly pointing at something the LinkedIn viewer won't see.
4. **A retweet body without the RT @ prefix** — content that's quoting someone else's words rather than being Leila's own writing.
5. **A back-and-forth quote-tweet snippet** — text that only makes sense paired with the tweet it's quoting.

## Examples

KEEP — `{"keep": true, "reason": "complete"}`:
- "Hire slow, fire fast. Every founder learns this the hard way."
- "The hardest part of scaling isn't the work. It's saying no to good opportunities so you can say yes to great ones."
- "If your team can't run the business without you for two weeks, you don't own a business — you own a job."

REJECT — `{"keep": false, "reason": "<tag>"}`:
- "and that's why you have to do it anyway" → `fragment`
- "yes this is exactly what I mean" → `reply`
- "look at this 👇" → `caption`
- "@founderhabits said it best — 'the best founders treat every hire like it's their first'" → `quoting_others`

## Output format

Return a single JSON object with `keep` (boolean) and `reason` (short snake_case tag). No prose, no explanation, no other fields."""

_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "keep": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["keep", "reason"],
    "additionalProperties": False,
}


def _llm_judge(
    text: str,
    *,
    client: anthropic.Anthropic,
) -> tuple[bool, str]:
    """Ask Claude whether `text` reads as a clean standalone tweet.

    Returns (keep, reason_tag). Raises on SDK error, malformed JSON, or
    missing schema fields — the caller decides whether to skip or retry.
    Matches the propagation policy in core/youtube_title_generator.py.
    """
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=128,
        thinking={"type": "disabled"},
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": text}],
        output_config={"format": {"type": "json_schema", "schema": _OUTPUT_SCHEMA}},
    )

    raw = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(raw)
    keep = bool(parsed["keep"])
    reason = str(parsed.get("reason", "")).strip() or ("complete" if keep else "rejected")
    return keep, reason


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def is_postable_tweet(
    text: str,
    *,
    client: anthropic.Anthropic | None = None,
) -> tuple[bool, str]:
    """Return (is_postable, reason_tag) for a single tweet body.

    Stage 1 — regex heuristics. If any fire, return immediately with the
    matched reason tag (`empty`, `retweet`, `hyperlink`, `truncated`,
    `too_short`). No LLM call is made in this path, so junk tweets are
    cheap to filter.

    Stage 2 — Claude semantic judge. Only reached when regex passes. The
    LLM tags survivors with `complete` (keep) or one of `fragment`,
    `reply`, `caption`, `quoting_others`, `rejected` (drop).

    Pass `client` to inject a mock in tests. In production we lazily
    construct an `anthropic.Anthropic()` which reads `ANTHROPIC_API_KEY`
    from env. SDK errors propagate — the cron caller logs and skips the
    tweet rather than treating failure as implicit pass.
    """
    regex_reason = _regex_reject(text)
    if regex_reason is not None:
        return False, regex_reason

    if client is None:
        client = anthropic.Anthropic()

    return _llm_judge(text, client=client)
