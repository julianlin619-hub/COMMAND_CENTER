"""Snapchat platform adapter — publishes via headless Chromium (Playwright).

Why Playwright and not an API?
    Snapchat has no usable upload API for unattended posting:
      - Snap Kit / Creative Kit require a user-tap confirmation flow.
      - The Marketing API is ads-only.
      - The public Stories API is invite-only.
    Browser automation against the Public Profile Web Uploader
    (profile.snapchat.com/<biz>/profiles/<profile>/web-uploader) is the only
    path for unattended posting to a creator's own Spotlight surface.

Session persistence:
    Playwright's BrowserContext is serialised to a JSON blob via
    `context.storage_state()` and stashed in the `platform_session_state`
    Supabase table. The operator seeds the row by running
    `scripts/capture_snapchat_auth.py` once (headed browser, manual login).
    Every successful publish refreshes the row so cookies stay rotated
    organically. If auth ever expires we screenshot the failure page,
    raise PlatformAuthError("AUTH_EXPIRED ..."), and the operator re-runs
    the capture script.

Required env vars:
    SNAPCHAT_PROFILE_URL — full URL of the creator's Web Uploader page,
        e.g. https://profile.snapchat.com/<biz>/profiles/<profile>/web-uploader.
"""

from __future__ import annotations

import logging
import os
import time

from core.database import get_client
from core.exceptions import PlatformAPIError, PlatformAuthError
from core.models import MediaUploadResult, Post
from platforms._snapchat_session import (
    StorageStateMissing,
    load_storage_state,
    save_storage_state,
)
from platforms.base import PlatformBase

logger = logging.getLogger(__name__)


# ── Selectors ──────────────────────────────────────────────────────────────
# Locked values from selector-discovery against the live Web Uploader DOM.
# Prefer Snap's data-testid attributes where they exist — they're stable
# across React class-name churn. Where there's no testid we use a
# semantic attribute selector (input type, placeholder substring) rather
# than a CSS class hash that changes every deploy.
#
# If a future Snap redesign breaks the publish path, re-run a Playwright
# Inspector session against the profile URL with saved storage state and
# update these constants. The first selector that fails will surface as a
# TimeoutError in process_due_posts and mark the affected post as failed
# without silently mis-clicking elsewhere.

# Left-rail nav element only rendered for an authenticated brand profile.
# Missing after page load = storage_state is expired → AUTH_EXPIRED.
SELECTOR_LOGGED_IN = '[data-testid="app.manageBrandProfile.sideNav"]'

# The <input type="file"> the page exposes for video selection. Targeted via
# locator(SELECTOR_FILE_INPUT).set_input_files(path) — Playwright handles the
# OS-level file picker automatically.
SELECTOR_FILE_INPUT = 'input[type="file"]'

# Destination checkbox: "Spotlight". Discovered during selector hunt — the
# Web Uploader requires at least one destination (Spotlight / Public Story /
# Save to Profile) to be ticked before the Post button enables. We check it
# pre-upload so SELECTOR_UPLOAD_READY (Post button enabled) implicitly waits
# for both upload completion AND a checked destination.
SELECTOR_SPOTLIGHT_CHECKBOX = 'input#spotlight'

# The Post button in its enabled state. Becomes non-disabled once the video
# upload finishes AND a destination checkbox is ticked — so waiting for this
# selector is a clean "ready to publish" signal that doesn't need a separate
# "upload progress" probe. Timeout is generous (120s) because Snap's
# server-side processing dominates on cold uploads.
SELECTOR_UPLOAD_READY = '[data-testid="app.profileMgr.snapPoster.postSnap"]:not([disabled])'

# Caption textarea. Placeholder text includes the word "description" — the
# DOM has no maxlength attribute (selector hunt confirmed maxLength = -1,
# meaning unenforced client-side), so caption truncation lives at the route
# layer instead. See SNAPCHAT_CAPTION_LIMIT in
# dashboard/src/app/api/snapchat-pipeline/route.ts.
SELECTOR_CAPTION = 'textarea[placeholder*="description"]'

# The Post / Publish button. Click triggers the actual server-side publish.
# Same testid as SELECTOR_UPLOAD_READY but without the :not([disabled])
# qualifier — we use the enabled-state probe to know when to click, and the
# bare selector for the click itself.
SELECTOR_POST_BUTTON = '[data-testid="app.profileMgr.snapPoster.postSnap"]'

# Confirmation that the post landed — Snap renders "Your Snap is now live"
# after the publish succeeds. Only when this resolves do we treat the post
# as published; without it, a click that was intercepted by a captcha or a
# server error would silently mark the post published in our DB.
SELECTOR_PUBLISH_SUCCESS = 'div:has-text("Your Snap is now live")'


