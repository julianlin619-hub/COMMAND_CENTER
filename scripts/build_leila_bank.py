"""Build data/LeilaTweetBank.csv — a bank of old, postable @LeilaHormozi tweets.

Why this exists: the linkedin-leila cron posts one fresh tweet a day, but her
recent tweets get used up quickly (the scraper only reaches ~40-140 tweets per
call). This script pages backward through her history with the same dedup +
filter the cron uses (`_select_postable`), and stops once it has TARGET usable
tweets. The cron then draws from this CSV when the last 24h has nothing new.

Run from the repo root with the cron's env vars loaded (APIFY_API_KEY,
SUPABASE_URL/SERVICE_KEY, ANTHROPIC_API_KEY):

    set -a; . ./.env; set +a
    python -m scripts.build_leila_bank            # build up to 100
    TARGET=150 python -m scripts.build_leila_bank

Re-running is safe: tweets already in the CSV are kept, and only the missing
count is topped up.
"""

import csv
import logging
import os
from datetime import timedelta
from pathlib import Path

from core.content_sources import _parse_apify_datetime, fetch_apify_tweets
from cron.linkedin_leila_cron import _select_postable

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

BANK_PATH = Path(__file__).resolve().parent.parent / "data" / "LeilaTweetBank.csv"
FIELDS = ["tweet_id", "text", "favorite_count", "created_at"]
TARGET = int(os.environ.get("TARGET", "100"))
# Each round is one Apify run (~140 tweets). Hard cap so a bad day can't run
# up an unbounded bill.
MAX_ROUNDS = int(os.environ.get("MAX_ROUNDS", "12"))
HANDLE = os.environ.get("APIFY_LEILA_TWITTER_HANDLE", "LeilaHormozi")


def _load_existing() -> list[dict]:
    if not BANK_PATH.exists():
        return []
    with BANK_PATH.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main() -> None:
    bank = _load_existing()
    seen_ids = {row["tweet_id"] for row in bank}
    logger.info("Starting with %d tweets already in the bank (target %d)", len(bank), TARGET)

    until: str | None = None
    for round_no in range(MAX_ROUNDS):
        if len(bank) >= TARGET:
            break
        tweets = fetch_apify_tweets(
            HANDLE, max_items=300, hours_lookback=None, until_date=until
        )
        if not tweets:
            logger.warning("Round %d returned no tweets — stopping", round_no)
            break

        fresh = [t for t in tweets if t["id"] not in seen_ids]
        # wide=False keeps EVERY postable tweet in the batch (wide=True would
        # stop at the first). Dedups against already-queued posts and runs
        # the regex + Claude filter.
        postable, dups, filtered = _select_postable(fresh, wide=False)
        for t in postable:
            if len(bank) >= TARGET:
                break
            seen_ids.add(t["id"])
            bank.append({
                "tweet_id": t["id"],
                "text": t["text"],
                "favorite_count": t["like_count"],
                "created_at": t["created_at"],
            })
        logger.info(
            "Round %d (until=%s): %d tweets, %d postable, %d already posted, %d filtered -> bank=%d",
            round_no, until, len(tweets), len(postable), dups, filtered, len(bank),
        )

        # tweets is newest-first, so the last one is the oldest. `until:`
        # excludes the named day, hence +1 day (see the cron's wide fallback).
        oldest = _parse_apify_datetime(tweets[-1]["created_at"])
        if oldest is None:
            break
        next_until = (oldest + timedelta(days=1)).strftime("%Y-%m-%d")
        if until is not None and next_until >= until:
            logger.warning("Window stopped moving at %s — no older tweets", until)
            break
        until = next_until

    BANK_PATH.parent.mkdir(exist_ok=True)
    with BANK_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(bank)
    logger.info("Wrote %d tweets to %s", len(bank), BANK_PATH)


if __name__ == "__main__":
    main()
