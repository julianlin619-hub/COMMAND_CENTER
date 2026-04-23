"""One-time script to mint a YouTube refresh token for the studio-first scheduler.

Sibling of generate_youtube_second_refresh_token.py. Differences:
  - Reads YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET (not the _SECOND_ variants).
  - Requests the broader `youtube` scope instead of `youtube.upload`, because
    the studio-first cron calls videos.update to set publishAt, which
    `youtube.upload` alone does not authorize. `youtube` is the minimum
    scope that allows modifying an existing video's metadata.

How to run (same as the second-channel script):
  1. Your existing Google Cloud OAuth client already has
     http://localhost:8765/ in its Authorized redirect URIs, so no console
     change needed. You can reuse YOUTUBE_SECOND_CLIENT_ID /
     YOUTUBE_SECOND_CLIENT_SECRET values — just export them under the
     YOUTUBE_ names below.
  2. Export the client ID/secret:
        export YOUTUBE_CLIENT_ID=...
        export YOUTUBE_CLIENT_SECRET=...
  3. Run this script:
        python scripts/generate_youtube_refresh_token.py
  4. Your browser opens. Sign in, pick the channel you want to schedule into,
     consent to the YouTube scope.
  5. Paste the printed refresh token into .env.local (locally) and Render
     (production) as YOUTUBE_REFRESH_TOKEN.

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


# Scopes:
#   - youtube → manage YouTube account. Covers both read (channels.list,
#     videos.list, playlistItems.list) and write (videos.update). This is
#     the minimum scope that authorizes videos.update — `youtube.upload`
#     alone does not.
# We deliberately do not request `youtubepartner` or analytics scopes, so
# the token's blast radius stays bounded to managing videos on owned
# channels.
SCOPES = [
    "https://www.googleapis.com/auth/youtube",
]

# Pinned because Google validates the redirect URI (including the port)
# against the OAuth client's allow-list. Matches the port the second-channel
# script uses so the same OAuth client's existing redirect URI works for both.
REDIRECT_PORT = 8765


def main() -> int:
    print(
        f"Ensure http://localhost:{REDIRECT_PORT}/ is in Authorized redirect "
        f"URIs on your OAuth client before continuing.",
    )
    print()

    client_id = os.environ.get("YOUTUBE_CLIENT_ID")
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET before running "
            "this script (same values as YOUTUBE_SECOND_* are fine — they "
            "point at the same OAuth client).",
            file=sys.stderr,
        )
        return 1

    # Inline client config — no JSON file on disk, no accidental git leak.
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
    print("Paste this into .env.local and Render as YOUTUBE_REFRESH_TOKEN:")
    print()
    print(credentials.refresh_token)
    print()
    print("(Access tokens expire ~1 hour; the refresh token lives indefinitely")
    print(" until revoked. Treat it like a password.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
