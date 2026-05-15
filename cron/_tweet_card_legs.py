"""Shared Facebook + LinkedIn + Instagram fan-out logic for the unified Tweet Card pipelines.

Both cron/tiktok_pipeline.py and cron/tiktok_bank_pipeline.py call into
this module after their TikTok render succeeds, so the per-tweet
FB/LI/IG Buffer-send logic stays in one place.

This file owns:
  - The extra `generate_content` calls for `platform='facebook'` and
    `platform='linkedin'` (one call per platform, batched over all
    TikTok-passing tweets).
  - The per-leg insert-then-send dance to Buffer, mirroring the exact
    pattern the deleted cron/{facebook,linkedin}_*_pipeline.py files used
    (insert posts row → dedup-via-unique-index → signed URL → Buffer send
    → stamp buffer_post_id, or flip to buffer_error on send failure).

The Instagram feed-post leg reuses the Facebook 1080×1080 PNG byte-for-
byte rather than re-rendering — same format, same template, same content.
This is intentional: an Instagram-specific render variant doesn't exist
in /api/content-gen/generate today, and the static 1:1 quote card is the
only piece of content we ship to Instagram (Buffer's
instagram_post_type='post' lands it in the feed; we no longer cross-post
the TikTok MP4 as an IG Reel).

Lives under cron/ (not core/) because it does cron-loop concerns —
post-row writes and Buffer sends — rather than platform-adapter
primitives. The underscore prefix marks it strictly internal to cron/.
"""

from __future__ import annotations

import logging
from typing import Any

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.database import (
    insert_post,
    post_caption_exists,
    update_post,
)
from core.media import get_signed_url
from core.models import Post


logger = logging.getLogger(__name__)

# Postgres unique-constraint violation code. Raised by postgrest as
# APIError.code when the dedup partial-unique index from
# migration 20260412105433_rls_and_dedup.sql fires.
_PG_UNIQUE_VIOLATION = "23505"

# Hardcoded engagement hook — same caption every leg uses on every
# platform today. Lives here (instead of as a per-platform constant)
# because it's identical across TikTok/FB/LI and the unified pipelines
# treat it as a single string.
BUFFER_CAPTION = "Agree?"

# 7-day signed-URL expiry. Buffer queues content for hours or days
# before downloading it, so a short expiry risks the URL dying before
# Buffer fetches the asset. Matches the value used by every legacy
# pipeline that was merged into the unified flow.
SIGNED_URL_EXPIRES_IN = 604800


def _is_unique_violation(exc: Exception) -> bool:
    """True if exc is a Postgres unique-constraint violation.

    We use the dedup partial-unique index as the source of truth for
    "already sent" — that's more reliable than an app-level check which
    can race against concurrent runs. Works across supabase-py versions
    by inspecting both the exception's .code attr and its string form.
    """
    code = getattr(exc, "code", "") or ""
    message = str(exc).lower()
    return (
        _PG_UNIQUE_VIOLATION in code
        or _PG_UNIQUE_VIOLATION in message
        or "duplicate key" in message
    )


