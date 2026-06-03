"""LLM-based sanity check for threads bank posts before they're queued to Buffer.

The threads content bank (TweetMasterBank.csv) was built from tweet data. Some
tweets are the *hook* for a long thread — e.g. "7 ways to get rich" — but the
actual tips only exist as reply tweets that were NOT captured in the bank. When
that hook ships to Threads as a standalone post it reads as an unfulfilled
promise: the audience is promised 7 things and gets zero.

This module runs each bank post through Claude Sonnet before we insert it into
Supabase. Claude plays fact-checker: does this post work as a complete,
self-contained piece of content, or does it dangle a list / thread / link that
the reader will never see?

Design is intentionally modelled on core/tweet_filter.py (the LinkedIn quote-card
filter) — same two-stage approach: cheap regex first, LLM only when regex passes.

Error handling: SDK errors propagate. The caller in threads_cron.py catches them,
logs, and *skips* the post. We'd rather drop a borderline post than let a bad
API key flood Buffer with junk (same policy as tweet_filter.py).
"""

from __future__ import annotations

import json
import logging
import re

import anthropic

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — cheap regex heuristics (no LLM call)
# ─────────────────────────────────────────────────────────────────────────────

# Threads doesn't render link previews for raw URLs, so a post that's just a
# URL (or ends with one) is useless. This re-uses the same pattern as
# tweet_filter.py for consistency.
_HYPERLINK_RE = re.compile(
    r"(https?://\S+|www\.\S+|\bt\.co/\S+)",
    re.IGNORECASE,
)

# Retweet prefix — a bank post that starts with "RT @" was mis-sourced and
# carries someone else's voice.
_RETWEET_RE = re.compile(r"^\s*RT\s+@", re.IGNORECASE)

# A post that ends with "..." or "…" was almost certainly truncated. The bank
# captures the tweet text but not the replies — so the reader will never see
# the continuation.
_TRUNCATED_RE = re.compile(r"(\.{3}|…)\s*$")

# A post shorter than this is almost certainly a reply fragment or noise.
# Tuned conservatively — the shortest real standalone bank entries are around
# 30 chars (e.g. "Execution beats ideas every time.").
_MIN_CHARS = 25


def _regex_reject(text: str) -> str | None:
    """Return a short reason tag if regex rejects the post, else None."""
    stripped = text.strip()
    if not stripped:
        return "empty"
    if _RETWEET_RE.match(stripped):
        return "retweet"
    if _HYPERLINK_RE.search(stripped):
        return "hyperlink"
    if _TRUNCATED_RE.search(stripped):
        return "truncated"
    if len(stripped) < _MIN_CHARS:
        return "too_short"
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Claude semantic judge
# ─────────────────────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """You review text scraped from tweets that is about to be posted on Threads (Meta's Instagram-based Twitter alternative). Your job is a *completeness* sanity check — not style, grammar, or brand fit.

The post will appear as a standalone Threads post with NO replies and NO thread context. The audience sees only this one text block.

## Your job

Return JSON: {"keep": boolean, "reason": "short_tag"}.

KEEP if the post is a complete, self-contained piece of content that works on its own. It does not have to be profound — it just has to make sense and feel finished to someone who has never seen the original tweet thread.

REJECT if the post:

1. **Promises a list it doesn't deliver** — says "X ways to Y", "X tips for Z", "X reasons why", "here are X things", or similar but does NOT include those items in the text itself. The reader was promised content they won't get.
2. **Refers to something not present** — uses phrases like "see below", "thread below", "check the replies", "👇", "in the replies", "full breakdown below", or points at an image/video/link that isn't there.
3. **Is clearly the intro hook of a multi-tweet thread** — starts a story or list and then stops, expecting the reader to keep scrolling to replies that don't exist.
4. **Is a dangling fragment** — starts mid-sentence, or the only sentence references "it" / "this" / "that" / "them" with no antecedent in the post itself.
5. **Is a reply-style response** — answers a question, agrees with someone, or reacts to something the reader can't see ("yes exactly", "this is so true", "that's what I said").

## Examples

KEEP — {"keep": true, "reason": "complete"}:
- "Execution beats ideas every time. The market doesn't care about your vision — only your results."
- "The hardest part of scaling is saying no to good opportunities so you can say yes to great ones."
- "Most people quit right before the compound interest kicks in."
- "7 ways to get rich:\n1. Build equity\n2. …\n[all 7 listed]"  ← list fulfilled inside the post

REJECT — {"keep": false, "reason": "<tag>"}:
- "7 ways to get rich" (no list follows) → "unfulfilled_list"
- "Here are 5 lessons I learned the hard way 👇" → "thread_hook"
- "See the thread below for the full breakdown" → "points_offscreen"
- "and that's why it always fails" → "fragment"
- "yes this is exactly what I was talking about" → "reply"

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


def _llm_judge(text: str, *, client: anthropic.Anthropic) -> tuple[bool, str]:
    """Ask Claude whether `text` is a complete standalone Threads post.

    Returns (keep, reason_tag). Raises on SDK error or malformed JSON — the
    caller decides whether to skip or crash. Follows the same propagation
    policy as core/tweet_filter.py._llm_judge.
    """
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=128,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": text}],
    )

    # Extract the text block from the response. The model returns plain JSON
    # because the system prompt instructs it to — we don't use structured
    # output here for simplicity (same pattern as tweet_filter.py).
    raw = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(raw)
    keep = bool(parsed["keep"])
    reason = str(parsed.get("reason", "")).strip() or ("complete" if keep else "rejected")
    return keep, reason


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def is_postable_bank_post(
    text: str,
    *,
    client: anthropic.Anthropic | None = None,
) -> tuple[bool, str]:
    """Return (is_postable, reason_tag) for a single bank post body.

    Stage 1 — regex heuristics. Cheap. Returns immediately if the post is
    obviously junk (empty, retweet, hyperlink-only, truncated, too short).

    Stage 2 — Claude semantic judge. Only reached when regex passes. Checks
    whether the post is self-contained and complete (no unfulfilled lists,
    no dangling thread hooks, no off-screen references).

    Args:
        text: The raw post text from the content bank.
        client: Inject a mock anthropic.Anthropic in tests. In production,
            leave as None and the SDK reads ANTHROPIC_API_KEY from the env.

    Returns:
        (True, "complete") to accept, or (False, reason_tag) to reject.
    """
    regex_reason = _regex_reject(text)
    if regex_reason is not None:
        return False, regex_reason

    if client is None:
        client = anthropic.Anthropic()

    return _llm_judge(text, client=client)
