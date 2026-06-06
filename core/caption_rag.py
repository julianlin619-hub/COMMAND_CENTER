"""Pick a caption for a video by matching its transcript against the tweet bank.

The batch-upload pathway captions each video with a real tweet from the bank —
specifically the one whose meaning most closely matches what's said in the
video. We do this with a retrieve-then-rerank RAG lookup:

  1. Embed the transcript (OpenAI, via core.embeddings).
  2. RETRIEVE — ask Postgres (pgvector) for the nearest tweets by cosine
     similarity, via the match_tweet_bank RPC defined in the video_batch
     migration. This is the *recall* step: it returns a small neighbourhood of
     tweets that are all roughly on-topic.
  3. RERANK — hand that top-k neighbourhood to Claude Sonnet 4.6 and ask which
     ONE tweet best matches the transcript's meaning/sentiment. This is the
     *precision* step: embeddings get us close, but the LLM judges actual
     meaning (same core idea, same spirit) rather than mere keyword overlap.

Why two stages instead of just the LLM? Sending all ~5K tweets to the model on
every upload would be slow and expensive. Vector search cheaply narrows the
field to the best handful; the LLM only has to choose among those.

Fallback: if the rerank is unavailable (a transient Anthropic error after
retries, or an unparseable/out-of-range answer) we fall back to the
highest-engagement tweet among the retrieved neighbours rather than failing the
whole upload — every candidate is already on-sentiment, so a strong proven line
is a fine default. Only a genuinely empty bank (RPC returns nothing) is fatal.

The bank must be embedded first (scripts/embed_tweet_bank.py). If it's empty
the RPC returns nothing and pick_caption raises, which surfaces as a failed job
rather than a silently captionless post.
"""

from __future__ import annotations

import json
import logging

import anthropic

from core.database import get_client
from core.embeddings import embed
from core.retry import raise_for_retryable_status, with_retry

logger = logging.getLogger(__name__)

# How many nearest tweets to retrieve before the LLM rerank. 10 is a small
# enough neighbourhood that everything in it is genuinely on-topic, but wide
# enough to give the reranker real choice. Raising it improves the odds the
# perfect tweet is in the candidate set, at the cost of more rerank input tokens.
_TOP_K = 10

# text-embedding-3-small has an ~8191-token input ceiling; OpenAI rejects
# anything longer with a 400. English text averages ~4 chars/token, so we cap
# the transcript well under that (~6K tokens) before embedding. A multi-minute
# clip can transcribe to more than this, and the opening of the transcript
# carries the sentiment we're matching on, so a head-truncate is a fine proxy —
# far better than letting the whole upload fail on an over-length input. The
# same truncated text is fed to the reranker so its judgement matches what we
# actually retrieved on.
_MAX_TRANSCRIPT_CHARS = 24000

# The reranker model. Sonnet 4.6 is the same model the title generator uses —
# fast, strong at this kind of short single-pass judgement. Thinking is disabled
# (picking from a numbered list is not a reasoning-heavy task).
_RERANK_MODEL = "claude-sonnet-4-6"

_RERANK_SYSTEM_PROMPT = """You match a short-form video to the single caption that best fits it.

You are given:
- TRANSCRIPT: a transcript of what is said in the video.
- CANDIDATES: a numbered list of real tweets. They are all already roughly on-topic.

Pick the ONE candidate whose MEANING and SENTIMENT most closely match the transcript — the tweet that expresses the same core idea the video makes, in the same spirit. Prefer a true thematic/semantic match over superficial keyword overlap. Judge on meaning only; do not consider how popular or well-written a tweet is.

Return a single JSON object: {"index": <number>} where <number> is the chosen candidate's number from the list. No prose, no explanation, no other fields."""

_RERANK_SCHEMA = {
    "type": "object",
    "properties": {"index": {"type": "integer"}},
    "required": ["index"],
    "additionalProperties": False,
}


