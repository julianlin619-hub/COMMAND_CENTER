"""One-time local script to capture Snapchat web-uploader auth.

The Snapchat publisher cron drives headless Chromium against the Public
Profile Web Uploader. Headless can't perform the interactive login (Snap
requires you to enter creds + sometimes 2FA), so we capture the logged-in
browser session here — once, locally, with a headed browser — and stash
the resulting Playwright `storageState` JSON blob in Supabase. The cron
then loads that blob on every run and skips straight to publishing.

How to run:
  1. Install Playwright locally (one-time per machine):
        pip install playwright playwright-stealth
        playwright install chromium
  2. Export the env vars:
        export SNAPCHAT_PROFILE_URL=https://profile.snapchat.com/<biz>/profiles/<profile>/web-uploader
        export SUPABASE_URL=...
        export SUPABASE_SERVICE_KEY=...
  3. Run this script:
        python scripts/capture_snapchat_auth.py
  4. A Chromium window opens. Sign in to Snapchat manually (including 2FA).
     Once you can see the upload UI, return to the terminal and press Enter.
  5. The script UPSERTs the storage state into `platform_session_state`
     (platform='snapchat') and exits.

Re-run whenever the publisher logs `AUTH_EXPIRED` — that means the cookies
expired or were invalidated and Snap is serving us a login wall again.

This script is local-only and must never run on Render.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    profile_url = os.environ.get("SNAPCHAT_PROFILE_URL")
    if not profile_url:
        print(
            "SNAPCHAT_PROFILE_URL is not set. Export the full Web Uploader URL "
            "(e.g. https://profile.snapchat.com/<biz>/profiles/<p>/web-uploader) "
            "before running this script.",
            file=sys.stderr,
        )
        return 1
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_KEY"):
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set so the captured "
            "session can be upserted into platform_session_state.",
            file=sys.stderr,
        )
        return 1

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Missing dependency. Install Playwright locally:\n"
            "    pip install playwright\n"
            "    playwright install chromium",
            file=sys.stderr,
        )
        return 1

    # Import after the env-var checks so the Supabase singleton isn't created
    # until we know we'll actually need it.
    from platforms._snapchat_session import save_storage_state

    print("Opening headed Chromium. Sign in to Snapchat manually.")
    print("When the Web Uploader UI is visible, return to this terminal "
          "and press Enter to capture the session.")
    print()

    with sync_playwright() as pw:
        # headless=False is the whole point of this script — we need the
        # operator to see and interact with the login flow. slow_mo helps a
        # human keep up with auto-redirects (e.g. consent screens).
        browser = pw.chromium.launch(headless=False, slow_mo=100)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        try:
            page.goto(profile_url, wait_until="domcontentloaded")
        except Exception as e:
            print(f"Failed to open profile URL: {e}", file=sys.stderr)
            context.close()
            browser.close()
            return 1

        # Block until the operator confirms login is done. We deliberately
        # do not auto-detect a logged-in selector here — the operator may
        # need to handle 2FA, captchas, or a "trust this device" prompt that
        # selector-detection would race against.
        try:
            input("[Press Enter once Snapchat shows the Web Uploader UI...]")
        except KeyboardInterrupt:
            print("\nAborted by operator.", file=sys.stderr)
            context.close()
            browser.close()
            return 1

        state = context.storage_state()
        context.close()
        browser.close()

    try:
        save_storage_state(state)
    except Exception as e:
        print(f"Failed to upsert session state to Supabase: {e}", file=sys.stderr)
        return 1

    print()
    print("=" * 60)
    print("SUCCESS — Snapchat session captured and saved to "
          "platform_session_state.")
    print("=" * 60)
    print()
    print("The publisher cron will pick up the new session on its next run.")
    print("Re-run this script whenever the cron logs AUTH_EXPIRED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
