"""Pick a caption for a video by matching its transcript against the tweet bank.

The batch-upload pathway captions each video with a real tweet from the bank —
specifically the one whose sentiment most closely matches what's said in the
video. We do this with a standard RAG lookup:

  1. Embed the transcript (OpenAI, via core.embeddings).
  2. Ask Postgres (pgvector) for the nearest tweets by cosine similarity, via
     the match_tweet_bank RPC defined in the video_batch migration.
  3. Among that top-k, pick the highest-engagement tweet — so the caption is
     both on-sentiment AND a proven strong line, not a low-like near-miss.

The bank must be embedded first (scripts/embed_tweet_bank.py). If it's empty
the RPC returns nothing and pick_caption raises, which surfaces as a failed
job rather than a silently captionless post.
"""

from __future__ import annotations

import logging

from core.database import get_client
from core.embeddings import embed

logger = logging.getLogger(__name__)

# How many nearest tweets to retrieve before applying the engagement tie-break.
# 10 is a small enough neighbourhood that everything in it is genuinely
# on-topic, but wide enough that we can prefer a stronger line within it.
_TOP_K = 10

# text-embedding-3-small has an ~8191-token input ceiling; OpenAI rejects
# anything longer with a 400. English text averages ~4 chars/token, so we cap
# the transcript well under that (~6K tokens) before embedding. A multi-minute
# clip can transcribe to more than this, and the opening of the transcript
# carries the sentiment we're matching on, so a head-truncate is a fine proxy —
# far better than letting the whole upload fail on an over-length input.
_MAX_TRANSCRIPT_CHARS = 24000


def pick_caption(transcript: str) -> str:
    """Return the bank tweet text that best fits the transcript's sentiment.

    Raises ValueError on empty input and RuntimeError if the bank has no
    matches (e.g. it hasn't been embedded yet).
    """
    if not transcript or not transcript.strip():
        raise ValueError("transcript is empty")

    # Truncate before embedding so a long transcript can't blow the embedding
    # model's token limit (which would 400 and fail the job).
    embed_input = transcript[:_MAX_TRANSCRIPT_CHARS]
    if len(transcript) > _MAX_TRANSCRIPT_CHARS:
        logger.info(
            "Transcript truncated %d → %d chars for embedding",
            len(transcript), _MAX_TRANSCRIPT_CHARS,
        )

    query_embedding = embed(embed_input)

    client = get_client()
    result = client.rpc(
        "match_tweet_bank",
        {"query_embedding": query_embedding, "match_count": _TOP_K},
    ).execute()

    matches = result.data or []
    if not matches:
        raise RuntimeError(
            "match_tweet_bank returned no tweets — is the tweet_bank table "
            "embedded? Run scripts/embed_tweet_bank.py."
        )

    # Among the closest-by-sentiment tweets, prefer the highest-engagement one.
    # favorite_count can be NULL in the bank, so coerce to 0 for the sort key.
    best = max(matches, key=lambda m: m.get("favorite_count") or 0)
    logger.info(
        "Caption picked: tweet %s (%s likes, similarity %.3f): %.60s",
        best.get("tweet_id"),
        best.get("favorite_count"),
        best.get("similarity") or 0.0,
        best.get("text", ""),
    )
    return best["text"]
