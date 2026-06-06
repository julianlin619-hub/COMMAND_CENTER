"""OpenAI text embeddings via httpx.

One small module so there's a single embedding implementation shared by both
sides of the RAG feature:
  * scripts/embed_tweet_bank.py — one-time backfill of the tweet bank vectors.
  * core/caption_rag.py — embeds a video transcript at upload time to find the
    closest tweet.

We hit OpenAI's REST endpoint directly with httpx (the pattern every other
external call in this repo uses — see core/content_gen_client.py) instead of
pulling in the `openai` SDK. The embeddings endpoint is a single POST; the SDK
would add a dependency for no real benefit.

Model: text-embedding-3-small (1536 dims). If you change the model, update the
vector(1536) dimension in the migration AND re-embed the whole bank — vectors
of different dimensions can't be compared.
"""

from __future__ import annotations

import logging
import os

import httpx

from core.retry import raise_for_retryable_status, with_retry

logger = logging.getLogger(__name__)

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"

# Keep the model name and its dimension together so the one place that needs to
# change on a model swap is obvious. EMBEDDING_DIM must match vector(N) in the
# migration and is exported for the backfill script's sanity check.
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536

# OpenAI embeddings are fast, but the backfill sends large batches — give it a
# generous read window. Single-text calls (the upload path) return in well
# under a second; the timeout is just a safety net against a hung connection.
_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def _api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY env var not set")
    return key


def embed(text: str) -> list[float]:
    """Return the embedding vector for a single piece of text.

    Raises on an empty input or any API/transport error — the caller decides
    whether to skip or fail. We never silently return a zero vector, which
    would quietly poison the nearest-neighbour ranking.
    """
    if not text or not text.strip():
        raise ValueError("Cannot embed empty text")
    return embed_batch([text])[0]


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed many texts in one request. Returns vectors in input order.

    Used by the backfill to amortise HTTP overhead across ~18K tweets. OpenAI
    preserves input order in `data` (and includes an `index` field), but we
    sort by `index` defensively so a future API change can't silently
    misalign a tweet with someone else's vector.
    """
    if not texts:
        return []

    data = _embeddings_request(texts).get("data", [])
    if len(data) != len(texts):
        raise RuntimeError(
            f"OpenAI returned {len(data)} embeddings for {len(texts)} inputs"
        )
    ordered = sorted(data, key=lambda d: d["index"])
    return [item["embedding"] for item in ordered]


@with_retry()
def _embeddings_request(texts: list[str]) -> dict:
    """POST to OpenAI's embeddings endpoint, returning the parsed JSON body.

    Wrapped in @with_retry so a transient OpenAI hiccup (429 rate limit, 5xx,
    or a dropped connection) is retried with backoff rather than failing the
    caller outright — a single transient error used to sink an entire upload or
    a whole backfill chunk. raise_for_retryable_status maps the HTTP status onto
    our exception hierarchy so 429/5xx retry (honoring Retry-After) but a 4xx
    like a bad key fails fast.
    """
    resp = httpx.post(
        OPENAI_EMBEDDINGS_URL,
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
        },
        json={"model": EMBEDDING_MODEL, "input": texts},
        timeout=_TIMEOUT,
    )
    if not resp.is_success:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
        raise_for_retryable_status(
            resp.status_code, retry_after=retry_after, body=resp.text
        )
    return resp.json()


def _parse_retry_after(raw: str | None) -> float | None:
    """Coerce a Retry-After header (seconds) to a float, or None if absent/bad."""
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
