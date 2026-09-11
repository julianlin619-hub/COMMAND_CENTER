"""Cross-post ONE Instagram outlier-tweet carousel to Alex's LinkedIn.

The weekly instagram-carousel cron (cron/instagram_carousel_pipeline.py)
renders ten 1080x1350 tweet cards per run and ships them to Instagram via
Buffer. Those rendered slides already live in Supabase Storage, referenced
by the carousel's `posts` row — so re-posting a carousel to LinkedIn needs
NO re-render: we insert a new `posts` row for platform='linkedin' that
points at the SAME storage paths, and hand Buffer one multi-image post
(multiple image assets on a LinkedIn channel publish as a multi-image
"carousel-style" post, exactly like the IG send in the carousel pipeline).

Run this ONCE per invocation — it posts at most one carousel:

  1. INVENTORY — list every live IG carousel row ("the bank"): platform=
     'instagram', metadata.source='carousel', status not failed/buffer_error.
     Mirrors _fetch_carousel_history in the carousel pipeline so both jobs
     agree on what counts as a real, shipped carousel.
  2. PICK — choose the lowest Day number not yet cross-posted, so repeated
     invocations walk the "Day N" series in order (Day 1 first), the same
     order LinkedIn followers would expect the series to appear in.
  3. SEND — insert the linkedin posts row (status='sent_to_buffer'), then
     ONE Buffer send with an indexed proxy URL per slide, then stamp the
     Buffer post id (record_buffer_handoff) so cron/buffer_reconcile.py
     can confirm publish / replay it like every other Buffer post.

Dedup (why a re-run can't double-post the same carousel):
  - Each cross-post row's caption is the carousel's series label
    ("Outlier carousel (Day N)") — unique per day — so the existing
    partial-unique (platform, md5(caption)) index arbitrates even two
    concurrent runs at the DB level. (Slide-1 tweet text would be the
    wrong caption here: the daily tweet-card fan-out also posts single
    cards to LinkedIn, and a coincidental slide-1 collision with one of
    those would block the whole carousel for no good reason.)
  - metadata.original_post_id on each cross-post row is the ledger the
    PICK phase reads, so already-shipped days never even get selected.

Deliberately NOT a cron: the operator asks for one cross-post at a time.
Trigger it from the GitHub Actions workflow (workflow_dispatch) or run
locally with the usual env vars.

Required env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY  — posts table (read + insert)
  BUFFER_ACCESS_TOKEN, BUFFER_ORG_ID  — channel lookup + queue send
  DASHBOARD_URL                       — base for the /api/media proxy URLs

Dry run (inventory + pick + channel lookup, ZERO writes, no Buffer send):
  CROSSPOST_DRY_RUN=1 python scripts/crosspost_carousel_to_linkedin.py
"""

from __future__ import annotations

import logging
import os
import sys

from core.buffer import get_channel_id, send_to_buffer
from core.database import (
    get_client,
    insert_post,
    log_cron_finish,
    log_cron_start,
    post_caption_exists,
    record_buffer_handoff,
    sanitize_error_message,
    update_post,
)
from core.env_diag import log_env_diagnostics
from core.media import build_proxy_url
from core.models import Post
from cron._tweet_card_legs import BUFFER_CAPTION, _is_unique_violation

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Tag on every cross-post row. The PICK phase filters on it to build the
# "already cross-posted" ledger, and the dashboard can use it to tell these
# rows apart from the daily single-card LinkedIn posts.
SOURCE_TAG = "linkedin_carousel_crosspost"

# The IG carousel rows this script feeds on (must match the carousel
# pipeline's SOURCE_TAG so both sides agree on what a carousel row is).
IG_CAROUSEL_SOURCE = "carousel"

# Same channel the daily tweet-card fan-out posts to. The org has TWO
# service='linkedin' channels (Alex's and Leila's), so the name pin is
# load-bearing — an unpinned lookup returns whichever Buffer lists first.
# Mirrors resolve_extra_channel_ids in cron/_tweet_card_legs.py.
LINKEDIN_CHANNEL_NAME = "alexhormozi"


