"""One-time script to mint a Google Drive refresh token for Ad Carousels.

Requests only the `drive.file` scope — the narrowest Drive scope, which
grants access ONLY to files/folders this app itself creates. The token
can't read or touch anything else in the Drive account.

That narrowness has a consequence: a parent folder created by hand in
the Drive UI would be INVISIBLE to the token (uploads into it 404).
So after minting the token, this script immediately uses it to create
the "Ad Carousels" parent folder at My Drive root and prints the folder
ID — that ID is what makes the folder reachable at runtime.

How to run:
  1. Your Google Cloud OAuth client must have http://localhost:8765/ in
     its Authorized redirect URIs, and the Google Drive API enabled on
     the project. The existing YouTube OAuth client works — just reuse
     its ID/secret.
  2. Export the client ID/secret:
        export GDRIVE_CLIENT_ID=...
        export GDRIVE_CLIENT_SECRET=...
  3. Run this script:
        python scripts/generate_gdrive_refresh_token.py
  4. Your browser opens. Sign in with the Google account whose Drive
     should receive the carousels, consent to the Drive scope.
  5. Paste the two printed values into .env.local (locally) and the
     Render dashboard web service (production):
        GDRIVE_REFRESH_TOKEN=...
        ADS_DRIVE_FOLDER_ID=...

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

import httpx

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

# Pinned because Google validates the redirect URI (including the port)
# against the OAuth client's allow-list. Matches the YouTube token scripts
# so the same OAuth client's existing redirect URI works for all of them.
REDIRECT_PORT = 8765

PARENT_FOLDER_NAME = "Ad Carousels"


def main() -> int:
    print(
        f"Ensure http://localhost:{REDIRECT_PORT}/ is in Authorized redirect "
        f"URIs on your OAuth client, and the Google Drive API is enabled "
        f"on the Google Cloud project, before continuing.",
    )
    print()

    client_id = os.environ.get("GDRIVE_CLIENT_ID")
    client_secret = os.environ.get("GDRIVE_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET before running "
            "this script (the YouTube OAuth client's values work).",
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

    # Create the parent folder NOW, with the fresh access token, so it's
    # app-created and therefore visible to the drive.file-scoped token at
    # runtime. Done with a direct httpx call (not core.google_drive) so
    # this script has zero project-env dependencies.
    print()
    print(f'Creating "{PARENT_FOLDER_NAME}" folder in My Drive root…')
    response = httpx.post(
        "https://www.googleapis.com/drive/v3/files",
        params={"fields": "id,webViewLink"},
        headers={"Authorization": f"Bearer {credentials.token}"},
        json={
            "name": PARENT_FOLDER_NAME,
            "mimeType": "application/vnd.google-apps.folder",
        },
        timeout=30,
    )
    if not response.is_success:
        print(
            f"Folder creation failed ({response.status_code}): {response.text}\n"
            "Is the Google Drive API enabled on the Cloud project?",
            file=sys.stderr,
        )
        return 1
    folder = response.json()

    print()
    print("=" * 60)
    print("SUCCESS — refresh token minted, parent folder created")
    print("=" * 60)
    print()
    print("Paste these into .env.local and the Render dashboard web service:")
    print()
    print(f"GDRIVE_REFRESH_TOKEN={credentials.refresh_token}")
    print(f"ADS_DRIVE_FOLDER_ID={folder['id']}")
    print()
    print(f"Folder link: {folder['webViewLink']}")
    print()
    print("(Access tokens expire ~1 hour; the refresh token lives indefinitely")
    print(" until revoked. Treat it like a password.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
