"""Content sourcing — fetch and generate post content from external sources.

This module pulls content from external sources so it can be turned into
scheduled posts. Currently supports two sources (both ported from the
original THREADS repo at github.com/julianlin619-hub/THREADS):

  1. Apify tweet scraping — fetches recent tweets from any Twitter account
     using the apidojo~tweet-scraper actor on Apify. The original repo
     scraped @AlexHormozi tweets and reposted them to Threads.

  2. Content bank — reads pre-written posts from a single-column CSV file,
     picks random unposted entries, and returns them. The original repo
     called this the "tweet bank."

These functions return raw text. The caller (cron job) is responsible for
creating Post and Schedule records in Supabase so the normal publish
pipeline picks them up.
"""

from __future__ import annotations

import csv
import logging
import os
import random
from datetime import datetime, timedelta, timezone

import httpx

logger = logging.getLogger(__name__)


# ── Apify Tweet Fetching ──────────────────────────────────────────────


def fetch_apify_tweets(
    twitter_handle: str,
    max_items: int = 50,
    hours_lookback: int = 24,
) -> list[dict]:
    """Scrape recent tweets from a Twitter account via Apify.

    Ported from the THREADS repo's /api/fetch-tweets route. Uses the
    apidojo~tweet-scraper actor on Apify.

    Args:
        twitter_handle: Twitter username without the @ (e.g. "AlexHormozi").
        max_items: Max tweets to request from the scraper.
        hours_lookback: Only return tweets from the past N hours.

    Returns:
        List of dicts with 'id', 'text', 'created_at', 'url' keys,
        sorted newest-first. Empty list if APIFY_API_KEY is not set or
        if the request fails.
    """
    api_key = os.environ.get("APIFY_API_KEY", "")
    if not api_key:
        logger.warning("APIFY_API_KEY not set — skipping tweet fetch")
        return []

    try:
        # Use Authorization header instead of query params so the API key
        # doesn't appear in access logs, error messages, or Apify's URL history.
        apify_headers = {"Authorization": f"Bearer {api_key}"}

        # Start the Apify actor and wait for it to finish (up to 5 min).
        # The actor scrapes Twitter's frontend and returns structured data.
        run_resp = httpx.post(
            "https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs",
            params={"waitForFinish": 300},
            headers=apify_headers,
            json={
                "twitterHandles": [twitter_handle],
                "maxItems": max_items,
                "sort": "Latest",
            },
            timeout=360,
        )
        run_resp.raise_for_status()
        dataset_id = run_resp.json()["data"]["defaultDatasetId"]

        # Fetch the scraped items from the Apify dataset
        items_resp = httpx.get(
            f"https://api.apify.com/v2/datasets/{dataset_id}/items",
            headers=apify_headers,
            timeout=60,
        )
        items_resp.raise_for_status()
        items = items_resp.json()
    except httpx.HTTPError as e:
        logger.error("Apify request failed: %s", e)
        return []

    # Filter to tweets within the lookback window
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_lookback)
    tweets = []

    for item in items:
        text = _decode_html(str(item.get("text", "")))
        created_at = str(item.get("createdAt", ""))
        if not text.strip():
            continue
        try:
            tweet_time = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if tweet_time < cutoff:
                continue
        except (ValueError, TypeError):
            continue

        tweets.append({
            "id": str(item.get("id", "")),
            "text": text,
            "created_at": created_at,
            "url": str(item.get("url", "")),
        })

    tweets.sort(key=lambda t: t["created_at"], reverse=True)
    logger.info(
        "Fetched %d new tweets from @%s (past %dh)",
        len(tweets), twitter_handle, hours_lookback,
    )
    return tweets


# ── Content Bank ──────────────────────────────────────────────────────


def select_bank_content(
    bank_path: str,
    count: int = 5,
    already_used: set[str] | None = None,
) -> list[str]:
    """Select random entries from a content bank CSV file.

    Ported from the THREADS repo's lib/tweet-bank.ts. Reads a single-column
    CSV (supports quoted multiline entries) and returns random entries that
    haven't been posted yet.

    Args:
        bank_path: Path to the CSV file.
        count: Number of entries to select.
        already_used: Set of caption strings already posted. Entries matching
            these are excluded before selection, preventing reposts.

    Returns:
        List of text strings (up to count). Empty if the file doesn't exist
        or all entries have been used.
    """
    if not os.path.exists(bank_path):
        logger.warning("Content bank not found: %s", bank_path)
        return []

    # Read all entries from the CSV (single column, one post per row)
    entries: list[str] = []
    with open(bank_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            if row and row[0].strip():
                entries.append(row[0].strip())

    if not entries:
        logger.info("Content bank is empty: %s", bank_path)
        return []

    # Filter out entries that have already been posted
    if already_used:
        entries = [e for e in entries if e not in already_used]

    if not entries:
        logger.info("Content bank exhausted — all entries have been posted")
        return []

    # Fisher-Yates shuffle (same approach as the original TS code) then take first N
    random.shuffle(entries)
    selected = entries[:count]
    logger.info(
        "Selected %d from bank (%d remaining unposted)",
        len(selected), len(entries) - len(selected),
    )
    return selected


# ── Helpers ───────────────────────────────────────────────────────────


def _decode_html(text: str) -> str:
    """Decode common HTML entities found in scraped tweets."""
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&apos;", "'")
    )