def pick_caption(
    transcript: str,
    *,
    client: anthropic.Anthropic | None = None,
) -> str:
    """Return the bank tweet text that best fits the transcript's meaning.

    Retrieves the top-k nearest tweets by embedding similarity, then asks
    Claude Sonnet 4.6 to pick the best meaning-match among them. Falls back to
    the highest-engagement neighbour if the rerank is unavailable.

    Pass `client` to inject a mock Anthropic client in tests. Raises ValueError
    on empty input and RuntimeError if the bank has no matches at all (e.g. it
    hasn't been embedded yet).
    """
    if not transcript or not transcript.strip():
        raise ValueError("transcript is empty")

    # Truncate before embedding so a long transcript can't blow the embedding
    # model's token limit (which would 400 and fail the job). Reuse the same
    # truncated text for the reranker so it judges on what we retrieved on.
    query_text = transcript[:_MAX_TRANSCRIPT_CHARS]
    if len(transcript) > _MAX_TRANSCRIPT_CHARS:
        logger.info(
            "Transcript truncated %d → %d chars for embedding/rerank",
            len(transcript), _MAX_TRANSCRIPT_CHARS,
        )

    query_embedding = embed(query_text)

    db = get_client()
    result = db.rpc(
        "match_tweet_bank",
        {"query_embedding": query_embedding, "match_count": _TOP_K},
    ).execute()

    matches = result.data or []
    if not matches:
        raise RuntimeError(
            "match_tweet_bank returned no tweets — is the tweet_bank table "
            "embedded? Run scripts/embed_tweet_bank.py."
        )

    # Precision step: let the LLM pick the best meaning-match among the
    # retrieved neighbours. None means "rerank unavailable" → fall back to the
    # engagement heuristic (every candidate is already on-sentiment, so the
    # strongest proven line is a safe default rather than failing the upload).
    chosen = _rerank_by_meaning(query_text, matches, client=client)
    if chosen is None:
        chosen = max(matches, key=lambda m: m.get("favorite_count") or 0)
        logger.warning(
            "Caption rerank unavailable — fell back to highest-engagement match"
        )

    logger.info(
        "Caption picked: tweet %s (%s likes, similarity %.3f): %.60s",
        chosen.get("tweet_id"),
        chosen.get("favorite_count"),
        chosen.get("similarity") or 0.0,
        chosen.get("text", ""),
    )
    return chosen["text"]


def _rerank_by_meaning(
    transcript: str,
    matches: list[dict],
    *,
    client: anthropic.Anthropic | None = None,
) -> dict | None:
    """Return the candidate the LLM judges the best meaning-match, or None.

    None signals pick_caption to fall back to the engagement heuristic. We
    return None (rather than raise) on any rerank problem — a transient API
    failure after retries, an unparseable response, or an out-of-range index —
    because we already hold a set of viable on-sentiment candidates and don't
    want a reranker hiccup to fail an otherwise-good upload.
    """
    if client is None:
        client = anthropic.Anthropic()

    # Number the candidates 1..N for the model; we map its answer back to the
    # dict by that number. Only the tweet text is shown — engagement and
    # similarity are deliberately hidden so the judgement is on meaning alone.
    candidate_lines = "\n".join(
        f"{i}. {m.get('text', '')}" for i, m in enumerate(matches, start=1)
    )
    user_content = f"TRANSCRIPT:\n{transcript}\n\nCANDIDATES:\n{candidate_lines}"

    try:
        response = _create_rerank_message(client, user_content)
    except Exception as e:
        # @with_retry already exhausted its backoff attempts; degrade gracefully.
        logger.error("Caption rerank call failed: %s", e)
        return None

    try:
        text = next(b.text for b in response.content if b.type == "text")
        index = int(json.loads(text)["index"])
    except (StopIteration, KeyError, ValueError, TypeError) as e:
        logger.error("Caption rerank returned unusable output: %s", e)
        return None

    # The model uses 1-based numbering; validate before indexing back.
    if not 1 <= index <= len(matches):
        logger.error(
            "Caption rerank index %s out of range 1..%d", index, len(matches)
        )
        return None

    return matches[index - 1]


@with_retry()
def _create_rerank_message(client: anthropic.Anthropic, user_content: str):
    """Call Claude to rerank, retrying transient failures.

    Mirrors core.youtube_title_generator: wrapped in @with_retry so a transient
    Anthropic blip (429/5xx/dropped connection) is retried with backoff, and an
    APIStatusError is translated into our exception hierarchy so a 429/5xx
    retries while a deterministic 4xx fails fast without burning retries.
    """
    try:
        return client.messages.create(
            model=_RERANK_MODEL,
            max_tokens=64,
            thinking={"type": "disabled"},
            system=_RERANK_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            output_config={"format": {"type": "json_schema", "schema": _RERANK_SCHEMA}},
        )
    except anthropic.APIStatusError as e:
        retry_after = None
        raw = getattr(getattr(e, "response", None), "headers", {}) or {}
        try:
            retry_after = float(raw.get("retry-after")) if raw.get("retry-after") else None
        except (TypeError, ValueError):
            retry_after = None
        raise_for_retryable_status(e.status_code, retry_after=retry_after, body=str(e))
