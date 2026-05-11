"""
Threads (Leila Hormozi) cron job entry point.

Parallel to cron/threads_cron.py — same Apify-scrape → Buffer-queue path,
different Twitter handle and Buffer channel, separate platform enum value
('threads_leila'). Ported from github.com/julianlin619-hub/THREADS-LEILA-,
which is a verbatim repost of recent @LeilaHormozi tweets with no
engagement filter and no content bank.

Phase 0 — SOURCE: pull recent tweets from @LeilaHormozi via Apify and create
          scheduled posts in Supabase (platform='threads_leila'). Each tweet
          is dedup'd against existing posts via post_caption_exists.
Phase 1 — PUBLISH: process due posts via the Threads adapter, pointing at
          the Leila-specific Buffer channel.

The Alex Threads cron is untouched — this job has its own cron_runs history
and its own Render service.
"""

import logging
import os
import re
import sys
from datetime import datetime, timezone

from core.content_sources import fetch_apify_tweets
from core.database import (
    insert_post,
    insert_schedule,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
)
from core.env_diag import log_env_diagnostics
from core.models import Post
from core.scheduler import process_due_posts
from platforms.threads import Threads

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# Buffer channel ID for Leila's Threads.
#
#   Buffer org: "ACQ" (id 67dafe21c453882020852a9a)
#   Channel:    "leilahormozi" (service: threads)
#
# Hardcoded because it's stable per-account and the BUFFER_ACCESS_TOKEN it's
# paired with is what actually gates access — keeping this out of env vars
# avoids per-environment config drift for a value that never changes.
#
# To rotate (or look up another channel in the same org), POST to
# https://api.buffer.com/graphql with the existing BUFFER_ACCESS_TOKEN:
#
#   { account { organizations { id name channels { id name service } } } }
#
# Find the entry where service="threads" and name matches the desired
# Threads handle, then paste its `id` here.
THREADS_LEILA_CHANNEL_ID = "67dafec61616c536ddd6e02f"


# Regex for detecting hyperlinks in tweet text.
#
# Apify returns the raw tweet body, where Twitter rewrites every link as a
# t.co short URL (e.g. "https://t.co/abc123"). We also want to catch any
# bare URLs the author typed out (https://, http://, or www.example.com),
# since reposting a tweet that points at an X-hosted article or external
# site doesn't make sense on Threads — the link target doesn't carry over
# and the post reads as a dangling reference.
#
# Patterns matched:
#   - http:// or https:// followed by any non-whitespace
#   - www. followed by a domain-ish token
#   - bare t.co/... shortlinks (defensive; t.co text usually arrives with
#     the https:// prefix, but Apify has occasionally stripped it)
_HYPERLINK_RE = re.compile(
    r"(https?://\S+|www\.\S+|\bt\.co/\S+)",
    re.IGNORECASE,
)


def _contains_hyperlink(text: str) -> bool:
    """Return True if the tweet text contains any URL-like substring.

    Used to filter out tweets that link off-platform before they're
    queued for reposting to Threads.
    """
    return bool(_HYPERLINK_RE.search(text))


def main():
    log_env_diagnostics(
        "threads-leila-cron",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "APIFY_API_KEY",
        ],
        optional=[
            "APIFY_LEILA_TWITTER_HANDLE",
        ],
    )

    # Construct the Threads adapter against Leila's Buffer channel. The
    # default constructor reads BUFFER_THREADS_CHANNEL_ID (Alex); passing
    # channel_id explicitly overrides that for this run.
    client = Threads(channel_id=THREADS_LEILA_CHANNEL_ID)

    # -------------------------------------------------------------------------
    # PHASE 0: Source tweets via Apify
    # -------------------------------------------------------------------------
    # Source repo posts every recent @LeilaHormozi tweet without filtering on
    # engagement — match that behavior (no min_favorites). max_items=5 mirrors
    # the source repo's per-run cap.
    run_id = log_cron_start(platform="threads_leila", job_type="content_apify")
    try:
        apify_sourced = 0
        skipped_hyperlink = 0
        now = datetime.now(timezone.utc)

        twitter_handle = os.environ.get("APIFY_LEILA_TWITTER_HANDLE", "LeilaHormozi")
        tweets = fetch_apify_tweets(twitter_handle, max_items=5, hours_lookback=24)

        for tweet in tweets:
            # Drop tweets that contain a URL — reposting a link-bearing tweet
            # to Threads strips the link's context (t.co indirection,
            # quote-tweets, article cards) and leaves a confusing stub. The
            # source repo doesn't filter on engagement, but it also doesn't
            # have to deal with hyperlinks since the original tweet lives on
            # X; we're mirroring to a different network.
            if _contains_hyperlink(tweet["text"]):
                skipped_hyperlink += 1
                logger.info(
                    "Skipping tweet %s — contains hyperlink",
                    tweet.get("id", "?"),
                )
                continue
            if post_caption_exists("threads_leila", tweet["text"]):
                continue
            post = Post(platform="threads_leila", caption=tweet["text"], status="scheduled")
            post_id = insert_post(post)
            insert_schedule(post_id, now)
            apify_sourced += 1

        log_cron_finish(run_id, status="success", posts_processed=apify_sourced)
        logger.info(
            "Apify sourcing complete: %d new posts, %d skipped (hyperlink)",
            apify_sourced,
            skipped_hyperlink,
        )
    except Exception as e:
        logger.error("Apify sourcing failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))

    # -------------------------------------------------------------------------
    # PHASE 1: Publish due posts
    # -------------------------------------------------------------------------
    run_id = log_cron_start(platform="threads_leila", job_type="post")
    try:
        try:
            client.refresh_credentials()
        except Exception as e:
            logger.error("Credential refresh failed — aborting run: %s", e, exc_info=True)
            log_cron_finish(run_id, status="failed", error_message=f"Credential refresh failed: {e}")
            sys.exit(1)

        processed = process_due_posts(client, "threads_leila")

        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
