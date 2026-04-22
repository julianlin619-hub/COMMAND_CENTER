"""One-time script to mint a YouTube refresh token for the second channel.

Why this script exists:
  A Google account can own multiple YouTube channels (brand channels).
  The refresh token must be minted while the **second channel** is selected
  in Google's OAuth channel picker, otherwise every API call hits the
  wrong channel. InstalledAppFlow.run_local_server() walks you through
  consent in a browser where you pick the right channel explicitly.

How to run:
  1. Create an OAuth 2.0 Client ID in Google Cloud Console (type: "Web
     application"). Enable the YouTube Data API v3 for the project.
  2. Under "Authorized redirect URIs" on the OAuth client, add:
        http://localhost:8765/
     (Google validates the exact URI including trailing slash, so register
     it verbatim. We pin the port because a random one can't be pre-
     registered — Google rejects anything not on the allow list.)
  3. Export the client ID/secret:
        export YOUTUBE_SECOND_CLIENT_ID=...
        export YOUTUBE_SECOND_CLIENT_SECRET=...
  4. Run this script:
        python scripts/generate_youtube_second_refresh_token.py
  5. Your browser opens. Sign in, **choose the second channel**, consent.
  6. Paste the printed refresh token into Render as YOUTUBE_SECOND_REFRESH_TOKEN.

This script is local-only and never runs on Render.
"""

from __future__ import annotations

import errno
import os
import sys

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    print(
        "Missing dependency. Install the dev deps:\n"
        "    pip install google-auth-oauthlib google-auth",
        file=sys.stderr,
    )
    sys.exit(1)


# youtube.upload is the minimum scope needed to upload videos. We intentionally
# do not request broader scopes (channel management, analytics) — principle of
# least privilege keeps the token's blast radius small if it leaks.
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]

# Pinned because Google validates the redirect URI (including the port)
# against the OAuth client's allow-list. A random port can't be pre-
# registered; pinning 8765 means you register http://localhost:8765/ once
# and it works forever.
REDIRECT_PORT = 8765


def main() -> int:
    # Upfront reminder — easy to miss during first-time setup and the
    # resulting "redirect_uri_mismatch" error is opaque.
    print(
        f"Ensure http://localhost:{REDIRECT_PORT}/ is in Authorized redirect "
        f"URIs on your OAuth client before continuing.",
    )
    print()

    client_id = os.environ.get("YOUTUBE_SECOND_CLIENT_ID")
    client_secret = os.environ.get("YOUTUBE_SECOND_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Set YOUTUBE_SECOND_CLIENT_ID and YOUTUBE_SECOND_CLIENT_SECRET "
            "before running this script.",
            file=sys.stderr,
        )
        return 1

    # InstalledAppFlow expects the client config as a dict in Google's
    # "installed app" format. We pass it inline instead of reading a JSON
    # file so there's no secret file to accidentally check into git.
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [f"http://localhost:{REDIRECT_PORT}/"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    # access_type=offline + prompt=consent guarantees Google returns a refresh
    # token. Without these, repeat runs for the same account sometimes return
    # access-token-only responses (silently breaking the script).
    try:
        credentials = flow.run_local_server(
            port=REDIRECT_PORT,
            access_type="offline",
            prompt="consent",
        )
    except OSError as e:
        # EADDRINUSE on most platforms — something else is bound to 8765.
        # Catching OSError broadly because Python's socket module raises
        # various subclasses depending on the platform (and the exact errno
        # isn't always stable).
        if e.errno == errno.EADDRINUSE:
            print(
                f"\nPort {REDIRECT_PORT} is already in use. Kill whatever's "
                f"bound to it and re-run.\n"
                f"   Check: lsof -i :{REDIRECT_PORT}\n"
                f"   Kill:  kill $(lsof -t -i :{REDIRECT_PORT})",
                file=sys.stderr,
            )
            return 1
        raise

    print()
    print("=" * 60)
    print("SUCCESS — refresh token minted")
    print("=" * 60)
    print()
    print("Paste this into Render as YOUTUBE_SECOND_REFRESH_TOKEN:")
    print()
    print(credentials.refresh_token)
    print()
    print("(Access tokens expire ~1 hour; the refresh token lives indefinitely")
    print(" until revoked. Treat it like a password.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
