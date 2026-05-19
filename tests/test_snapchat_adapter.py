"""Unit tests for the Snapchat platform adapter.

No live Chromium — every Playwright touch-point is mocked. The goal is to
lock down three contracts that are easy to regress on:

  1. validate_config() raises a helpful error when the required env var is
     missing — we want to fail at adapter construction, not deep in the
     publish path.
  2. sanitize_error() strips Snap-specific cookie names on top of the base
     redactor — so a Playwright error that includes `sc-a-session=...` in
     its message doesn't leak that cookie value to cron_runs.error_message.
  3. create_post() invokes the load_storage_state → goto → set_input_files
     → click → save_storage_state sequence in that order, on the happy path.

This is the first platform-adapter test file in the repo (current files
under tests/ are feature/job-specific). If reuse emerges across future
adapter tests, the Supabase / Playwright mock fixtures should migrate to
tests/conftest.py — kept local for now to avoid premature scaffolding.
"""

from __future__ import annotations

import logging
import os
import sys
from unittest.mock import MagicMock, patch

import pytest


def test_validate_config_missing_env(monkeypatch):
    """validate_config() raises a clear error if SNAPCHAT_PROFILE_URL isn't set.

    The error message must include the env var name so an operator can act
    on it without grepping the source. We test by deleting the var even if
    the developer's shell happens to have it set locally.
    """
    monkeypatch.delenv("SNAPCHAT_PROFILE_URL", raising=False)

    from platforms.snapchat import Snapchat

    adapter = Snapchat()
    with pytest.raises(ValueError) as excinfo:
        adapter.validate_config()
    assert "SNAPCHAT_PROFILE_URL" in str(excinfo.value)


def test_sanitize_error_strips_snap_cookies(monkeypatch):
    """sanitize_error() redacts Snap session cookie values.

    The base PlatformBase.sanitize_error already strips Bearer tokens, URL
    query secrets, and 64+ char alphanumerics. We additionally need
    `sc-a-token=...` and `sc-a-session=...` pairs (Snap's own session cookies)
    to be scrubbed — they're short enough to slip past the 64-char floor
    when Playwright bubbles a request-failed error that quotes the Cookie
    header verbatim.
    """
    monkeypatch.setenv("SNAPCHAT_PROFILE_URL", "https://example/uploader")
    from platforms.snapchat import Snapchat

    adapter = Snapchat()
    # Construct a representative Playwright-style error message. The literal
    # cookie value here ("abc123def") is short enough that the base regex's
    # 64-char redactor would NOT catch it — so a positive result here proves
    # the snapchat-specific override is doing the work.
    err = Exception(
        "goto failed; request had Cookie: sc-a-session=abc123def; other=keep"
    )
    sanitised = adapter.sanitize_error(err)
    assert "abc123def" not in sanitised
    assert "sc-a-session=[REDACTED]" in sanitised
    # And the non-Snap cookie should be preserved untouched — otherwise the
    # regex is overreaching and would scrub legitimate debug context.
    assert "other=keep" in sanitised