def render_extra_platforms(
    *,
    dashboard_url: str,
    cron_secret: str,
    tweets: list[dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """Render the Facebook + LinkedIn variants for a batch of tweets.

    Calls /api/content-gen/generate twice — once with platform='facebook'
    (1080×1080 PNG) and once with platform='linkedin' (1080×1080 PNG with
    LinkedIn color overrides). The TikTok render is the caller's
    responsibility and happens before this function is invoked.

    `tweets` items must be the same {'id', 'text', ...} shape that the
    TikTok render received — we re-use the IDs as keys in the result.

    Returns a mapping:
        {'facebook': {tweet_id: storage_path, ...},
         'linkedin': {tweet_id: storage_path, ...}}

    A platform that fails entirely (network error, API 5xx after retries,
    empty response) yields an empty dict for that platform — the caller
    will skip its leg per-tweet when the lookup returns None. Per-tweet
    errors inside a platform's response are simply omitted from the
    mapping for that platform. NEVER raises: TikTok publishes must not be
    blocked by FB/LI render hiccups.
    """
    payload_tweets = [{"id": t["id"], "text": t["text"]} for t in tweets]
    result: dict[str, dict[str, str]] = {"facebook": {}, "linkedin": {}}

    for platform in ("facebook", "linkedin"):
        try:
            data = generate_content(
                dashboard_url=dashboard_url,
                cron_secret=cron_secret,
                tweets=payload_tweets,
                platform=platform,
            )
        except Exception as e:
            # generate_content already retries on 5xx/network errors;
            # if it propagates here the whole platform leg is bust.
            logger.warning(
                "%s render leg failed entirely (skipping leg for this run): %s",
                platform, e,
            )
            continue

        if data.get("error"):
            logger.warning("%s render leg returned top-level error: %s", platform, data["error"])
            continue

        api_errors = data.get("errors", []) or []
        for i, err in enumerate(api_errors):
            logger.warning("  %s render error[%d]: %s", platform, i, err)

        for item in data.get("generated", []) or []:
            tweet_id = item.get("id")
            storage_path = item.get("storagePath")
            if tweet_id and storage_path:
                result[platform][str(tweet_id)] = storage_path

        logger.info(
            "%s render: %d images generated (%d errors)",
            platform, len(result[platform]), len(api_errors),
        )

    return result


def send_leg(
    *,
    platform: str,
    channel_id: str,
    storage_path: str,
    caption: str,
    source_tag: str,
    extra_send_kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Insert posts row, signed-URL, Buffer-send, stamp the post.

    The `caption` argument here is the tweet text — that's what `Post.caption`
    stores (for dedup against the partial-unique index on
    (platform, md5(caption))). What Buffer actually publishes is always
    BUFFER_CAPTION ("Agree?"), the short engagement hook — every legacy
    per-platform cron used a separate constant for the Buffer body, and
    this helper preserves that behavior. Treating `caption` as the post
    body would publish a truncated tweet excerpt that duplicates text
    already burned into the rendered image.

    Mirrors the insert-first-then-send pattern that the deleted FB/LI
    pipelines used: we attempt the DB insert first so the partial-unique
    index in migration 004_rls_and_dedup.sql can arbitrate concurrent
    runs. If Buffer rejects the send we flip the row to
    `status='buffer_error'`, which releases it from the dedup index and
    allows a future run to retry.

    Returns a result dict — NEVER raises:
        {'status': 'sent' | 'duplicate' | 'db_failed' | 'buffer_failed',
         'post_id':        str | None,
         'buffer_post_id': str | None,
         'error':          str | None}
    """
    extra_send_kwargs = extra_send_kwargs or {}
    # Platform → media-type mapping is fixed and small enough to inline.
    # TikTok ships MP4s; Facebook and LinkedIn ship square PNGs.
    media_type = "video" if platform == "tiktok" else "image"

    post = Post(
        platform=platform,
        status="sent_to_buffer",
        media_type=media_type,
        media_urls=[storage_path],
        # posts.caption stores the *tweet text* because that's what
        # the dedup partial-unique index keys on. The Buffer-side
        # post body (BUFFER_CAPTION) is sent below, not stored.
        caption=caption,
        # Preserve outlier/bank classification on the row even though
        # no downstream cron reads it anymore — useful for audit and
        # for filtering rows in the dashboard.
        metadata={"source": source_tag},
    )

    try:
        post_id = insert_post(post)
    except Exception as e:
        if _is_unique_violation(e):
            logger.info(
                "[%s] dedup race lost (DB constraint) — skipping %s...",
                platform, caption[:50],
            )
            return {
                "status": "duplicate",
                "post_id": None,
                "buffer_post_id": None,
                "error": None,
            }
        logger.error("[%s] insert_post failed for %s: %s", platform, storage_path, e, exc_info=True)
        return {
            "status": "db_failed",
            "post_id": None,
            "buffer_post_id": None,
            "error": str(e),
        }

    try:
        media_url = get_signed_url(storage_path, expires_in=SIGNED_URL_EXPIRES_IN)
        # BUFFER_CAPTION ("Agree?") is what Buffer publishes — never
        # the tweet text. The tweet text is already rendered onto the
        # image and would duplicate visually if sent again.
        buffer_post_id = send_to_buffer(
            channel_id, BUFFER_CAPTION, media_url,
            media_type=media_type,
            **extra_send_kwargs,
        )
        update_post(post_id, platform_post_id=buffer_post_id)
        logger.info("[%s] sent to Buffer: %s (Buffer post %s)", platform, storage_path, buffer_post_id)
        return {
            "status": "sent",
            "post_id": post_id,
            "buffer_post_id": buffer_post_id,
            "error": None,
        }
    except Exception as e:
        # Flip to buffer_error so the row drops out of the dedup index
        # and a future run can retry this caption. Nested try because
        # update_post raises on no-match — a DB blip here would shadow
        # the real Buffer error.
        logger.error("[%s] Buffer send failed for %s: %s", platform, storage_path, e, exc_info=True)
        try:
            update_post(post_id, status="buffer_error", error_message=str(e)[:500])
        except Exception as db_err:
            logger.error(
                "[%s] also failed to mark post %s as buffer_error: %s",
                platform, post_id, db_err,
            )
        return {
            "status": "buffer_failed",
            "post_id": post_id,
            "buffer_post_id": None,
            "error": str(e),
        }


def fanout_extra_legs_for_one_tweet(
    *,
    tweet_caption: str,
    fb_storage_path: str | None,
    li_storage_path: str | None,
    fb_channel_id: str | None,
    li_channel_id: str | None,
    ig_channel_id: str | None,
    source_tag: str,
) -> dict[str, dict[str, Any]]:
    """Send the Facebook + LinkedIn + Instagram legs for a single tweet.

    Called by both unified pipelines inside their Phase 4 / `buffer_send`
    loop, right after the TikTok send for the same tweet succeeds. Each
    leg can independently skip when:
      - its storage_path is None (render dropped this tweet for this
        platform — graceful degrade, the next day's run will retry the
        leg now that TikTok's already shipped),
      - its channel_id is None (channel lookup failed once for the whole
        run, so we know the leg cannot ship today),
      - the caption already exists in posts for that platform (per-leg
        dedup, mirrors today's chain behavior).

    The Instagram leg reuses fb_storage_path (the 1080×1080 PNG) — same
    image bytes as Facebook, queued to Buffer as instagram_post_type='post'
    so it lands in the IG feed. We do not ship anything to Instagram as
    a Reel anymore. If the Facebook render failed for this tweet, the
    Instagram leg also skips (skipped_no_render) because there's no PNG
    to share.

    Returns:
        {'facebook':  {<send_leg result> | <skip reason>},
         'linkedin':  {<send_leg result> | <skip reason>},
         'instagram': {<send_leg result> | <skip reason>}}

    Skip reasons use `status` values: 'skipped_no_render',
    'skipped_no_channel', 'skipped_dedup'.
    """
    return {
        "facebook": _send_or_skip(
            platform="facebook",
            channel_id=fb_channel_id,
            storage_path=fb_storage_path,
            caption=tweet_caption,
            source_tag=source_tag,
            extra_send_kwargs={"facebook_post_type": "post"},
        ),
        "linkedin": _send_or_skip(
            platform="linkedin",
            channel_id=li_channel_id,
            storage_path=li_storage_path,
            caption=tweet_caption,
            source_tag=source_tag,
            extra_send_kwargs={},
        ),
        "instagram": _send_or_skip(
            platform="instagram",
            channel_id=ig_channel_id,
            # Reuse the FB 1:1 PNG — same template, same image bytes.
            # An Instagram-specific render variant doesn't exist in
            # /api/content-gen/generate today, and the user wants
            # parity with Facebook's static feed post.
            storage_path=fb_storage_path,
            caption=tweet_caption,
            source_tag=source_tag,
            # Buffer's IG integration needs metadata.instagram.type to
            # know this is a feed post (not a reel/story).
            extra_send_kwargs={"instagram_post_type": "post"},
        ),
    }


def _send_or_skip(
    *,
    platform: str,
    channel_id: str | None,
    storage_path: str | None,
    caption: str,
    source_tag: str,
    extra_send_kwargs: dict[str, Any],
) -> dict[str, Any]:
    """Wrap send_leg with the upstream skip-conditions a fan-out needs."""
    if storage_path is None:
        return {"status": "skipped_no_render", "post_id": None, "buffer_post_id": None, "error": None}
    if channel_id is None:
        return {"status": "skipped_no_channel", "post_id": None, "buffer_post_id": None, "error": None}
    if not caption or not caption.strip():
        # Buffer rejects empty captions; mirror the guard from the old
        # pipelines (don't insert a row we know cannot ship).
        return {"status": "skipped_empty_caption", "post_id": None, "buffer_post_id": None, "error": None}
    if post_caption_exists(platform, caption):
        # Pre-insert dedup. The DB unique-index is still the source of
        # truth (handled inside send_leg), but skipping here avoids the
        # noise of an attempted-insert-then-rollback every duplicate.
        logger.debug("[%s] skipping duplicate (pre-insert): %s...", platform, caption[:50])
        return {"status": "skipped_dedup", "post_id": None, "buffer_post_id": None, "error": None}

    return send_leg(
        platform=platform,
        channel_id=channel_id,
        storage_path=storage_path,
        caption=caption,
        source_tag=source_tag,
        extra_send_kwargs=extra_send_kwargs,
    )


def resolve_extra_channel_ids() -> tuple[str | None, str | None, str | None]:
    """Look up Facebook + LinkedIn + Instagram Buffer channel IDs once per run.

    Returns (fb_channel_id, li_channel_id, ig_channel_id). Any can be
    None when the channel isn't connected in Buffer. A None result
    means the corresponding leg is skipped for the whole run via the
    `skipped_no_channel` short-circuit in fanout_extra_legs_for_one_tweet.
    """
    fb = _safe_channel_lookup("facebook")
    li = _safe_channel_lookup("linkedin")
    ig = _safe_channel_lookup("instagram")
    return fb, li, ig


def _safe_channel_lookup(service: str) -> str | None:
    try:
        return get_channel_id(service=service)
    except Exception as e:
        logger.warning(
            "Could not resolve Buffer %s channel ID — leg will be skipped for this run: %s",
            service, e,
        )
        return None


def summarize_leg_failures(leg_results: list[dict[str, dict[str, Any]]]) -> str | None:
    """Roll up per-tweet leg results into a one-line error_message summary.

    Each item of `leg_results` is the dict returned by
    `fanout_extra_legs_for_one_tweet` for one tweet. Counts only true
    failures (`db_failed`, `buffer_failed`), not dedup skips or
    no-render skips (which are expected, not errors).

    Returns None when nothing went wrong. The caller passes the string
    into `log_cron_finish(error_message=...)` — cron_runs has no
    `metadata` column, so this string is the only leg-health surface.
    """
    fb_failures = sum(
        1 for r in leg_results
        if r["facebook"]["status"] in {"db_failed", "buffer_failed"}
    )
    li_failures = sum(
        1 for r in leg_results
        if r["linkedin"]["status"] in {"db_failed", "buffer_failed"}
    )
    ig_failures = sum(
        1 for r in leg_results
        if r["instagram"]["status"] in {"db_failed", "buffer_failed"}
    )
    parts: list[str] = []
    if fb_failures:
        parts.append(f"facebook leg failures: {fb_failures}")
    if li_failures:
        parts.append(f"linkedin leg failures: {li_failures}")
    if ig_failures:
        parts.append(f"instagram leg failures: {ig_failures}")
    return ", ".join(parts) or None