def _live_rows(platform: str, source: str) -> list[dict]:
    """Fetch non-dead posts rows for a platform + metadata.source tag.

    "Live" excludes failed/buffer_error — the same definition the carousel
    pipeline and the dedup index use, so a cross-post whose Buffer send
    failed frees its carousel to be retried by the next invocation.
    """
    rows = (
        get_client()
        .table("posts")
        .select("id,status,caption,media_urls,metadata,created_at")
        .eq("platform", platform)
        .eq("metadata->>source", source)
        .execute()
        .data
        or []
    )
    return [r for r in rows if r.get("status") not in ("failed", "buffer_error")]


def _series_label(day: object) -> str:
    """The carousel's human-readable series marker, used as our dedup caption.

    Must produce the same string for the same day every run (it's what the
    (platform, md5(caption)) unique index arbitrates on).
    """
    return f"Outlier carousel (Day {day})"


def _pick_candidate(
    carousels: list[dict], crossposted: list[dict]
) -> tuple[dict | None, list[dict]]:
    """Return (chosen carousel row | None, all not-yet-crossposted rows).

    Exclusion is belt-and-braces: a carousel is "used" if any live cross-post
    row points at it by original_post_id OR carries the same day number —
    two keys so one malformed ledger row can't cause a double-post.
    """
    used_ids = set()
    used_days = set()
    for row in crossposted:
        meta = row.get("metadata") or {}
        if meta.get("original_post_id"):
            used_ids.add(str(meta["original_post_id"]))
        if meta.get("day") is not None:
            used_days.add(meta["day"])

    available = []
    for row in carousels:
        meta = row.get("metadata") or {}
        day = meta.get("day")
        slides = row.get("media_urls") or []
        if str(row["id"]) in used_ids or (day is not None and day in used_days):
            continue
        # A carousel row must carry its full slide set (the pipeline only
        # ever ships complete 10-slide sets; 2 is a defensive floor). A row
        # without usable media can't be cross-posted, so skip it loudly
        # rather than sending a broken post.
        if not isinstance(slides, list) or not (2 <= len(slides) <= 10):
            logger.warning(
                "Skipping carousel %s (day %s) — unexpected media_urls length %s",
                row["id"], day, len(slides) if isinstance(slides, list) else "n/a",
            )
            continue
        available.append(row)

    # Lowest day first so the LinkedIn series replays in original order.
    # Rows missing a day number (shouldn't exist) sort last by created_at.
    available.sort(
        key=lambda r: (
            (r.get("metadata") or {}).get("day") is None,
            (r.get("metadata") or {}).get("day") or 0,
            r.get("created_at") or "",
        )
    )

    for row in available:
        day = (row.get("metadata") or {}).get("day")
        label = _series_label(day)
        # Final guard beyond the ledger: if ANY live linkedin row already
        # carries this exact caption (e.g. a cross-post inserted by hand),
        # skip to the next day rather than tripping the unique index.
        if post_caption_exists("linkedin", label):
            logger.info("Day %s already has a LinkedIn row with caption %r — skipping", day, label)
            continue
        return row, available
    return None, available