def test_create_post_call_order(monkeypatch, tmp_path):
    """create_post() drives the publish steps in the expected order.

    We mock the supabase client (Storage download + save), the
    _snapchat_session helpers, sync_playwright, and stealth_sync. The
    assertion records the order of the mocked calls and asserts the
    sequence: load_storage_state → goto → set_input_files → click →
    save_storage_state. This is the contract a future maintainer is most
    likely to silently break (e.g. by moving save_storage_state out of the
    success branch).
    """
    monkeypatch.setenv("SNAPCHAT_PROFILE_URL", "https://example/uploader")

    # Order-of-call recorder. Each mock appends a label so we can assert the
    # full sequence at the end with a single equality check.
    sequence: list[str] = []

    # ── Mock the Supabase client used for Storage download + screenshot upload.
    mock_storage = MagicMock()
    mock_storage.download.return_value = b"fake-mp4-bytes"
    mock_storage.upload = MagicMock()

    mock_client = MagicMock()
    mock_client.storage.from_.return_value = mock_storage

    # ── Mock the _snapchat_session helpers so they record into `sequence`.
    def fake_load():
        sequence.append("load_storage_state")
        return {"cookies": [], "origins": []}

    def fake_save(_state):
        sequence.append("save_storage_state")

    # ── Mock sync_playwright's context-manager API. The browser/context/page
    # are MagicMocks too — we wire enough of them up to record the key calls.
    mock_page = MagicMock()
    mock_locator = MagicMock()

    def fake_goto(*_args, **_kwargs):
        sequence.append("goto")
    mock_page.goto.side_effect = fake_goto

    # page.check() is called pre-upload to tick the Spotlight destination
    # checkbox. Without this Snap leaves the Post button disabled, so the
    # adapter would hang on SELECTOR_UPLOAD_READY. Record the call so a
    # future refactor that drops it fails this test loudly.
    def fake_check(_selector):
        sequence.append("check")
    mock_page.check.side_effect = fake_check

    # The two locators we exercise (file input + post button) both return
    # the same MagicMock so they share recording behaviour. The caption
    # locator's `.type()` is a no-op recorder.
    def fake_set_input_files(_path):
        sequence.append("set_input_files")

    def fake_click():
        sequence.append("click")

    mock_locator.set_input_files.side_effect = fake_set_input_files
    mock_locator.click.side_effect = fake_click
    # type() is fine to leave un-recorded — we only care about the major
    # publish steps in this test.
    mock_page.locator.return_value = mock_locator
    # wait_for_selector should succeed (return a non-null sentinel) — the
    # adapter checks it doesn't raise, not what it returns.
    mock_page.wait_for_selector.return_value = MagicMock()
    mock_page.screenshot.return_value = b""

    mock_context = MagicMock()
    mock_context.new_page.return_value = mock_page
    mock_context.storage_state.return_value = {"cookies": ["refreshed"]}

    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_context

    mock_pw = MagicMock()
    mock_pw.chromium.launch.return_value = mock_browser

    # sync_playwright() returns a context manager; mock both __enter__/__exit__.
    mock_pw_cm = MagicMock()
    mock_pw_cm.__enter__.return_value = mock_pw
    mock_pw_cm.__exit__.return_value = False

    # Stealth is a side-effect-only function — record that it ran so a
    # future refactor that drops it would fail the test.
    def fake_stealth(_page):
        sequence.append("stealth")

    # The adapter does `from playwright.sync_api import sync_playwright` and
    # `from playwright_stealth import Stealth` lazily inside create_post.
    # Playwright isn't installed in the test env (it's a 400 MB browser bundle
    # we don't want in CI). Inject mock modules into sys.modules BEFORE the
    # lazy import fires so the import resolves to our fakes instead of raising
    # ModuleNotFoundError. This is the standard pattern for unit-testing code
    # that lazy-imports a heavy optional dependency.
    fake_playwright_module = MagicMock()
    fake_playwright_module.sync_playwright.return_value = mock_pw_cm

    # playwright-stealth >= 2.0 exposes a `Stealth` class with an
    # `apply_stealth_sync(page)` method instead of the 1.x top-level
    # `stealth_sync` function. Mock that shape: `Stealth()` returns an
    # instance whose `apply_stealth_sync` method records into the sequence.
    fake_stealth_instance = MagicMock()
    fake_stealth_instance.apply_stealth_sync.side_effect = fake_stealth
    fake_stealth_class = MagicMock(return_value=fake_stealth_instance)
    fake_stealth_module = MagicMock()
    fake_stealth_module.Stealth = fake_stealth_class

    # Patch everything inside the snapchat module's namespace. Use
    # `patch.dict` for env, `patch` for the imports — we patch the
    # `_snapchat_session` symbols on the snapchat module since that's what
    # the adapter references at call time. sys.modules patches let the
    # lazy `from playwright...` import resolve to our MagicMocks.
    with patch("platforms.snapchat.get_client", return_value=mock_client), \
         patch("platforms.snapchat.load_storage_state", side_effect=fake_load), \
         patch("platforms.snapchat.save_storage_state", side_effect=fake_save), \
         patch.dict(sys.modules, {
             "playwright": MagicMock(),
             "playwright.sync_api": fake_playwright_module,
             "playwright_stealth": fake_stealth_module,
         }):

        from core.models import Post
        from platforms.snapchat import Snapchat

        adapter = Snapchat()
        post = Post(
            id="post-uuid-123",
            platform="snapchat",
            caption="hello world",
            media_type="video",
            media_urls=["snapchat/tweet-abc.mp4"],
            status="publishing",
        )
        result = adapter.create_post(post)

    # Synthetic id format: snap-<post_id>-<unix_ts>. We don't assert the
    # exact ts (test would be flaky around second boundaries) — just that
    # the prefix matches.
    assert result.startswith("post-uuid-123") is False  # safety
    assert result.startswith("snap-post-uuid-123-")

    # Critical assertion: the publish steps fired in the documented order.
    # If a future change reorders or drops a step, this fails loudly.
    # The `check` step (Spotlight destination checkbox) lands BEFORE
    # set_input_files because SELECTOR_UPLOAD_READY in the adapter is
    # the Post-button-enabled probe — which only resolves once both the
    # upload completes AND a destination is checked.
    assert sequence == [
        "load_storage_state",
        "stealth",
        "goto",
        "check",
        "set_input_files",
        "click",
        "save_storage_state",
    ]

    # And the local /tmp file was cleaned up — adapter writes /tmp/<id>.mp4
    # and unlinks it in finally. We don't check the unlink directly (no easy
    # hook); instead we assert that any /tmp file with that name doesn't
    # exist post-publish. /tmp is shared with the test process so this is
    # observable.
    assert not os.path.exists(f"/tmp/{post.id}.mp4")


