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

_SYSTEM_PROMPT = """You write YouTube video titles for the Alex Hormozi Highlights channel — short clips (30s–3min) pulled from longer Hormozi content.

Your job: read the transcript and return ONE title that would make someone stop scrolling.

## The #1 rule: steal the moment, don't summarize the topic

Every great title comes from one specific moment in the transcript — a number, a surprising claim, a counter-intuitive line, or something the viewer would say out loud to themselves after hearing it.

Bad process: "This clip is about scaling, so I'll write a scaling title."
Good process: "The most surprising line in this transcript was ______. How do I make that the title?"

**If the transcript already contains a punchy, quotable line, use it verbatim or lightly trimmed. Do not rewrite it.**

Example:
- Transcript: "Buy time like a rich person, buy stuff like a poor person."
- Bad title: "How to Think About Time and Money Differently"
- Good title: "Buy Time Like a Rich Person, Buy Stuff Like a Poor Person"

Before writing, scan for:
- A sentence that would make you stop scrolling if you saw it as a title
- The single most surprising or counter-intuitive claim
- Any specific number, dollar amount, or timeframe
- What the viewer would say out loud after hearing this ("Wait, so you're saying...")

## The 6 formulas that work (pick one)

1. **Direct address** — "You [feel/are/need/can] [specific thing]"
   - You Need to Work 100x Harder
   - You're Wasting 80% of Your Time
   - You Don't Need an Upsell

2. **Spoken quote / real question** — exact words the viewer would recognize as their own
   - "I'm Broke, What Business Do I Start?"
   - "Why Am I Making No Profit?"
   - "Should I Quit My Business?"

3. **Why + painful insight** — names something the viewer suspects but can't articulate
   - Why Most People Don't Win
   - Why You're Not Winning (You're Distracted)
   - Why Ambitious People Stay Mediocre

4. **Number + result** — specific figure + concrete payoff
   - 1 Habit That Fixes 90% of Problems
   - One Solution That Solves 99% of Problems

5. **How to + specific outcome** — use ONLY for universal lessons any viewer could apply
   - How to Stay Focused
   - How to Win with AI in 2026
   - How to Get in Shape

6. **Short gut punch / command** — direct, bold, confrontational
   - Act with Urgency
   - Just do MORE
   - Cut the Bottom 10%
   - Ads Have Changed Forever

## Rules (non-negotiable)

1. **Length**: target ≤60 characters. Never exceed 100.
2. **Ground in the transcript**: every title must trace to a specific line or number in THIS transcript. If you can't point to where it came from, rewrite.
3. **Plain language**: use the viewer's words, not jargon. If a phrase requires insider knowledge to understand, rewrite it.
4. **Self-contained**: a stranger must understand what the clip delivers with zero context. Cover the thumbnail, read only the title — does it land?
5. **Strong first word**: You / How / Why / a number / a verb command.
6. **Direct voice**: sound like Hormozi — blunt, slightly contrarian. Not like a LinkedIn post. Read it out loud — would he say this directly to someone's face?

## Banned patterns

- Vague teasers: "...for a reason", "...will surprise you", "...you won't believe"
- Empty hype: "secret", "insane", "crazy", "life-changing"
- Softeners: "just", "simply", "maybe", "might"
- Topic summaries: "Tips for X", "How to think about Y"
- Clickbait question marks on generic questions: "Did you know...?"
- Emoji, all-caps screaming, engagement-bait punctuation
- "Helping [business]" frame — this channel doesn't have the guest context to make those work

## Output format

Return a single JSON object: `{"title": "..."}`. No prose, no explanation, no other fields."""

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
