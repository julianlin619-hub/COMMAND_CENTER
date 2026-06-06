"""One-time backfill: embed data/TweetMasterBank.csv into the tweet_bank table.

The batch-video caption RAG (core/caption_rag.py) finds the tweet whose
sentiment best matches a video transcript by cosine similarity over embeddings
stored in Postgres (pgvector). Those embeddings have to exist first — this
script computes them once.

Run it after applying the video_batch migration:
    python scripts/embed_tweet_bank.py

Idempotent: it skips tweets already present (matched on tweet_id), so it's safe
to re-run after adding rows to the CSV or if a previous run was interrupted.

Requires OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY in the env.
"""

from __future__ import annotations

import csv
import logging
import os
import sys

from core.database import get_client
from core.embeddings import EMBEDDING_DIM, embed_batch

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# How many tweets to embed per OpenAI request. The embeddings endpoint accepts
# large batches; 200 keeps each request well under token limits while cutting
# round-trips for ~18K rows to ~90 calls.
_BATCH_SIZE = 200


def _read_rows(bank_path: str) -> list[dict]:
    """Read tweet_id / text / favorite_count from the bank CSV.

    Column detection mirrors core/content_sources.select_bank_content_with_likes
    so this stays in step with how the rest of the app reads the bank. The CSV's
    tweet_id values carry a trailing apostrophe (a sheets-export artifact) which
    we strip, matching that function.
    """
    rows: list[dict] = []
    with open(bank_path, encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return []
        lowered = [h.strip().lower() for h in header]
        text_col = lowered.index("text") if "text" in lowered else 1
        id_col = lowered.index("tweet_id") if "tweet_id" in lowered else 0
        likes_col = (
            lowered.index("favorite_count") if "favorite_count" in lowered else 2
        )
        for row in reader:
            if len(row) <= max(text_col, id_col, likes_col):
                continue
            text = row[text_col].strip()
            if not text:
                continue
            try:
                likes = int(row[likes_col].strip())
            except (ValueError, IndexError):
                likes = None
            rows.append(
                {
                    "tweet_id": row[id_col].strip().rstrip("'"),
                    "text": text,
                    "favorite_count": likes,
                }
            )
    return rows


def main() -> None:
    bank_path = os.environ.get("CONTENT_BANK_PATH", "data/TweetMasterBank.csv")
    if not os.path.exists(bank_path):
        logger.error("Content bank not found: %s", bank_path)
        sys.exit(1)

    client = get_client()

    # Pull existing tweet_ids so re-runs only embed the gaps. Paginate because
    # Supabase caps select page size; the bank is ~18K rows.
    existing: set[str] = set()
    page = 0
    while True:
        res = (
            client.table("tweet_bank")
            .select("tweet_id")
            .range(page * 1000, page * 1000 + 999)
            .execute()
        )
        batch = res.data or []
        existing.update(r["tweet_id"] for r in batch)
        if len(batch) < 1000:
            break
        page += 1
    logger.info("Found %d tweets already embedded", len(existing))

    rows = [r for r in _read_rows(bank_path) if r["tweet_id"] not in existing]
    logger.info("Embedding %d new tweets (dim=%d)", len(rows), EMBEDDING_DIM)
    if not rows:
        logger.info("Nothing to do.")
        return

    inserted = 0
    for start in range(0, len(rows), _BATCH_SIZE):
        chunk = rows[start : start + _BATCH_SIZE]
        vectors = embed_batch([r["text"] for r in chunk])
        payload = [
            {
                "tweet_id": r["tweet_id"],
                "text": r["text"],
                "favorite_count": r["favorite_count"],
                "embedding": vec,
            }
            for r, vec in zip(chunk, vectors, strict=True)
        ]
        # upsert on tweet_id so a partial previous run (or a duplicate id in
        # the CSV) updates rather than erroring on the unique constraint.
        client.table("tweet_bank").upsert(payload, on_conflict="tweet_id").execute()
        inserted += len(payload)
        logger.info("Embedded %d/%d", inserted, len(rows))

    logger.info("Done. Embedded %d tweets.", inserted)


if __name__ == "__main__":
    main()
