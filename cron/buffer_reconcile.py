"""Buffer reconciliation — periodic cron job.

Closes a visibility gap in the publishing pipeline. When we send a post to
Buffer, the send returns as soon as Buffer *accepts* it into the queue — it
stamps `posts.platform_post_id` but leaves `status='sent_to_buffer'` and never
checks back. So a post that Buffer later fails to publish (e.g. its media URL
expired before Buffer fetched it, or the platform rejected it) shows "An unknown
error has occurred" in Buffer's own dashboard while OUR dashboard still shows it
as handed-off — the failure is invisible to us.

This cron polls Buffer for every unconfirmed handoff and resolves each:

  - published    → status='published', published_at mirrored from Buffer sentAt
  - failed       → re-send the EXACT post (up to MAX_RESEND_ATTEMPTS) using the
                   replay payload persisted at send time; after exhausting
                   attempts, flip to status='buffer_error' so it surfaces in the
                   dashboard
  - still queued → left alone, re-checked next run

Retry design (see the dedup index in
supabase/migrations/20260512000000_dedup_skip_manual_upload.sql): a
`buffer_error` row drops OUT of the dedup index, so a content pipeline could
re-create the same caption. To avoid double-posting, a post being retried is
kept in `sent_to_buffer` (which stays IN the index) until its attempts are
exhausted — reconcile is the single owner of the retry until then. A failed
Buffer post never publishes, so re-sending it (and abandoning the old Buffer id)
can't double-post.

Run locally with:  python -m cron.buffer_reconcile
"""

import logging
import sys
import time