# ── Constraints ────────────────────────────────────────────────────────────
# Snapchat Spotlight limits as of plan time. Captured here for the dashboard
# to validate uploads up-front; the publish path doesn't re-validate.
SPOTLIGHT_MAX_DURATION_SEC = 60
SPOTLIGHT_MAX_FILE_MB = 500
SPOTLIGHT_ASPECT_RATIOS = ["9:16"]


# ── Browser knobs ──────────────────────────────────────────────────────────
# 1440×900 because the Web Uploader's layout is tuned for laptop viewports
# and a 1920×1080 viewport surfaces a different DOM tree (different selectors).
# Pinning to match the captured session keeps selectors stable.
VIEWPORT = {"width": 1440, "height": 900}

# 30ms per keystroke for the caption — fast enough to finish a long caption
# inside the publish timeout, slow enough to clear Snap's anti-bot floor.
CAPTION_TYPE_DELAY_MS = 30

# The "media" bucket in Supabase Storage. Matches the IG / TikTok pipelines.
MEDIA_BUCKET = "media"

# Screenshots of auth failures land under this prefix in the same bucket.
# The publisher's failure path uploads here so the operator can open the
# saved screenshot from the dashboard's storage browser when debugging
# a flap.
AUTH_DEBUG_PREFIX = "snapchat-debug"


