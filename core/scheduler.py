"""Scheduling logic: process posts that are due for publishing."""

from __future__ import annotations

import logging

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
        post_data = schedule.get("posts")
        if not post_data:
            logger.warning("Schedule %s has no associated post, skipping", schedule_id)
            continue

        post = Post(**post_data)
        mark_schedule_picked_up(schedule_id)
        update_post(post.id, status="publishing")

        try:
            platform_post_id = platform_client.create_post(post)
            update_post(
                post.id,
                status="published",
                platform_post_id=platform_post_id,
            )
            processed += 1
            logger.info("Published post %s -> %s", post.id, platform_post_id)
        except Exception as e:
            logger.error("Failed to publish post %s: %s", post.id, e)
            update_post(post.id, status="failed", error_message=str(e))

    return processed
