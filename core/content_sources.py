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


# ── Apify Instagram Scraping ──────────────────────────────────────────


def fetch_apify_instagram_post(post_url: str) -> dict | None:
    """Scrape one Instagram post via Apify. Returns scraped data or None.

    Uses the apify/instagram-scraper actor with directUrls input so we fetch
    a specific post rather than an account feed. Follows the same auth and
    error-handling conventions as fetch_apify_tweets (Bearer header, defensive
    logging, returns None on any HTTP error so the caller can skip gracefully).

    Args:
        post_url: Full Instagram permalink (https://www.instagram.com/reel/…).

    Returns:
        Dict with keys: video_url (str), caption (str), timestamp (str),
        likes_count (int). None if the post is not a video, is private, or
        if the Apify request fails.
    """
    api_key = os.environ.get("APIFY_API_KEY", "")
    if not api_key:
        logger.warning("APIFY_API_KEY not set — skipping Instagram scrape")
        return None

    apify_headers = {"Authorization": f"Bearer {api_key}"}

    try:
        # directUrls + resultsType=posts tells the actor to fetch a specific
        # post (rather than scraping an account or hashtag feed).
        actor_input = {
            "directUrls": [post_url],
            "resultsType": "posts",
            "resultsLimit": 1,
        }

        run_resp = httpx.post(
            "https://api.apify.com/v2/acts/apify~instagram-scraper/runs",
            params={"waitForFinish": 300},
            headers=apify_headers,
            json=actor_input,
            timeout=360,
        )
        run_resp.raise_for_status()
        dataset_id = run_resp.json()["data"]["defaultDatasetId"]

        items_resp = httpx.get(
            f"https://api.apify.com/v2/datasets/{dataset_id}/items",
            headers=apify_headers,
            timeout=60,
        )
        items_resp.raise_for_status()
        items = items_resp.json()
    except httpx.HTTPError as e:
        logger.error("Apify Instagram request failed: %s", e)
        return None

    if not items:
        logger.warning("Apify returned no items for %s", post_url)
        return None

    item = items[0]
    # Log the keys so schema drift is visible immediately in logs.
    logger.info("Apify Instagram item keys: %s", sorted(item.keys()))

    video_url = item.get("videoUrl")
    if not video_url:
        logger.info(
            "No videoUrl for %s — image post or private account, skipping", post_url
        )
        return None

    return {
        "video_url": video_url,
        "caption": item.get("caption", ""),
        "timestamp": item.get("timestamp", ""),
        "likes_count": int(item.get("likesCount", 0)),
    }


# ── Content Bank ──────────────────────────────────────────────────────


def _fetch_bank_rows(min_likes: int | None = None) -> list[dict]:
    """Read the whole tweet bank from the Supabase tweet_bank table.

    The table replaced data/TweetMasterBank.csv as the live bank on
    2026-08-17: a cron's filesystem on Render is a throwaway checkout, so
    the daily bank-sync (add_tweets_to_bank, called by the threads cron)
    can only persist through the database — and per the architecture
    rules, the DB is how services share state anyway. The CSV remains in
    the repo as the historical seed (scripts/embed_tweet_bank.py loads it
    into this table).

    Paginated because PostgREST caps each select at 1000 rows; the bank
    is ~5K rows, so this is a handful of requests.
    """
    from core.database import get_client

    rows: list[dict] = []
    page = 0
    while True:
        query = get_client().table("tweet_bank").select(
            "tweet_id,text,favorite_count"
        )
        if min_likes is not None:
            query = query.gte("favorite_count", min_likes)
        batch = (
            query.range(page * 1000, page * 1000 + 999).execute().data or []
        )
        rows.extend(batch)
        if len(batch) < 1000:
            return rows
        page += 1


def select_bank_content(
    count: int = 5,
    already_used: set[str] | None = None,
) -> list[str]:
    """Select random entries from the tweet bank (Supabase tweet_bank table).

    Args:
        count: Number of entries to select.
        already_used: Set of caption strings already posted. Entries matching
            these are excluded before selection, preventing reposts.

    Returns:
        List of text strings (up to count). Empty if the bank is empty
        or all entries have been used.
    """
    entries = [r["text"].strip() for r in _fetch_bank_rows() if r["text"].strip()]

    if not entries:
        logger.info("Content bank is empty (tweet_bank table)")
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
    count: int = 1,
    min_likes: int = 6500,
    already_used: set[str] | None = None,
) -> list[dict]:
    """Select random bank entries with a minimum likes threshold.

    Like select_bank_content(), but returns all three columns and filters
    by like count (SQL-side, so the paginated read only transfers
    qualifying rows). Used by the TikTok bank pipeline and the Instagram
    carousel to only pick high-performing tweets.

    Args:
        count: Number of entries to select.
        min_likes: Minimum favorite_count to include.
        already_used: Set of caption strings already posted. Entries matching
            these are excluded before selection, preventing reposts.

    Returns:
        List of dicts with 'tweet_id', 'text', 'favorite_count' keys.
        Empty if no entries meet the criteria.
    """
    entries = [
        r for r in _fetch_bank_rows(min_likes=min_likes)
        if r["text"].strip() and r["favorite_count"] is not None
    ]

    if not entries:
        logger.info("No bank entries with >= %d likes in tweet_bank", min_likes)
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