class Snapchat(PlatformBase):
    name = "snapchat"

    def __init__(self) -> None:
        # Read the env var eagerly so an obvious-misconfig surfaces during
        # adapter construction, not deep in the publish path. We still call
        # validate_config() from the cron explicitly for the env-diagnostic
        # log line, but the attribute access here also serves as a sanity check.
        self.profile_url = os.environ.get("SNAPCHAT_PROFILE_URL", "")

    # ── Configuration ────────────────────────────────────────────

    def validate_config(self) -> None:
        """Check that the Snapchat publisher's required env vars are set."""
        self._check_env_vars("SNAPCHAT_PROFILE_URL")

    # ── Authentication ───────────────────────────────────────────

    def refresh_credentials(self) -> None:
        """No-op — Playwright cookies refresh organically after each publish.

        See `create_post`: on a successful run we call `save_storage_state()`
        with the post-publish context, which rotates whatever cookies Snap
        updated during the session. There is no token-style refresh; auth
        either still works (cookies valid) or it doesn't (operator must
        re-run scripts/capture_snapchat_auth.py).
        """
        return

    def validate_credentials(self) -> bool:
        """Headless probe: can we still see the logged-in selector?

        Read-only by design — we deliberately do NOT call save_storage_state
        from this path. If a future operator triggers validate_credentials
        from the dashboard at the same time process_due_posts is publishing,
        two writers racing on the same row would land an older snapshot
        on top of the newer one. Only the publish path writes back.
        """
        if not self.profile_url:
            return False
        try:
            state = load_storage_state()
        except StorageStateMissing:
            return False

        # Lazy import — Playwright is heavy and the unit tests mock it out.
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                storage_state=state, viewport=VIEWPORT
            )
            page = context.new_page()
            try:
                page.goto(self.profile_url, wait_until="domcontentloaded")
                page.wait_for_selector(SELECTOR_LOGGED_IN, timeout=10_000)
                return True
            except Exception:
                return False
            finally:
                context.close()
                browser.close()

    # ── Posting ──────────────────────────────────────────────────

    def create_post(self, post: Post) -> str:
        """Publish a single post to Snapchat Spotlight via headless Chromium.

        Flow:
          1. Download the mp4 from Supabase Storage to /tmp.
          2. Load the saved storage_state from platform_session_state.
          3. Launch headless Chromium with playwright_stealth applied.
          4. Goto the profile URL; assert the logged-in selector.
          5. setInputFiles → wait for upload-ready → type caption → click Post.
          6. Wait for the success indicator. ONLY then save_storage_state.
          7. Return a synthetic platform_post_id (Snap doesn't surface one).

        Errors:
          - StorageStateMissing or missing logged-in selector → PlatformAuthError
            ("AUTH_EXPIRED — re-run scripts/capture_snapchat_auth.py"). The
            scheduler catches this and marks the post 'failed'; the operator
            re-runs the capture script to recover.
          - Any other Playwright/network error → PlatformAPIError, which the
            scheduler also marks 'failed'.

        The local mp4 is always cleaned up via try/finally, even if publish
        succeeds — /tmp is process-local but on Render's persistent disk we
        don't want to accumulate gigabytes of past videos.
        """
        if not post.id:
            # Defensive: process_due_posts sets post.id from the DB row before
            # calling us, but a future caller might forget. Without an id we
            # can't name the /tmp file or the debug screenshot.
            raise PlatformAPIError("Post missing id — required for /tmp filename")
        if not post.media_urls:
            raise PlatformAPIError("Post has no media_urls", status_code=400)

        local_path = f"/tmp/{post.id}.mp4"
        storage_path = post.media_urls[0]

        # Step 1: download mp4 from Supabase Storage. Use the service-key client
        # — same pattern as every other cron-side Supabase access in this repo.
        client = get_client()
        try:
            mp4_bytes = client.storage.from_(MEDIA_BUCKET).download(storage_path)
        except Exception as e:
            raise PlatformAPIError(
                f"Failed to download {storage_path} from Storage: {e}"
            ) from e
        with open(local_path, "wb") as f:
            f.write(mp4_bytes)

        try:
            # Step 2: load storage_state. Missing row = AUTH_EXPIRED — operator
            # never ran the capture script, or the row was wiped.
            try:
                state = load_storage_state()
            except StorageStateMissing as e:
                raise PlatformAuthError(
                    "AUTH_EXPIRED — re-run scripts/capture_snapchat_auth.py"
                ) from e

            # Lazy imports keep the module importable in test environments
            # where Playwright isn't installed yet. The unit tests mock these.
            from playwright.sync_api import sync_playwright
            from playwright_stealth import stealth_sync

            caption = post.caption or post.title or ""

            with sync_playwright() as pw:
                browser = pw.chromium.launch(headless=True)
                context = browser.new_context(
                    storage_state=state, viewport=VIEWPORT
                )
                page = context.new_page()
                # Apply stealth patches (navigator.webdriver fixes, plugin
                # spoofing, etc.). Python's playwright-stealth is weaker than
                # the Node equivalent — flagged in the plan's "Known limitations".
                stealth_sync(page)

                try:
                    # Step 4: navigate and assert auth.
                    page.goto(self.profile_url, wait_until="domcontentloaded")
                    try:
                        page.wait_for_selector(
                            SELECTOR_LOGGED_IN, timeout=15_000
                        )
                    except Exception as e:
                        # Auth probe failed — screenshot the page so the
                        # operator can see exactly what Snap served (login
                        # wall, captcha challenge, redirect, etc.). Then raise
                        # AUTH_EXPIRED so the scheduler marks the post failed
                        # without retrying.
                        self._save_auth_failure_screenshot(page, post.id)
                        raise PlatformAuthError(
                            "AUTH_EXPIRED — re-run scripts/capture_snapchat_auth.py"
                        ) from e

                    # Step 4b: tick the Spotlight destination checkbox. Snap
                    # requires at least one destination ticked before the Post
                    # button enables — discovered during selector hunt. The
                    # checkbox is interactive pre-upload, and ticking it here
                    # (rather than after setInputFiles) means SELECTOR_UPLOAD_READY
                    # serves as a unified "upload done AND destination chosen"
                    # signal in step 5.
                    page.check(SELECTOR_SPOTLIGHT_CHECKBOX)

                    # Step 5: upload + caption + click.
                    page.locator(SELECTOR_FILE_INPUT).set_input_files(local_path)
                    page.wait_for_selector(
                        SELECTOR_UPLOAD_READY, timeout=120_000
                    )
                    if caption:
                        page.locator(SELECTOR_CAPTION).type(
                            caption, delay=CAPTION_TYPE_DELAY_MS
                        )
                    page.locator(SELECTOR_POST_BUTTON).click()

                    # Step 6: wait for confirmation that the post actually
                    # landed. Without this, a click that was intercepted by
                    # a captcha or server error would silently mark the post
                    # published in our DB.
                    page.wait_for_selector(
                        SELECTOR_PUBLISH_SUCCESS, timeout=60_000
                    )

                    # Step 6b: persist refreshed cookies BEFORE returning so
                    # next run starts with the most recent session state.
                    # Wrapped — we'd rather log a save_storage_state failure
                    # than turn a successful Snap publish into a failed post.
                    try:
                        save_storage_state(context.storage_state())
                    except Exception as e:
                        logger.warning(
                            "save_storage_state failed after successful publish "
                            "(post=%s) — next run will use stale cookies: %s",
                            post.id, self.sanitize_error(e),
                        )

                    # Step 7: synthetic id. Snap's Web Uploader doesn't return
                    # a public post ID we can store. The timestamp suffix keeps
                    # the id unique across same-post retries — though v1 has
                    # no retry policy, future v2 retries shouldn't collide.
                    return f"snap-{post.id}-{int(time.time())}"
                finally:
                    context.close()
                    browser.close()
        finally:
            # Always clean up the local mp4. os.unlink raises if the file
            # never landed (e.g. download failed mid-write), so we swallow
            # FileNotFoundError to keep cleanup idempotent. Other OSErrors
            # bubble — they signal a real disk problem worth surfacing.
            try:
                os.unlink(local_path)
            except FileNotFoundError:
                pass

    def _save_auth_failure_screenshot(self, page, post_id: str) -> None:
        """Upload a debug screenshot of the failed auth page to Storage.

        Lands at media/snapchat-debug/<post_id>-auth-fail.png. The operator
        can open it from the dashboard's storage browser to see whether Snap
        served a login wall, a captcha, a region block, etc. — much faster
        than scraping Render logs for the same signal.

        Wrapped so a screenshot save failure can't shadow the AUTH_EXPIRED
        exception that's about to be raised by the caller.
        """
        try:
            png = page.screenshot(full_page=True)
            client = get_client()
            client.storage.from_(MEDIA_BUCKET).upload(
                f"{AUTH_DEBUG_PREFIX}/{post_id}-auth-fail.png",
                png,
                {"content-type": "image/png", "upsert": "true"},
            )
        except Exception as e:
            logger.warning(
                "Failed to save auth-failure screenshot for post %s: %s",
                post_id, self.sanitize_error(e),
            )

    # ── Media ────────────────────────────────────────────────────

    def upload_media(self, local_path: str, media_type: str) -> MediaUploadResult:
        """No-op — Snapchat takes the file inline via setInputFiles.

        There's no pre-upload step; the DOM <input type="file"> consumes the
        local mp4 directly when create_post runs. We return platform_media_id
        = None to signal that to any caller checking the result.
        """
        return MediaUploadResult(
            platform_media_id=None,
            metadata={"note": "Snapchat takes media inline via setInputFiles"},
        )

    def get_media_constraints(self) -> dict:
        """Snapchat Spotlight limits — used by the dashboard for pre-upload checks."""
        return {
            "max_video_duration_sec": SPOTLIGHT_MAX_DURATION_SEC,
            "max_file_size_mb": SPOTLIGHT_MAX_FILE_MB,
            "aspect_ratios": SPOTLIGHT_ASPECT_RATIOS,
            "supported_video_formats": ["mp4", "mov"],
        }

    # ── Error sanitisation ───────────────────────────────────────

    def sanitize_error(self, error: Exception) -> str:
        """Strip Snap-specific cookie names on top of the base redactor.

        Snap session cookies (sc-a-token, sc-a-session) sometimes appear in
        Playwright errors verbatim — e.g. when a goto() fails mid-redirect
        and the error includes the Cookie request header. The base regex
        catches 64+ char alphanumerics, which covers most Snap tokens, but
        an `sc-a-session=<short-value>` pair would slip through. Scrub the
        cookie *names* too so the surrounding `=<value>` portion gets
        redacted by the trailing `[^\\s;]+` capture group.
        """
        import re

        # Run the base sanitiser first — handles Bearer tokens, query-param
        # secrets, and long alphanumerics.
        msg = super().sanitize_error(error)
        # Redact Snap session cookie names + their values. The value capture
        # accepts anything up to a whitespace or semicolon (the cookie-string
        # delimiter), which is a superset of base64url-safe chars.
        msg = re.sub(
            r"(sc-a-(?:token|session)=)[^\s;]+",
            r"\1[REDACTED]",
            msg,
            flags=re.IGNORECASE,
        )
        return msg