from core.buffer import BufferRateLimitError, get_buffer_post_state, send_to_buffer
from core.database import (
    get_posts_awaiting_buffer_confirmation,
    log_cron_finish,
    log_cron_start,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import build_proxy_url
from core.models import Post
from platforms.threads import Threads


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Give up re-sending after this many attempts and surface a terminal failure.
MAX_RESEND_ATTEMPTS = 3
# Pace re-sends so a batch of retries doesn't trip Buffer's rate limit.
INTER_RESEND_SLEEP_SECONDS = 2.0
# Pace the per-post state reads so we don't burst requests at Buffer.
INTER_READ_SLEEP_SECONDS = 1.0
# Max posts to reconcile per run. Each post is one Buffer API call and Buffer's
# limit is a rolling ~100-request/15-minute window THAT WE SHARE with the send
# paths (publishers, fan-out legs). Polling the whole backlog (hundreds of rows)
# in one run blows that window and every request comes back 429. So we process a
# bounded slice — oldest first — and let a backlog drain across runs. 40 leaves
# headroom under ~100 for the other Buffer crons. At a daily cadence that's
# 40 posts/day of drain capacity; if steady-state volume ever exceeds that,
# raise this cap or the run frequency (see schedule in render.yaml).
RECONCILE_BATCH_LIMIT = 40
# Scheduler-path adapters that publish via Buffer. Their posts are text-only and
# rebuilt deterministically from the row, so reconcile re-sends by re-running the
# adapter (which knows the Threads mutation) rather than via send_to_buffer.
# Both Threads and Threads_Leila use the Threads adapter on different channels.
_SCHEDULER_BUFFER_ADAPTERS = {
    "threads": Threads,
    "threads_leila": Threads,
}


def _is_failure_status(status: str | None) -> bool:
    """True if Buffer's post status indicates a publish failure.

    Buffer's PostStatus enum isn't fully documented and may gain values, so we
    match defensively on substrings ('error'/'fail') rather than an exact set.
    Known non-failure statuses ('sent', 'draft', 'buffer'/queued) don't match.
    Run `python -m cron.buffer_introspect` to confirm the real enum values.
    """
    if not status:
        return False
    s = status.lower()
    return "error" in s or "fail" in s


def _can_resend(post: dict, replay: dict | None) -> bool:
    """Whether we have what we need to re-send this post.

    Two strategies: media posts re-send via send_to_buffer (need the replay
    payload + a storage path); scheduler/text posts (Threads) re-send via their
    adapter (need the Buffer channel id in the replay). Posts created before
    replay payloads were persisted have no `buffer_replay` and can't be retried.
    """
    if replay and replay.get("media_type") and (post.get("media_urls") or []):
        return True
    if post.get("platform") in _SCHEDULER_BUFFER_ADAPTERS and (replay or {}).get("channel_id"):
        return True
    return False


def _resend(post: dict, replay: dict) -> str:
    """Re-send a Buffer-failed post and return the NEW Buffer post id.

    Media posts re-mint a fresh signed URL and go through send_to_buffer; text
    posts (Threads) re-run their adapter, which owns the text-only mutation.
    """
    platform = post.get("platform")
    media_urls = post.get("media_urls") or []
    media_type = replay.get("media_type")

    if media_type and media_urls:
        # Use permanent proxy URLs — they re-sign on every request, so they
        # never expire regardless of how long the post stays in Buffer's queue.
        # Carousel rows carry several media_urls entries; one indexed proxy URL
        # per entry re-sends the full carousel (a bare build_proxy_url would
        # silently replay only the first slide). Single-media rows produce the
        # same lone URL as before.
        urls = [build_proxy_url(post["id"], i) for i in range(len(media_urls))]
        # Carry the YouTube publisher block + per-platform caption limit when
        # present (batch-video legs persist these). Without the YouTube block a
        # re-sent YouTube post is rejected for a missing category; without the
        # caption_limit a YouTube/X caption would be re-truncated to TikTok's 150.
        return send_to_buffer(
            replay["channel_id"],
            replay["body"],
            urls[0] if len(urls) == 1 else urls,
            media_type=media_type,
            facebook_post_type=replay.get("facebook_post_type"),
            instagram_post_type=replay.get("instagram_post_type"),
            youtube=replay.get("youtube"),
            caption_limit=replay.get("caption_limit"),
        )

    adapter_cls = _SCHEDULER_BUFFER_ADAPTERS.get(platform)
    if adapter_cls is not None:
        client = adapter_cls(channel_id=replay["channel_id"])
        return client.create_post(Post(**post))

    # Guarded by _can_resend, so this should be unreachable.
    raise ValueError(f"No replay strategy for platform '{platform}'")


def main() -> None:
    log_env_diagnostics(
        "buffer-reconcile",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
        ],
    )

    run_id = log_cron_start(platform="buffer", job_type="reconcile")

    try:
        posts = get_posts_awaiting_buffer_confirmation(limit=RECONCILE_BATCH_LIMIT)
        logger.info(
            "Reconciling %d post(s) this run (cap %d) awaiting Buffer confirmation",
            len(posts), RECONCILE_BATCH_LIMIT,
        )

        published = 0
        resent = 0
        failed = 0  # terminal buffer_error (exhausted or un-retryable)
        resend_failed = 0  # a re-send attempt itself errored (will retry next run)
        still_queued = 0
        errors = 0
        rate_limited = False  # set if we bail early on a Buffer rate limit

        for post in posts:
            post_id = post["id"]
            buffer_id = post.get("platform_post_id")
            try:
                state = get_buffer_post_state(buffer_id)

                # Buffer has no record of this id — it was either manually
                # deleted from the queue or pruned by Buffer after a publish
                # failure. The post can never publish, so surface it as a
                # terminal failure rather than leaving it stuck forever.
                if state is None:
                    reason = (
                        f"Buffer post {buffer_id} not found "
                        "(deleted from Buffer queue or pruned after failure)"
                    )
                    update_post(post_id, status="buffer_error", error_message=reason)
                    failed += 1
                    logger.warning(
                        "Post %s (%s): %s", post_id, post.get("platform"), reason,
                    )
                    continue

                sent_at = state["sentAt"]
                status = state["status"]

                if sent_at is not None:
                    # Published. Mirror Buffer's publish time into our row.
                    update_post(
                        post_id,
                        status="published",
                        published_at=sent_at.isoformat(),
                    )
                    published += 1
                    logger.info(
                        "Post %s (%s): published at %s",
                        post_id, post.get("platform"), sent_at.isoformat(),
                    )
                elif _is_failure_status(status):
                    metadata = post.get("metadata") or {}
                    attempts = int(metadata.get("buffer_retry_count", 0))
                    replay = metadata.get("buffer_replay")

                    if attempts >= MAX_RESEND_ATTEMPTS or not _can_resend(post, replay):
                        # Exhausted retries, or nothing to replay (e.g. a post
                        # from before replay payloads existed). Surface a
                        # terminal failure so it's visible in the dashboard.
                        reason = (
                            f"Buffer failed to publish (status '{status}') "
                            f"after {attempts} resend attempt(s)"
                        )
                        update_post(post_id, status="buffer_error", error_message=reason)
                        failed += 1
                        logger.warning(
                            "Post %s (%s): giving up — %s", post_id, post.get("platform"), reason,
                        )
                    else:
                        # Re-send and KEEP the row in 'sent_to_buffer' (still in
                        # the dedup index, so the content pipeline won't also
                        # re-create it). Bump the attempt counter either way so
                        # a persistently-failing re-send eventually gives up.
                        new_meta = {**metadata, "buffer_retry_count": attempts + 1}
                        try:
                            new_buffer_id = _resend(post, replay)
                        except Exception as e:
                            update_post(post_id, status="sent_to_buffer", metadata=new_meta)
                            resend_failed += 1
                            logger.warning(
                                "Post %s (%s): re-send attempt %d/%d failed: %s",
                                post_id, post.get("platform"), attempts + 1,
                                MAX_RESEND_ATTEMPTS, e,
                            )
                        else:
                            update_post(
                                post_id,
                                status="sent_to_buffer",
                                platform_post_id=new_buffer_id,
                                metadata=new_meta,
                            )
                            resent += 1
                            logger.info(
                                "Post %s (%s): Buffer failed (status=%s) — re-sent "
                                "attempt %d/%d, new Buffer id %s",
                                post_id, post.get("platform"), status,
                                attempts + 1, MAX_RESEND_ATTEMPTS, new_buffer_id,
                            )
                        time.sleep(INTER_RESEND_SLEEP_SECONDS)
                else:
                    # Still in Buffer's queue (e.g. status 'buffer'/'pending').
                    still_queued += 1

            except BufferRateLimitError as e:
                # Buffer is throttling us (rolling ~100-req/15-min window). Every
                # remaining post would 429 too, so stop the run NOW instead of
                # grinding through the rest and deepening the penalty. The
                # unprocessed posts stay 'sent_to_buffer' and the next scheduled
                # run (3h later, window long reset) picks them up. Not counted as
                # an error — throttling is expected, not a failure.
                logger.warning(
                    "Buffer rate limited at post %s — stopping run, %d post(s) "
                    "deferred to next run: %s",
                    post_id, len(posts) - (published + resent + failed + still_queued), e,
                )
                rate_limited = True
                break

            except Exception as e:
                # Per-post isolation: one bad post must not abort the run.
                # Next run retries it cleanly.
                logger.error(
                    "Failed to reconcile post %s (Buffer %s): %s",
                    post_id, buffer_id, e, exc_info=True,
                )
                errors += 1

            # Pace every post so we don't burst requests at Buffer. Runs after
            # the try/except so it always applies.
            time.sleep(INTER_READ_SLEEP_SECONDS)

        logger.info(
            "Reconcile: %d published, %d re-sent, %d terminal-failed, "
            "%d re-send errors, %d still queued, %d errors%s",
            published, resent, failed, resend_failed, still_queued, errors,
            " (stopped early: Buffer rate limit)" if rate_limited else "",
        )

        # Only an unexpected per-post exception fails the run. Re-send attempts
        # that bounce off Buffer (rate limits etc.) are expected and retried, so
        # they don't mark the whole cron failed.
        final_status = "success" if errors == 0 else "failed"
        error_msg = f"{errors} post(s) errored during reconcile" if errors else None
        log_cron_finish(
            run_id,
            status=final_status,
            posts_processed=published + resent + failed,
            error_message=error_msg,
        )

    except Exception as e:
        logger.error("buffer-reconcile crashed: %s", e, exc_info=True)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