def add_tweets_to_bank(tweets: list[dict]) -> int:
    """Upsert freshly scraped tweets into the tweet_bank table.

    Called daily by the threads cron right after its Apify fetch, so the
    master bank grows automatically instead of freezing at its last manual
    backfill. Returns how many NEW tweets were added.

    Per-tweet behaviour:
      - retweets ("RT @…"), replies (leading "@"), and empty texts are
        skipped — the bank has never contained them;
      - a tweet already in the bank gets its favorite_count refreshed when
        the new count is higher (a <24h-old tweet's likes are still
        climbing, and the same tweet is re-fetched on several consecutive
        runs while it's inside the scrape window);
      - a new tweet is inserted with an embedding when OPENAI_API_KEY is
        available, or with a NULL embedding otherwise. NULL-embedding rows
        are invisible to the caption RAG (cosine against NULL matches
        nothing) but fully visible to the bank pickers; every later run
        self-heals them (see below), so a temporarily missing key degrades
        gracefully instead of dropping tweets.
    """
    from core.database import get_client
    from core.tweet_filter import is_retweet

    candidates = []
    seen_ids: set[str] = set()
    for t in tweets:
        tweet_id = str(t.get("id", "")).strip()
        text = (t.get("text") or "").strip()
        if not tweet_id or not text or tweet_id in seen_ids:
            continue
        if is_retweet(text) or text.startswith("@"):
            continue
        seen_ids.add(tweet_id)
        candidates.append({
            "tweet_id": tweet_id,
            "text": text,
            "favorite_count": int(t.get("like_count", 0)),
        })
    if not candidates:
        return 0

    client = get_client()
    existing = {
        row["tweet_id"]: row["favorite_count"]
        for row in (
            client.table("tweet_bank")
            .select("tweet_id,favorite_count")
            .in_("tweet_id", [c["tweet_id"] for c in candidates])
            .execute()
            .data
            or []
        )
    }

    # Refresh like counts that have climbed since a previous run saw them.
    for c in candidates:
        old = existing.get(c["tweet_id"])
        if old is not None and c["favorite_count"] > (old or 0):
            client.table("tweet_bank").update(
                {"favorite_count": c["favorite_count"]}
            ).eq("tweet_id", c["tweet_id"]).execute()

    new_rows = [c for c in candidates if c["tweet_id"] not in existing]
    embeddings: list | None = None
    if new_rows and os.environ.get("OPENAI_API_KEY"):
        try:
            from core.embeddings import embed_batch

            embeddings = embed_batch([c["text"] for c in new_rows])
        except Exception as e:
            logger.warning("Bank embedding failed — inserting without: %s", e)
    if new_rows:
        # upsert (not insert): two overlapping runs racing on the same
        # tweet must not fail the whole batch on the UNIQUE(tweet_id).
        client.table("tweet_bank").upsert(
            [
                {**c, "embedding": embeddings[i] if embeddings else None}
                for i, c in enumerate(new_rows)
            ],
            on_conflict="tweet_id",
        ).execute()
        logger.info(
            "Bank sync: %d new tweet(s) added%s, %d already present",
            len(new_rows),
            "" if embeddings else " (no embedding — OPENAI_API_KEY missing?)",
            len(existing),
        )

    # Self-heal: embed any rows that were inserted without an embedding by
    # an earlier run (missing key, transient OpenAI failure). Bounded and
    # best-effort — the bank grows ~10 rows/day, so one pass keeps up.
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from core.embeddings import embed_batch

            unembedded = (
                client.table("tweet_bank")
                .select("tweet_id,text")
                .is_("embedding", "null")
                .limit(200)
                .execute()
                .data
                or []
            )
            # Rows we just inserted with embeddings aren't in this set, so
            # this only pays for genuinely missed ones.
            if unembedded:
                vectors = embed_batch([r["text"] for r in unembedded])
                for row, vec in zip(unembedded, vectors):
                    client.table("tweet_bank").update({"embedding": vec}).eq(
                        "tweet_id", row["tweet_id"]
                    ).execute()
                logger.info("Bank sync: self-healed %d missing embedding(s)", len(unembedded))
        except Exception as e:
            logger.warning("Bank embedding self-heal failed (non-fatal): %s", e)

    return len(new_rows)


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
