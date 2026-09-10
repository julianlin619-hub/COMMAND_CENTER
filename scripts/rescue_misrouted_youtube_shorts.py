"""One-off rescue: move misrouted YouTube Shorts to the right Buffer channel.

Background (2026-09-10): the Buffer org has TWO service='youtube' channels —
the main "Alex Hormozi" channel and "MoreMozi" (the 2nd/highlights channel).
Before core/video_batch.py pinned the lookup by name, the manual-upload
fan-out queued every YouTube Shorts leg onto whichever channel Buffer listed
first, which was MoreMozi. Those posts are still sitting unpublished at the
tail of MoreMozi's ~700-post queue.

This script re-routes them. For every posts row that is:
  - platform='youtube', status='sent_to_buffer', source='manual_upload', and
  - whose stored buffer_replay.channel_id points at the WRONG channel,

it:
  1. Asks Buffer for the old post's live state. Already-published posts
     ('sent') are skipped — we can't unpublish, and re-sending would
     double-post the video.
  2. Re-sends the EXACT same post (body, YouTube metadata block, caption
     limit — all persisted in buffer_replay at hand-off time) to the correct
     "Alex Hormozi" channel, via the same /api/media/<id> proxy URL. The mp4
     is still in Supabase Storage: the storage-cleanup cron only reclaims a
     file once every leg has published, and these YouTube legs never did.
  3. Stamps the row with the new Buffer id + updated replay (so
     buffer_reconcile keeps working), leaving the rest of the metadata
     (video_batch_job_id, storage_cleanup_status) untouched.
  4. Tries to delete the old misrouted post from MoreMozi's queue so it can't
     publish there later. Buffer's delete mutation isn't exercised anywhere
     else in this repo, so if the attempt fails the script just prints the
     old Buffer id for manual deletion in Buffer's UI — the re-send above has
     already succeeded either way.

Safety:
  - DRY RUN by default: prints what would happen, sends nothing. Pass
    --apply to execute.
  - --skip <post_id,...> excludes specific posts rows (e.g. a duplicate test
    upload you don't want on the real channel).
  - Idempotent: a rescued row's replay now points at the correct channel, so
    a re-run no longer selects it.

Run from the Render dashboard service's Shell tab (it has the Buffer +
Supabase + DASHBOARD_URL env vars):

    cd /opt/render/project/src && \
    PYTHONPATH=$PWD:$PWD/dashboard/python_deps \
    python -m scripts.rescue_misrouted_youtube_shorts          # dry run
    ... --apply                                                # do it
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from core.buffer import (
    _buffer_request,
    get_buffer_post_state,
    get_channel_id,
    send_to_buffer,
)
from core.database import get_client, record_buffer_handoff, sanitize_error_message
from core.log_safe import install_log_sanitizer
from core.media import build_proxy_url

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

# Channel names as stored in Buffer (verified via cron.buffer_introspect,
# 2026-09-10). Resolved to ids at runtime so this script never hardcodes ids.
WRONG_CHANNEL_NAME = "MoreMozi"
RIGHT_CHANNEL_NAME = "Alex Hormozi"  # keep in sync with core.video_batch

# Pace Buffer calls (each post costs ~2-3 requests) well under the rolling
# ~100-req/15-min window shared with the publishing crons.
INTER_POST_SLEEP_SECONDS = 2.0


def find_misrouted(wrong_channel_id: str) -> list[dict]:
    """Return manual-upload YouTube rows whose replay targets the wrong channel.

    The channel filter runs in Python rather than SQL: buffer_replay is nested
    jsonb and this is a one-off over a handful of rows, so a plain fetch plus
    a list comprehension is simpler than a jsonb path filter.
    """
    rows = (
        get_client()
        .table("posts")
        .select("id, title, caption, platform_post_id, metadata, created_at")
        .eq("platform", "youtube")
        .eq("status", "sent_to_buffer")
        .filter("metadata->>source", "eq", "manual_upload")
        .not_.is_("platform_post_id", "null")
        .order("created_at", desc=False)
        .execute()
        .data
    ) or []
    return [
        r
        for r in rows
        if ((r.get("metadata") or {}).get("buffer_replay") or {}).get("channel_id")
        == wrong_channel_id
    ]


def try_delete_buffer_post(buffer_post_id: str) -> bool:
    """Best-effort delete of the old misrouted post from Buffer's queue.

    The repo has never needed a delete mutation before, so this shape is a
    reasonable guess at Buffer's schema — if it's wrong the request fails
    validation server-side (no side effects) and we fall back to manual
    deletion in Buffer's UI. Returns True only on confirmed success.
    """
    try:
        data = _buffer_request(
            """
            mutation DeletePost($id: PostId!) {
                deletePost(input: { id: $id }) {
                    __typename
                    ... on MutationError { message }
                }
            }
            """,
            {"id": buffer_post_id},
        )
        result = data.get("deletePost") or {}
        if result.get("message"):
            logger.warning(
                "Buffer refused to delete %s: %s", buffer_post_id, result["message"]
            )
            return False
        return True
    except Exception as exc:
        logger.warning(
            "Could not delete old Buffer post %s (delete it manually in Buffer): %s",
            buffer_post_id, sanitize_error_message(str(exc)),
        )
        return False


def rescue(apply: bool, skip_ids: set[str]) -> int:
    wrong_id = get_channel_id(service="youtube", name=WRONG_CHANNEL_NAME)
    right_id = get_channel_id(service="youtube", name=RIGHT_CHANNEL_NAME)

    rows = find_misrouted(wrong_id)
    print(f"Found {len(rows)} misrouted YouTube post(s) "
          f"({WRONG_CHANNEL_NAME} -> {RIGHT_CHANNEL_NAME}):\n")

    moved = 0
    for row in rows:
        post_id = row["id"]
        old_buffer_id = row["platform_post_id"]
        title = row.get("title") or "(no title)"
        label = f"{post_id}  {title!r}  (Buffer {old_buffer_id})"

        if post_id in skip_ids:
            print(f"  SKIP (--skip): {label}")
            continue

        # Ask Buffer what actually happened to the old post before touching it.
        state = get_buffer_post_state(old_buffer_id)
        status = (state or {}).get("status")
        if status == "sent":
            # Already live on the wrong channel — re-sending would double-post
            # the video, so this one needs a human decision (delete it on
            # MoreMozi and re-upload, or leave it).
            print(f"  SKIP (already published on {WRONG_CHANNEL_NAME}): {label}")
            continue

        if not apply:
            print(f"  WOULD MOVE (old status: {status or 'gone from Buffer'}): {label}")
            continue

        # Replay carries the exact hand-off payload: body text, the YouTube
        # publisher metadata block (Buffer rejects a YouTube post without a
        # category), and the 5000-char caption limit.
        replay = (row.get("metadata") or {}).get("buffer_replay") or {}
        try:
            new_buffer_id = send_to_buffer(
                right_id,
                replay.get("body") or row.get("caption") or "",
                build_proxy_url(post_id),
                replay.get("media_type") or "video",
                youtube=replay.get("youtube"),
                caption_limit=replay.get("caption_limit"),
            )
        except Exception as exc:
            print(f"  FAILED to re-send: {label}: {sanitize_error_message(str(exc))}")
            time.sleep(INTER_POST_SLEEP_SECONDS)
            continue

        # Re-stamp the row: new Buffer id + replay now pointing at the right
        # channel (which also makes this script idempotent). Preserve the rest
        # of the metadata (source, video_batch_job_id, storage_cleanup_status)
        # by passing it as the base minus the old replay block.
        base_metadata = {
            k: v for k, v in (row.get("metadata") or {}).items()
            if k != "buffer_replay"
        }
        record_buffer_handoff(
            post_id, new_buffer_id,
            channel_id=right_id,
            body=replay.get("body") or row.get("caption") or "",
            media_type=replay.get("media_type") or "video",
            youtube=replay.get("youtube"),
            caption_limit=replay.get("caption_limit"),
            base_metadata=base_metadata,
        )

        # Only after the re-send is safely queued: clear the old post so it
        # can't eventually publish on the wrong channel.
        if state is None:
            deleted = True  # already gone from Buffer, nothing to delete
        else:
            deleted = try_delete_buffer_post(old_buffer_id)
        cleanup = "old post deleted" if deleted else \
            f"DELETE OLD POST MANUALLY in Buffer ({WRONG_CHANNEL_NAME}): {old_buffer_id}"
        print(f"  MOVED -> new Buffer id {new_buffer_id} ({cleanup}): {label}")
        moved += 1
        time.sleep(INTER_POST_SLEEP_SECONDS)

    if not apply:
        print("\nDry run — nothing was sent. Re-run with --apply to execute.")
    else:
        print(f"\nDone: {moved} post(s) moved to {RIGHT_CHANNEL_NAME}.")
    return 0


def main() -> None:
    install_log_sanitizer()
    parser = argparse.ArgumentParser(
        description="Re-route misrouted manual-upload YouTube Shorts in Buffer."
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually re-send and delete. Default is a dry run.",
    )
    parser.add_argument(
        "--skip", default="",
        help="Comma-separated posts-row ids to leave untouched.",
    )
    args = parser.parse_args()
    skip_ids = {s.strip() for s in args.skip.split(",") if s.strip()}
    sys.exit(rescue(apply=args.apply, skip_ids=skip_ids))


if __name__ == "__main__":
    main()