def test_create_post_fallback_succeeds_when_success_selector_times_out(
    monkeypatch, caplog
):
    """Load-bearing test for the duplicate-publish guarantee.

    When SELECTOR_PUBLISH_SUCCESS times out (toast auto-dismissed before
    we caught it), the adapter must NOT raise. Instead it should call
    _publish_form_was_cleared(), verify the URL gate (still on uploader)
    and the composer-reset signals (file input cleared, Post button
    disabled, caption empty), accept the publish as successful, log a
    warning so the operator has telemetry, and call save_storage_state.

    Without this fallback, a successful real publish + missed toast =
    post marked 'failed' in DB → next cron tick re-claims and re-publishes
    the same content as a duplicate on Snapchat. The fallback is the only
    thing standing between us and a duplicate-publish bug, so this test
    locks down its behaviour.
    """
    monkeypatch.setenv("SNAPCHAT_PROFILE_URL", "https://example.com/uploader")

    sequence: list[str] = []

    # Storage mocks — identical to the happy-path test.
    mock_storage = MagicMock()
    mock_storage.download.return_value = b"fake-mp4-bytes"
    mock_storage.upload = MagicMock()
    mock_client = MagicMock()
    mock_client.storage.from_.return_value = mock_storage

    def fake_load():
        sequence.append("load_storage_state")
        return {"cookies": [], "origins": []}

    def fake_save(_state):
        sequence.append("save_storage_state")

    # The page mock. The critical difference from the happy-path test is
    # that wait_for_selector raises on the SELECTOR_PUBLISH_SUCCESS call
    # (the text-engine selector starting with `text=`) but succeeds for
    # the auth and upload-ready waits. side_effect lets us inspect the
    # selector argument and decide per-call.
    mock_page = MagicMock()
    # URL gate passes — page never navigated off the uploader. This is
    # the "real publish + missed toast" case, NOT the captcha case.
    mock_page.url = "https://example.com/uploader"

    def fake_wait_for_selector(selector, **_kwargs):
        if selector.startswith("text="):
            # SELECTOR_PUBLISH_SUCCESS times out. Any Exception subclass
            # works since the adapter catches `except Exception as
            # toast_exc:` — using a plain TimeoutError so the test reads
            # closely to what Playwright actually raises in prod.
            raise TimeoutError("waiting for locator to be visible")
        return MagicMock()
    mock_page.wait_for_selector.side_effect = fake_wait_for_selector

    def fake_goto(*_args, **_kwargs):
        sequence.append("goto")
    mock_page.goto.side_effect = fake_goto

    def fake_check(_selector):
        sequence.append("check")
    mock_page.check.side_effect = fake_check

    # Form-state probes return the cleared state on EVERY locator since
    # the mock_locator is shared across selectors. The fallback reads
    # input_value() on the file input + caption (we want "") and
    # is_disabled() on the post button (we want True) — all three signals
    # should fire and land in the fallback's returned list.
    mock_locator = MagicMock()
    mock_locator.input_value.return_value = ""
    mock_locator.is_disabled.return_value = True

    def fake_set_input_files(_path):
        sequence.append("set_input_files")

    def fake_click():
        sequence.append("click")
    mock_locator.set_input_files.side_effect = fake_set_input_files
    mock_locator.click.side_effect = fake_click
    mock_page.locator.return_value = mock_locator
    mock_page.screenshot.return_value = b""

    mock_context = MagicMock()
    mock_context.new_page.return_value = mock_page
    mock_context.storage_state.return_value = {"cookies": ["refreshed"]}

    mock_browser = MagicMock()
    mock_browser.new_context.return_value = mock_context

    mock_pw = MagicMock()
    mock_pw.chromium.launch.return_value = mock_browser

    mock_pw_cm = MagicMock()
    mock_pw_cm.__enter__.return_value = mock_pw
    mock_pw_cm.__exit__.return_value = False

    fake_playwright_module = MagicMock()
    fake_playwright_module.sync_playwright.return_value = mock_pw_cm

    def fake_stealth(_page):
        sequence.append("stealth")
    fake_stealth_instance = MagicMock()
    fake_stealth_instance.apply_stealth_sync.side_effect = fake_stealth
    fake_stealth_class = MagicMock(return_value=fake_stealth_instance)
    fake_stealth_module = MagicMock()
    fake_stealth_module.Stealth = fake_stealth_class

    # caplog at WARNING captures the create_post fallback warning. The
    # _publish_form_was_cleared helper also logs at INFO, but that level
    # is below the threshold here so we don't have to filter it out.
    with caplog.at_level(logging.WARNING, logger="platforms.snapchat"), \
         patch("platforms.snapchat.get_client", return_value=mock_client), \
         patch("platforms.snapchat.load_storage_state", side_effect=fake_load), \
         patch("platforms.snapchat.save_storage_state", side_effect=fake_save), \
         patch.dict(sys.modules, {
             "playwright": MagicMock(),
             "playwright.sync_api": fake_playwright_module,
             "playwright_stealth": fake_stealth_module,
         }):

        from core.models import Post
        from platforms.snapchat import Snapchat

        adapter = Snapchat()
        post = Post(
            id="post-fallback-uuid",
            platform="snapchat",
            caption="hello world",
            media_type="video",
            media_urls=["snapchat/tweet-xyz.mp4"],
            status="publishing",
        )
        # MUST NOT raise — without the fallback the toast TimeoutError
        # would propagate and the scheduler would mark the post failed.
        result = adapter.create_post(post)

    # The synthetic platform_post_id was returned (publish path completed).
    assert result.startswith("snap-post-fallback-uuid-")

    # save_storage_state fired — proves the fallback accepted publish as
    # success. If the fallback rejected, save would not have run because
    # the toast TimeoutError would have re-raised.
    assert "save_storage_state" in sequence

    # The publish steps through `click` are identical to the happy-path
    # test — what changed is the post-click confirmation, not the publish
    # itself.
    assert sequence[:6] == [
        "load_storage_state",
        "stealth",
        "goto",
        "check",
        "set_input_files",
        "click",
    ]

    # The "missed toast but accepted via composer-reset" warning fired —
    # operator telemetry that lets us tune SELECTOR_PUBLISH_SUCCESS or its
    # timeout if this recurs. We match on a stable substring ("composer
    # reset") rather than the full template so the test doesn't fight
    # phrasing tweaks.
    fallback_warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "composer reset" in r.getMessage()
    ]
    assert len(fallback_warnings) == 1, (
        f"expected exactly 1 'composer reset' WARNING; "
        f"got {len(fallback_warnings)}: "
        f"{[r.getMessage() for r in caplog.records]}"
    )
