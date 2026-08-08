"""Shared Facebook + LinkedIn + Instagram fan-out logic for the unified Tweet Card pipelines.

Both cron/tiktok_pipeline.py and cron/tiktok_bank_pipeline.py call into
this module as their primary render + fan-out, so the per-tweet FB/LI/IG
Buffer-send logic stays in one place. (The TikTok leg those pipelines
were named after was retired in Aug 2026 — the operator stopped
publishing to TikTok. Facebook is the anchor leg now; the tiktok file
and cron_runs identities are kept for dashboard history continuity.)

This file owns:
  - One extra `generate_content` call for `platform='facebook'` (one
    call, batched over all TikTok-passing tweets) — its 1080×1080 PNG is
    reused for LinkedIn and Instagram.
  - The per-leg insert-then-send dance to Buffer, mirroring the exact
    pattern the deleted cron/{facebook,linkedin}_*_pipeline.py files used
    (insert posts row → dedup-via-unique-index → signed URL → Buffer send
    → stamp buffer_post_id, or flip to buffer_error on send failure).

The LinkedIn and Instagram feed-post legs reuse the Facebook 1080×1080
PNG byte-for-byte rather than re-rendering — same format, same template,
same content. This is intentional: LinkedIn-/Instagram-specific render
variants don't add enough visual difference to justify the extra
content-gen call per tweet, and the user explicitly opted into letting
these three platforms ship identical images.

Buffer-side platform metadata still differs per leg (e.g.
instagram_post_type='post' for IG feed, facebook_post_type='post' for
FB) — only the *image bytes* are shared.

Lives under cron/ (not core/) because it does cron-loop concerns —
post-row writes and Buffer sends — rather than platform-adapter
primitives. The underscore prefix marks it strictly internal to cron/.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from core.buffer import get_channel_id, send_to_buffer
from core.content_gen_client import generate_content
from core.database import (
    insert_post,
    post_caption_exists,
    record_buffer_handoff,
    update_post,
)
from core.media import build_proxy_url
from core.models import Post


logger = logging.getLogger(__name__)

# Postgres unique-constraint violation code. Raised by postgrest as
# APIError.code when the dedup partial-unique index from
# migration 20260412105433_rls_and_dedup.sql fires.
_PG_UNIQUE_VIOLATION = "23505"

# Visible Buffer caption every leg uses on every platform today. Lives
# here (instead of as a per-platform constant) because it's identical
# across FB/LI/IG and the unified pipelines treat it as a single string.
# Intentionally blank: the tweet text is already rendered onto the card,
# so the published post ships with no caption text.
BUFFER_CAPTION = ""


def instagram_card_format() -> str:
    """Return 'off' (default) or 'image' for the Instagram leg.

    Toggle, read from the IG_TWEET_CARD_FORMAT env var (matching the
    os.environ config style the pipelines use for TIKTOK_MIN_LIKES etc.):

      - 'off' (default): the Instagram leg is PAUSED — no IG render, no IG
        Buffer send. Instagram now gets its content from the standalone
        carousel cron (cron/instagram_carousel_pipeline.py) instead of the
        tweet-card fan-out. FB/LinkedIn legs are unaffected.
      - 'image': a portrait PNG feed *post* with no caption (the tweet
        text is already rendered onto the card).

    The old 'video' mode (re-shipping the TikTok MP4 as an IG reel) was
    removed along with the TikTok leg in Aug 2026 — there is no MP4 to
    reuse anymore. Restore both from git history together if needed.

    Any unrecognized value falls back to 'off' so a typo can't silently
    resurrect a paused leg. The operator flips this on Render without a
    code change.
    """
    val = os.environ.get("IG_TWEET_CARD_FORMAT", "off").strip().lower()
    return val if val == "image" else "off"


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
    """Render the Facebook + Instagram variants for a batch of tweets.

    Calls /api/content-gen/generate twice — once per render dimension:
      - platform='facebook'  → 1080×1080 PNG per tweet. Also reused for
        the LinkedIn fan-out leg (same visual design, the operator
        opted into FB/LI parity to save a render call).
      - platform='instagram' → 1080×1440 portrait PNG per tweet. Has
        its own template row so the height can diverge from FB's 1:1.

    This is the pipelines' primary render now that the TikTok leg is
    retired — the callers treat an empty Facebook map as fatal because
    nothing can ship without it. We don't render LinkedIn separately;
    `fanout_extra_legs_for_one_tweet` ships the Facebook bytes to LI's
    Buffer queue.

    `tweets` items must be {'id', 'text', ...} shaped — we re-use the
    IDs as keys in the result.

    Returns a mapping keyed by platform:
        {'facebook':  {tweet_id: storage_path, ...},
         'instagram': {tweet_id: storage_path, ...}}

    Each platform's sub-dict is independent: an Instagram render failure
    yields an empty IG dict but leaves the Facebook dict intact (and
    vice-versa). The fan-out's per-tweet skip logic handles missing
    storage paths via `_send_or_skip`.

    A failed render (network error, API 5xx after retries, empty
    response) yields an empty dict for that platform — the caller will
    skip every leg per-tweet when the lookup returns None. Per-tweet
    errors inside the response are simply omitted from the mapping.
    NEVER raises: an IG render hiccup must not block the FB/LI legs
    (the callers decide whether an empty FB map is fatal).
    """
    payload_tweets = [{"id": t["id"], "text": t["text"]} for t in tweets]
    result: dict[str, dict[str, str]] = {"facebook": {}, "instagram": {}}

    # Facebook always renders (it feeds the FB *and* LinkedIn legs). The
    # Instagram image render only happens in 'image' mode — in the default
    # 'off' mode the leg is paused entirely, so a portrait PNG would be
    # generated and never used. Skipping it here avoids paying for an extra
    # /api/content-gen/generate call per run. The returned dict keeps both
    # keys ({'instagram': {}} stays empty in 'off' mode) so callers and
    # the render-summary helpers are unaffected.
    render_platforms = ["facebook"]
    if instagram_card_format() == "image":
        render_platforms.append("instagram")

    # Each render call is independent — IG failures must not block the
    # FB leg (and FB failures must not block IG). The loop body is
    # intentionally identical for both, with the platform-specific
    # storage path coming back from the API itself.
    for platform in render_platforms:
        try:
            data = generate_content(
                dashboard_url=dashboard_url,
                cron_secret=cron_secret,
                tweets=payload_tweets,
                platform=platform,
            )
        except Exception as e:
            # generate_content already retries on 5xx/network errors;
            # if it propagates here the whole leg is bust for this run.
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
    buffer_body: str = BUFFER_CAPTION,
    media_type: str | None = None,
    extra_send_kwargs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Insert posts row, signed-URL, Buffer-send, stamp the post.

    The `caption` argument here is the tweet text — that's what `Post.caption`
    stores (for dedup against the partial-unique index on
    (platform, md5(caption))). `buffer_body` is what Buffer actually publishes
    as the visible caption on the social platform — defaults to BUFFER_CAPTION
    (currently blank) and can be overridden per-platform; every leg publishes
    with no caption text today (the tweet text is already rendered on the card).

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
    # Every current leg ships a PNG; callers that ever ship something else
    # pass media_type explicitly (the Instagram leg does, for clarity).
    if media_type is None:
        media_type = "image"

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
        # Permanent proxy URL — never expires. The /api/media/<post_id> endpoint
        # re-signs the Supabase storage path on every request, so Buffer always
        # gets a live download link even if the post sits in the queue for weeks.
        media_url = build_proxy_url(post_id)
        # buffer_body is what Buffer publishes — never the tweet text.
        # The tweet text is already rendered onto the image and would
        # duplicate visually if sent again. Defaults to BUFFER_CAPTION
        # (currently blank), so every leg ships a caption-free post.
        buffer_post_id = send_to_buffer(
            channel_id, buffer_body, media_url,
            media_type=media_type,
            **extra_send_kwargs,
        )
        # Persist the replay payload alongside platform_post_id so
        # cron/buffer_reconcile.py can re-send this exact post if Buffer
        # fails to publish it (buffer_body and channel_id/post-type live
        # only here).
        record_buffer_handoff(
            post_id, buffer_post_id,
            channel_id=channel_id,
            body=buffer_body,
            media_type=media_type,
            facebook_post_type=extra_send_kwargs.get("facebook_post_type"),
            instagram_post_type=extra_send_kwargs.get("instagram_post_type"),
            base_metadata={"source": source_tag},
        )
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
    ig_storage_path: str | None,
    fb_channel_id: str | None,
    li_channel_id: str | None,
    ig_channel_id: str | None,
    source_tag: str,
) -> dict[str, dict[str, Any]]:
    """Send the Facebook + LinkedIn + Instagram legs for a single tweet.

    Called by both unified pipelines inside their send-phase loop. Each
    leg can independently skip when:
      - its storage_path is None — the render dropped this tweet. FB
        and IG render independently, so an IG render failure only
        kills the IG leg, not FB/LI. (LinkedIn reuses the FB path, so
        an FB render failure still kills both FB and LI legs.)
      - its channel_id is None (channel lookup failed once for the whole
        run, so we know the leg cannot ship today),
      - the caption already exists in posts for that platform (per-leg
        dedup, mirrors today's chain behavior).

    Storage path sharing today:
      - facebook : fb_storage_path (1080×1080 PNG, FB's own render)
      - linkedin : fb_storage_path (reuses FB bytes — same image. Saves
                   a generate-call per tweet; operator opted into
                   FB/LI visual parity.)
      - instagram: depends on the IG_TWEET_CARD_FORMAT toggle
                   (see instagram_card_format()):
                     * 'off' (default) → leg is PAUSED: nothing renders or
                       ships to IG from this fan-out. The standalone
                       carousel cron owns Instagram now.
                     * 'image' → ig_storage_path (portrait PNG, IG's own
                       render from a dedicated template row), shipped as a
                       caption-free feed *post*.

    Buffer-side metadata still differs per leg (facebook_post_type='post',
    instagram_post_type='post', LinkedIn defaults) so each platform's
    Buffer integration receives the right hints.

    Returns:
        {'facebook':  {<send_leg result> | <skip reason>},
         'linkedin':  {<send_leg result> | <skip reason>},
         'instagram': {<send_leg result> | <skip reason>}}

    Skip reasons use `status` values: 'skipped_no_render',
    'skipped_no_channel', 'skipped_dedup', 'skipped_paused' (IG leg only,
    when IG_TWEET_CARD_FORMAT resolves to 'off').
    """
    # 'off' pauses the IG leg entirely (see instagram_card_format): report a
    # distinct skip status so the leg summary / logs show the leg was paused
    # deliberately, not dropped by a render or channel failure.
    # summarize_leg_failures only counts db_failed/buffer_failed, so a paused
    # leg never marks the run unhealthy.
    ig_result = (
        {"status": "skipped_paused", "post_id": None, "buffer_post_id": None, "error": None}
        if instagram_card_format() == "off"
        else _send_or_skip(
            platform="instagram",
            channel_id=ig_channel_id,
            # IG's own portrait render from the dedicated 'instagram'
            # template row. If the path is None for this tweet (the render
            # dropped it), _send_or_skip returns skipped_no_render — FB +
            # LI legs still ship on their own.
            storage_path=ig_storage_path,
            caption=tweet_caption,
            source_tag=source_tag,
            media_type="image",
            # Blank caption — the tweet text is already rendered onto the
            # card. Kept explicit so flipping BUFFER_CAPTION back to a hook
            # wouldn't accidentally caption the image post.
            buffer_body="",
            # Buffer's IG integration needs metadata.instagram.type;
            # 'post' is a plain feed image.
            extra_send_kwargs={"instagram_post_type": "post"},
        )
    )
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
            # Reuse the FB 1:1 PNG — same template, same image bytes.
            # Previously we made a second /api/content-gen/generate
            # call with platform='linkedin' for a palette override;
            # that's been removed to save a call/tweet (user
            # explicitly OK with LI/FB looking identical).
            storage_path=fb_storage_path,
            caption=tweet_caption,
            source_tag=source_tag,
            extra_send_kwargs={},
        ),
        "instagram": ig_result,
    }


def _send_or_skip(
    *,
    platform: str,
    channel_id: str | None,
    storage_path: str | None,
    caption: str,
    source_tag: str,
    buffer_body: str = BUFFER_CAPTION,
    media_type: str | None = None,
    extra_send_kwargs: dict[str, Any],
) -> dict[str, Any]:
    """Wrap send_leg with the upstream skip-conditions a fan-out needs."""
    if storage_path is None:
        return {"status": "skipped_no_render", "post_id": None, "buffer_post_id": None, "error": None}
    if channel_id is None:
        return {"status": "skipped_no_channel", "post_id": None, "buffer_post_id": None, "error": None}
    if not caption or not caption.strip():
        # The tweet text (caption) is used as the dedup key — it must
        # never be empty. (buffer_body can be empty, e.g. Instagram.)
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
        buffer_body=buffer_body,
        media_type=media_type,
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
    # Both TikTok pipelines post Alex's content — pin to Alex's LinkedIn channel
    # so the lookup doesn't accidentally return Leila's (Buffer returns the first
    # match when two LinkedIn channels exist in the same org).
    li = _safe_channel_lookup("linkedin", name="alexhormozi")
    ig = _safe_channel_lookup("instagram")
    return fb, li, ig


def _safe_channel_lookup(service: str, name: str | None = None) -> str | None:
    try:
        return get_channel_id(service=service, name=name)
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
