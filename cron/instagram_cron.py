"""Instagram cron job entry point."""

import logging
import sys

from core.database import log_cron_start, log_cron_finish, get_posts, upsert_metrics
from core.scheduler import process_due_posts
from platforms.instagram import Instagram

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def main():
    client = Instagram()

    run_id = log_cron_start(platform="instagram", job_type="post")
    try:
        client.refresh_credentials()
        processed = process_due_posts(client, "instagram")
        log_cron_finish(run_id, status="success", posts_processed=processed)
        logger.info("Posting complete: %d posts processed", processed)
    except Exception as e:
        logger.error("Posting failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    run_id = log_cron_start(platform="instagram", job_type="metrics")
    try:
        posts = get_posts(platform="instagram", status="published", limit=50)
        for post in posts:
            if post.get("platform_post_id"):
                snapshot = client.get_post_metrics(post["platform_post_id"])
                upsert_metrics(post["id"], snapshot)
        log_cron_finish(run_id, status="success", posts_processed=len(posts))
        logger.info("Metrics pull complete: %d posts updated", len(posts))
    except Exception as e:
        logger.error("Metrics pull failed: %s", e)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