# ── v2 candidates ──────────────────────────────────────────────────────────
# Surfaced during selector discovery against the live Web Uploader DOM but
# deliberately not implemented in v1. Captured here so a future maintainer
# doesn't have to re-discover them from scratch.
#
# 1. Native scheduling — the composer has a "Schedule" affordance under the
#    testid `app.profileMgr.snapPoster.schedulePost`. v2 could collapse 24
#    hourly publisher cron ticks into 1 daily session that queues all 24
#    posts via Snap's own scheduler. Significant architectural win: one
#    headless-browser session per day instead of 24, fewer auth-expiry
#    failure windows, and we'd lean on Snap's clock instead of Render's.
#
# 2. Headline / thumbnail overlay — the composer exposes a "Headline" input
#    (40-char, placeholder "Displayed over your thumbnail") that overlays
#    text on the video's preview. v1 leaves it blank. v2 could populate it
#    from the tweet author handle or a leading hashtag for stronger CTR.
#
# 3. Multi-destination publish — three checkboxes exist: `#spotlight`,
#    `#publicStory`, `#publicProfile`. v1 only ticks Spotlight. v2 could
#    make destinations configurable per post (e.g. via post.metadata) so a
#    single render fans out to Story and Profile too.
#
# 4. Save-to-Profile sub-toggle — ticking Spotlight reveals a sub-toggle
#    at testid `app.profileMgr.snapPoster.spotlight.saveToProfile`, which
#    Snap auto-checks. v1 leaves the auto-checked state alone. v2 might
#    want to control it explicitly so the operator's "post here" intent
#    isn't silently widened by Snap's defaults.