def main() -> None:
    dry_run = os.environ.get("CROSSPOST_DRY_RUN", "") == "1"

    log_env_diagnostics(
        "crosspost-carousel-to-linkedin",
        required=[
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "BUFFER_ACCESS_TOKEN",
            "BUFFER_ORG_ID",
            "DASHBOARD_URL",
        ],
        optional=["CROSSPOST_DRY_RUN"],
    )

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 1: Inventory — what's in the carousel bank, what's already gone
    # ─────────────────────────────────────────────────────────────────────
    carousels = _live_rows("instagram", IG_CAROUSEL_SOURCE)
    crossposted = _live_rows("linkedin", SOURCE_TAG)

    def _day(row: dict) -> object:
        return (row.get("metadata") or {}).get("day", "?")

    logger.info(
        "Carousel bank: %d live Instagram carousel(s) — days %s",
        len(carousels), sorted(str(_day(r)) for r in carousels),
    )
    logger.info(
        "Already cross-posted to LinkedIn: %d — days %s",
        len(crossposted), sorted(str(_day(r)) for r in crossposted),
    )

    chosen, available = _pick_candidate(carousels, crossposted)

    print("CROSSPOST INVENTORY: "
          f"bank={len(carousels)} crossposted={len(crossposted)} "
          f"available={len(available)} "
          f"available_days={sorted(str(_day(r)) for r in available)}")

    if chosen is None:
        # Nothing to do is a SUCCESS, not an error: the operator asked
        # "if there's any in the bank" — an empty bank answers that.
        print("CROSSPOST RESULT: nothing-available — no carousel cross-posted.")
        return

    day = _day(chosen)
    label = _series_label(day)
    slides = chosen["media_urls"]
    logger.info(
        "Chosen: Day %s (post %s, %d slides, slide-1 text: %.60r)",
        day, chosen["id"], len(slides), chosen.get("caption") or "",
    )

    # Resolve the Buffer channel BEFORE writing anything: if the token is
    # stale or the channel is gone we want a clean failure with zero rows
    # inserted, not an orphaned sent_to_buffer row.
    channel_id = get_channel_id(service="linkedin", name=LINKEDIN_CHANNEL_NAME)

    if dry_run:
        print(
            "CROSSPOST RESULT: DRY RUN — would cross-post "
            f"Day {day} ({len(slides)} slides, original post {chosen['id']}) "
            f"to LinkedIn channel {channel_id}. No DB writes, no Buffer send."
        )
        return

    # ─────────────────────────────────────────────────────────────────────
    # PHASE 2: Insert-first-then-send (same pattern as every Buffer path)
    # ─────────────────────────────────────────────────────────────────────
    run_id = log_cron_start(platform="linkedin", job_type="carousel_crosspost")

    metadata = {
        "source": SOURCE_TAG,
        # The ledger key future runs dedup against.
        "original_post_id": str(chosen["id"]),
        "day": day,
        "title": label,
        # Carried over for provenance so the dashboard can show which
        # tweets are on this cross-post without joining to the IG row.
        "tweet_ids": (chosen.get("metadata") or {}).get("tweet_ids", []),
    }
    post = Post(
        platform="linkedin",
        status="sent_to_buffer",
        media_type="carousel",
        # Same storage objects the IG carousel rendered — no re-render.
        media_urls=list(slides),
        caption=label,
        metadata=metadata,
    )
    try:
        post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            # A concurrent run beat us to this day — that run owns the send.
            print(f"CROSSPOST RESULT: lost dedup race — Day {day} already inserted elsewhere.")
            log_cron_finish(run_id, status="success", posts_processed=0)
            return
        log_cron_finish(run_id, status="failed", error_message=str(e))
        raise

    try:
        # One indexed proxy URL per slide (they re-sign on every Buffer
        # fetch, so queue time doesn't matter). Multiple image assets in a
        # single createPost is what Buffer publishes as a multi-image post
        # on LinkedIn — the same shape the IG carousel send uses.
        media_urls = [build_proxy_url(post_id, i) for i in range(len(slides))]
        buffer_post_id = send_to_buffer(
            channel_id,
            BUFFER_CAPTION,  # blank — the content is on the cards
            media_urls,
            media_type="image",
        )
    except Exception as e:
        # Flip to buffer_error so the row leaves the dedup index and this
        # day is retried by the next invocation.
        logger.error("Buffer send failed: %s", sanitize_error_message(str(e)))
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error("Also failed to mark post %s as buffer_error: %s", post_id, db_err)
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    try:
        record_buffer_handoff(
            post_id, buffer_post_id,
            channel_id=channel_id,
            body=BUFFER_CAPTION,
            media_type="image",
            base_metadata=metadata,
        )
    except Exception as e:
        # The Buffer post EXISTS at this point — do NOT flip to buffer_error
        # (that would free the dedup index and a re-run would double-post).
        # A missing replay stamp only costs us reconcile coverage for this
        # one post; log it loudly and let the operator stamp it by hand.
        logger.error(
            "Buffer post %s created but stamping post %s failed: %s",
            buffer_post_id, post_id, sanitize_error_message(str(e)),
        )
        log_cron_finish(run_id, status="failed", error_message=str(e))
        sys.exit(1)

    log_cron_finish(run_id, status="success", posts_processed=1)
    print(
        "CROSSPOST RESULT: queued "
        f"Day {day} ({len(slides)} slides) to Alex's LinkedIn Buffer queue — "
        f"posts row {post_id}, Buffer post {buffer_post_id}. "
        "Buffer publishes it at the channel's next open queue slot."
    )


if __name__ == "__main__":
    main()
