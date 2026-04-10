"""Content sourcing — fetch and generate post content from external sources.

This module pulls content from external sources so it can be turned into
scheduled posts. Currently supports two sources (both ported from the
original THREADS repo at github.com/julianlin619-hub/THREADS):

  1. Apify tweet scraping — fetches recent tweets from any Twitter account
     using the apidojo~tweet-scraper actor on Apify. The original repo
     scraped @AlexHormozi tweets and reposted them to Threads.

  2. Content bank — reads pre-written posts from a CSV file (currently
     TweetMasterBank.csv with columns tweet_id, text, favorite_count),
     picks random unposted entries, and returns them.

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
    min_favorites: int | None = None,
) -> list[dict]:
    """Scrape recent tweets from a Twitter account via Apify.

    Ported from the THREADS repo's /api/fetch-tweets route. Uses the
    apidojo~tweet-scraper actor on Apify.

    Args:
        twitter_handle: Twitter username without the @ (e.g. "AlexHormozi").
        max_items: Max tweets to request from the scraper.
        hours_lookback: Only return tweets from the past N hours.
        min_favorites: If set, passed as minimumFavorites to the Apify actor
            AND used for post-fetch filtering. The TikTok pipeline uses this
            to only grab high-engagement "outlier" tweets (e.g. 4000+ likes).

    Returns:
        List of dicts with 'id', 'text', 'created_at', 'url', and
        'like_count' keys, sorted newest-first. Empty list if
        APIFY_API_KEY is not set or if the request fails.
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
        actor_input: dict = {
            "twitterHandles": [twitter_handle],
            "maxItems": max_items,
            "sort": "Latest",
        }
        # minimumFavorites tells the Apify actor to only return tweets above
        # this like threshold. Used by the TikTok pipeline to grab "outlier"
        # tweets (viral content worth turning into videos).
        if min_favorites is not None:
            actor_input["minimumFavorites"] = min_favorites

        run_resp = httpx.post(
            "https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs",
            params={"waitForFinish": 300},
            headers=apify_headers,
            json=actor_input,
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

        like_count = int(item.get("likeCount", 0))

        # Post-fetch like filter — if min_favorites is set, skip tweets
        # below the threshold. The Apify actor does server-side filtering
        # too, but we double-check here in case it returns borderline results.
        if min_favorites is not None and like_count < min_favorites:
            continue

        tweets.append({
            "id": str(item.get("id", "")),
            "text": text,
            "created_at": created_at,
            "url": str(item.get("url", "")),
            "like_count": like_count,
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

    Reads TweetMasterBank.csv (columns: tweet_id, text, favorite_count),
    picks random unposted entries, and returns them.

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

    # Read all entries from the CSV. TweetMasterBank.csv has columns:
    # tweet_id, text, favorite_count — we only need the text column.
    entries: list[str] = []
    with open(bank_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        # Figure out which column has the text. If there's a header with
        # "text" in it, use that index; otherwise fall back to column 1
        # for multi-column CSVs or column 0 for single-column files.
        text_col = 0
        if header:
            lowered = [h.strip().lower() for h in header]
            if "text" in lowered:
                text_col = lowered.index("text")
            elif len(header) > 1:
                text_col = 1
            else:
                # Single-column CSV with no "text" header — the header
                # itself is likely the first entry, so include it.
                if header[0].strip():
                    entries.append(header[0].strip())
        for row in reader:
            if len(row) > text_col and row[text_col].strip():
                entries.append(row[text_col].strip())

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
