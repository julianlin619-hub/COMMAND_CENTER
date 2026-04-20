"""Scheduling logic: process posts that are due for publishing.

This is the heart of the cron job. Every 4 hours, each platform's cron job
calls process_due_posts(), which:
  1. Queries Supabase for schedules whose time has arrived (and haven't
     been claimed yet).
  2. For each one, marks it as "picked up" immediately — this prevents
     another cron run from grabbing the same post if jobs overlap.
  3. Calls the platform adapter to actually publish the post.
  4. Updates the post status to "published" or "failed".

The key design choice is step 2: we mark the schedule as picked up BEFORE
attempting to publish. This is a "claim first, then work" pattern that
prevents double-publishing even if two cron instances run at the same time.
The downside is that if the process crashes after claiming but before
publishing, the post gets stuck. That's an acceptable tradeoff — a stuck
post can be manually retried, but a double-published post can't be undone.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from core.database import get_due_schedules, mark_schedule_picked_up, update_post
from core.models import Post

logger = logging.getLogger(__name__)


def process_due_posts(platform_client, platform: str) -> int:
    """Find and publish all posts due for the given platform.

    Args:
        platform_client: An instance of a PlatformBase subclass.
        platform: Platform name (e.g. 'youtube').

    Returns:
        Number of posts successfully processed.
    """
    schedules = get_due_schedules(platform)
    processed = 0

    for schedule in schedules:
        schedule_id = schedule["id"]
        # The "posts" key comes from the Supabase join (select "*, posts(*)")
        # in get_due_schedules — it's the related row from the posts table.
        post_data = schedule.get("posts")
        if not post_data:
            logger.warning("Schedule %s has no associated post, skipping", schedule_id)
            continue

        # Hydrate the raw dict into a typed Pydantic model for validation.
        # The Pydantic model declares `id: str | None` (since new posts are
        # built without an id before insert), so we grab the id from the raw
        # DB row — it's guaranteed to be set there. Losing it to None would
        # make update_post() silently no-op and leave the post stuck in
        # "publishing" forever.
        post_id = post_data.get("id")
        if not post_id:
            logger.error(
                "Schedule %s has a posts row with no id — DB integrity issue, skipping",
                schedule_id,
            )
            continue
        post = Post(**post_data)

        # IMPORTANT: Claim the schedule BEFORE publishing. This is the
        # "pick up" step that prevents double-processing (see module docstring).
        # mark_schedule_picked_up is atomic — if another worker already claimed
        # this schedule, it returns False and we skip it.
        if not mark_schedule_picked_up(schedule_id):
            logger.info("Schedule %s already claimed by another worker, skipping", schedule_id)
            continue
        # Set status to "publishing" so the dashboard shows it's in progress
        update_post(post_id, status="publishing")

        # Each post is wrapped in its own try/except so one failure doesn't
        # stop the rest of the batch from being processed. If post #2 of 5
        # fails, posts #3-5 still get published.
        try:
            platform_post_id = platform_client.create_post(post)
            update_post(
                post_id,
                status="published",
                platform_post_id=platform_post_id,
                published_at=datetime.now(timezone.utc).isoformat(),
            )
            processed += 1
            logger.info("Published post %s -> %s", post_id, platform_post_id)
        except Exception as e:
            # Mark as failed and store the error message so it's visible
            # in the dashboard. The post can be retried manually later.
            logger.error("Failed to publish post %s: %s", post_id, e)
            # Nested try: update_post now raises when the UPDATE matches no
            # rows. If that happens inside this except block, the RuntimeError
            # would shadow the real platform error above — log the double-
            # fault instead and let the loop continue to the next post. The
            # post stays in "publishing" and will be reset by
            # _reset_stale_pickups after STALE_PICKUP_MINUTES.
            try:
                update_post(post_id, status="failed", error_message=str(e))
            except Exception as db_err:
                logger.error(
                    "Also failed to mark post %s as failed: %s — will be retried after stale-pickup reset",
                    post_id, db_err,
                )

    return processed
