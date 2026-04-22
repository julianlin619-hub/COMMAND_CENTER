"""One-time script to mint a YouTube refresh token for the second channel.

Why this script exists:
  A Google account can own multiple YouTube channels (brand channels).
  The refresh token must be minted while the **second channel** is selected
  in Google's OAuth channel picker, otherwise every API call hits the
  wrong channel. InstalledAppFlow.run_local_server() walks you through
  consent in a browser where you pick the right channel explicitly.

How to run:
  1. Create an OAuth 2.0 Client ID in Google Cloud Console (type: "Desktop app").
     Enable the YouTube Data API v3 for the project.
  2. Export the client ID/secret:
        export YOUTUBE_SECOND_CLIENT_ID=...
        export YOUTUBE_SECOND_CLIENT_SECRET=...
  3. Run this script:
        python scripts/generate_youtube_second_refresh_token.py
  4. Your browser opens. Sign in, **choose the second channel**, consent.
  5. Paste the printed refresh token into Render as YOUTUBE_SECOND_REFRESH_TOKEN.

This script is local-only and never runs on Render.
"""

from __future__ import annotations

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


def main() -> int:
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
            "redirect_uris": ["http://localhost"],
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    # access_type=offline + prompt=consent guarantees Google returns a refresh
    # token. Without these, repeat runs for the same account sometimes return
    # access-token-only responses (silently breaking the script).
    credentials = flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
    )

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
