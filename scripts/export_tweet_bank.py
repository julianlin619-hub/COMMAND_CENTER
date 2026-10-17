"""Export the live tweet_bank table (Supabase) to a CSV.

Why this exists: since 2026-08-17 the master tweet bank lives in the
`tweet_bank` table, which the threads cron grows daily from its Apify
scrape. data/TweetMasterBank.csv is only the historical seed and is NOT
kept current, so anyone who wants "the bank as it is right now" needs to
dump the table. This script does exactly that and nothing else.

Usage (needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment,
same as every cron — see .env.example):

    python scripts/export_tweet_bank.py                # -> data/tweet_bank_export.csv
    python scripts/export_tweet_bank.py out/bank.csv   # custom path

Columns written: tweet_id, text, favorite_count, created_at.
`created_at` is when the row entered the bank (the seed backfill rows all
share the migration date), NOT when the tweet was posted — the table
doesn't store tweet publish dates. The embedding column is deliberately
left out: 1536 floats per row would make the file ~50x larger and nobody
reads vectors in a spreadsheet.
"""

import csv
import logging
import sys

from core.database import get_client

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# Supabase caps a single select at 1000 rows, so we page through the table.
# Same pattern as scripts/embed_tweet_bank.py.
PAGE_SIZE = 1000
COLUMNS = ["tweet_id", "text", "favorite_count", "created_at"]


def fetch_all_rows() -> list[dict]:
    client = get_client()
    rows: list[dict] = []
    page = 0
    while True:
        res = (
            client.table("tweet_bank")
            .select(",".join(COLUMNS))
            # Newest additions first so the top of the CSV shows what the
            # daily sync has pulled in most recently.
            .order("created_at", desc=True)
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
            .execute()
        )
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
    return rows


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "data/tweet_bank_export.csv"
    rows = fetch_all_rows()

    # newline="" is required by the csv module so multi-line tweet text is
    # quoted correctly instead of producing broken rows on Windows.
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    newest = rows[0]["created_at"] if rows else "n/a"
    logger.info("Wrote %d tweets to %s (newest row added %s)", len(rows), out_path, newest)


if __name__ == "__main__":
    main()
