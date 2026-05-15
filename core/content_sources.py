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
from email.utils import parsedate_to_datetime

import httpx

logger = logging.getLogger(__name__)


# ── Apify Tweet Fetching ──────────────────────────────────────────────


def fetch_apify_tweets(
    twitter_handle: str,
    max_items: int = 50,
    hours_lookback: int | None = 24,
    min_favorites: int | None = None,
) -> list[dict]:
    """Scrape recent tweets from a Twitter account via Apify.

    Ported from the THREADS repo's /api/fetch-tweets route. Uses the
    apidojo~tweet-scraper actor on Apify.

    Args:
        twitter_handle: Twitter username without the @ (e.g. "AlexHormozi").
        max_items: Max tweets to request from the scraper.
        hours_lookback: Only return tweets from the past N hours.
            Pass None to disable the time-window filter entirely — Apify
            still returns the latest `max_items` tweets, but no tweets
            are dropped for being older than the cutoff. Downstream
            dedup (post_caption_exists) is the real "already posted"
            guard, so disabling the window is safe when a pipeline
            cares about engagement quality more than recency.
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

    # Filter to tweets within the lookback window. cutoff=None disables
    # the filter entirely — the loop below skips the time check when so.
    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=hours_lookback)
        if hours_lookback is not None
        else None
    )
    tweets = []

    # Diagnostic counters — we silently dropped items before, which made it
    # impossible to tell "Apify returned 0 items" from "Apify returned items
    # but all parsing failed (schema drift)". The summary log line at the
    # bottom prints raw vs kept counts plus drop reasons so the next failing
    # run is debuggable from logs alone, without re-running with extra prints.
    raw_count = len(items)
    drop_empty_text = 0
    drop_bad_date = 0
    drop_out_of_window = 0
    drop_low_likes = 0
    # First raw `createdAt` value we fail to parse, surfaced in the summary
    # log when bad_date > 0. Lets us debug any future format change in one
    # cron run without re-deploying additional diagnostics.
    sample_bad_date: str | None = None

    # If Apify returned anything, log the keys of the first item once per
    # call. This catches schema drift cheaply — e.g. if Apify renames
    # `createdAt` to `created_at` we'll see it immediately rather than
    # silently dropping every tweet on a `datetime.fromisoformat` failure.
    if raw_count > 0:
        logger.info(
            "Apify first item keys for @%s: %s",
            twitter_handle, sorted(items[0].keys()),
        )

    for item in items:
        text = _decode_html(str(item.get("text", "")))
        created_at = str(item.get("createdAt", ""))
        if not text.strip():
            drop_empty_text += 1
            continue
        tweet_time = _parse_apify_datetime(created_at)
        if tweet_time is None:
            drop_bad_date += 1
            if sample_bad_date is None:
                sample_bad_date = created_at
            continue
        if cutoff is not None and tweet_time < cutoff:
            drop_out_of_window += 1
            continue

        like_count = int(item.get("likeCount", 0))

        # Post-fetch like filter — if min_favorites is set, skip tweets
        # below the threshold. The Apify actor does server-side filtering
        # too, but we double-check here in case it returns borderline results.
        if min_favorites is not None and like_count < min_favorites:
            drop_low_likes += 1
            continue

        # _parsed_dt stays on the dict only long enough to sort by it; we
        # strip it before returning so the public shape is unchanged. Sorting
        # on the raw string would lex-sort RFC 2822 dates incorrectly (e.g.
        # "Apr" < "Aug" but April is later in some years), so the parsed
        # datetime is the only correct sort key.
        tweets.append({
            "id": str(item.get("id", "")),
            "text": text,
            "created_at": created_at,
            "url": str(item.get("url", "")),
            "like_count": like_count,
            "_parsed_dt": tweet_time,
        })

    tweets.sort(key=lambda t: t["_parsed_dt"], reverse=True)
    for t in tweets:
        del t["_parsed_dt"]

    # Diagnostic summary — emit even when raw_count==0 so we can see Apify
    # returned an empty dataset rather than a parsing failure. When any
    # items were dropped for bad dates, include one raw sample value so we
    # can spot a third format showing up without another round-trip.
    sample_suffix = (
        f" sample_bad_date={sample_bad_date!r}" if sample_bad_date is not None else ""
    )
    # window=Xh when bounded; window=unbounded when the caller disabled
    # the time filter by passing hours_lookback=None.
    window_desc = f"{hours_lookback}h" if hours_lookback is not None else "unbounded"
    logger.info(
        "Apify raw=%d kept=%d (empty_text=%d, bad_date=%d, out_of_window=%d, low_likes=%d) handle=@%s window=%s%s",
        raw_count, len(tweets),
        drop_empty_text, drop_bad_date, drop_out_of_window, drop_low_likes,
        twitter_handle, window_desc, sample_suffix,
    )
    # Kept for backwards-compat with anything grepping the old phrasing.
    logger.info(
        "Fetched %d new tweets from @%s (window=%s)",
        len(tweets), twitter_handle, window_desc,
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


# ── Content Bank (with likes filter) ─────────────────────────────


def select_bank_content_with_likes(
    bank_path: str,
    count: int = 1,
    min_likes: int = 6500,
    already_used: set[str] | None = None,
) -> list[dict]:
    """Select random entries from the bank with a minimum likes threshold.

    Like select_bank_content(), but reads all three columns (tweet_id, text,
    favorite_count) and filters by like count. Used by the TikTok bank
    pipeline to only pick high-performing tweets for video conversion.

    Args:
        bank_path: Path to the CSV file (tweet_id, text, favorite_count).
        count: Number of entries to select.
        min_likes: Minimum favorite_count to include.
        already_used: Set of caption strings already posted. Entries matching
            these are excluded before selection, preventing reposts.

    Returns:
        List of dicts with 'tweet_id', 'text', 'favorite_count' keys.
        Empty if the file doesn't exist or no entries meet the criteria.
    """
    if not os.path.exists(bank_path):
        logger.warning("Content bank not found: %s", bank_path)
        return []

    entries: list[dict] = []
    with open(bank_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return []

        # Locate columns by header name (case-insensitive)
        lowered = [h.strip().lower() for h in header]
        text_col = lowered.index("text") if "text" in lowered else 1
        id_col = lowered.index("tweet_id") if "tweet_id" in lowered else 0
        likes_col = lowered.index("favorite_count") if "favorite_count" in lowered else 2

        for row in reader:
            if len(row) <= max(text_col, id_col, likes_col):
                continue
            text = row[text_col].strip()
            if not text:
                continue
            try:
                likes = int(row[likes_col].strip())
            except (ValueError, IndexError):
                continue
            if likes < min_likes:
                continue
            entries.append({
                "tweet_id": row[id_col].strip().rstrip("'"),
                "text": text,
                "favorite_count": likes,
            })

    if not entries:
        logger.info("No bank entries with >= %d likes in %s", min_likes, bank_path)
        return []

    # Filter out entries that have already been posted
    if already_used:
        entries = [e for e in entries if e["text"] not in already_used]

    if not entries:
        logger.info("Content bank exhausted — all high-like entries have been posted")
        return []

    random.shuffle(entries)
    selected = entries[:count]
    logger.info(
        "Selected %d from bank (>= %d likes, %d remaining unposted)",
        len(selected), min_likes, len(entries) - len(selected),
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


def _parse_apify_datetime(value: str) -> datetime | None:
    """Parse Apify's `createdAt` into a timezone-aware datetime.

    The `apidojo~tweet-scraper` actor emits Twitter's classic RFC 2822-style
    format (e.g. "Wed Oct 10 20:19:24 +0000 2018"), which datetime.fromisoformat
    can't handle and used to silently drop every tweet. We try ISO-8601 first
    (cheap path + forward-compat if Apify ever switches), then fall back to
    parsedate_to_datetime which is Python's stdlib RFC 2822 parser.

    Returns None on both failures so the caller can count and log the drop.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        pass
    try:
        dt = parsedate_to_datetime(value)
    except (ValueError, TypeError):
        return None
    # parsedate_to_datetime returns a naive datetime when the input has no
    # timezone offset. The downstream comparison against the UTC cutoff would
    # raise TypeError on naive-vs-aware, so coerce missing tz to UTC — matches
    # Twitter's convention of using +0000.
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
