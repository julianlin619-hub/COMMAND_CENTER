"""Diagnose why Buffer is rejecting a manual-upload crosspost.

Usage:
    python scripts/buffer_investigate.py <buffer_post_id>

Buffer's UI surfaces "There appears to be an issue with the attached media or
link attachment. This could be due to the file being too large or connection
timing out." when its publish-time worker can't fetch the media URL we handed
it. The createPost mutation succeeded (the post is in Buffer's queue), so the
failure is on Buffer's side when it later goes to download the file from
Supabase Storage.

This script narrows down where the breakage is:

  1. Looks up the posts row whose `platform_post_id` matches the supplied
     Buffer ID and pulls the storagePath out of `media_urls[0]`.
  2. Re-signs a fresh 7-day read URL against the `media` bucket — same call
     the finalize endpoint makes.
  3. Sends a HEAD request against the signed URL and prints every response
     header. We're specifically watching for `Content-Length`,
     `Accept-Ranges`, `Content-Type`, and `Content-Disposition` — if any of
     those are missing or wrong, Buffer's worker can choke even though the
     URL technically resolves.
  4. Sends a `Range: bytes=0-1023` request to confirm Supabase serves byte
     ranges (Buffer's downloader typically uses Range requests for video).
  5. Queries Buffer's GraphQL `post(input:{id})` for the post's status,
     sentAt, scheduledAt — to see if Buffer thinks the post failed, is still
     queued, or already published.

Required env vars (same ones the dashboard / crons use):
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
    BUFFER_ACCESS_TOKEN

Run from the repo root so `core.*` imports resolve:
    python scripts/buffer_investigate.py <buffer_post_id>
"""

from __future__ import annotations

import os
import sys

import httpx

from core.buffer import _buffer_request
from core.database import get_client

BUCKET = "media"
# Same TTL the finalize endpoint uses. Re-signing with the same TTL lets us
# rule out / confirm any URL-format quirk between calls.
READ_URL_TTL_SECONDS = 60 * 60 * 24 * 7


def _redact_token_query(url: str) -> str:
    """Mask the JWT in a Supabase signed URL so logs don't leak it.

    Supabase signed URLs embed the auth token as `?token=<JWT>`. We swap
    the token value for `<redacted>` so output can be pasted into chats or
    issue trackers safely without exposing read access.
    """
    if "token=" not in url:
        return url
    prefix, _, rest = url.partition("token=")
    # Token runs to the next `&` (if there are more params) or end of string.
    token_value, sep, tail = rest.partition("&")
    return f"{prefix}token=<redacted>{sep}{tail}"


def lookup_storage_path(buffer_post_id: str) -> tuple[str, dict]:
    """Find the posts row Buffer queued and return its storagePath + row.

    Manual-upload rows have `metadata.source = 'manual_upload'` and the
    storagePath in `media_urls[0]` (same path is reused across the TikTok /
    YouTube / X rows for cleanup grouping).
    """
    client = get_client()
    result = (
        client.table("posts")
        .select("id, platform, status, media_urls, metadata, created_at")
        .eq("platform_post_id", buffer_post_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise SystemExit(
            f"No posts row found with platform_post_id={buffer_post_id!r}. "
            "Pass a Buffer post id that we previously queued."
        )
    row = rows[0]
    media_urls = row.get("media_urls") or []
    if not media_urls:
        raise SystemExit(
            f"posts row {row['id']} has no media_urls — can't re-sign."
        )
    return media_urls[0], row


def resign_url(storage_path: str) -> str:
    """Mint a fresh read URL exactly like the finalize endpoint does."""
    client = get_client()
    # supabase-py wraps the storage REST API; the JS .createSignedUrl()
    # call maps to .create_signed_url() here. Same TTL the production
    # endpoint uses.
    signed = client.storage.from_(BUCKET).create_signed_url(
        storage_path, READ_URL_TTL_SECONDS
    )
    # supabase-py returns {"signedURL": "..."} on older versions and
    # {"signedUrl": "..."} or {"signed_url": "..."} on newer ones — accept
    # any so this script works across upgrades.
    for key in ("signedURL", "signedUrl", "signed_url"):
        if key in signed:
            return signed[key]
    raise SystemExit(f"Unexpected signed-url response shape: {signed!r}")


def probe_url(url: str) -> None:
    """HEAD + Range probe so we can see exactly what Buffer's worker sees.

    The error message Buffer surfaces ("file too large or connection timing
    out") fires when its downloader can't get a clean response. The
    diagnostic headers:
      - Content-Length: missing → Buffer can't preallocate / validate size
      - Content-Type: not video/* → Buffer may reject the asset upfront
      - Accept-Ranges: missing → Buffer can't resume / parallelise download
      - Content-Disposition: attachment;... → may force download semantics
        that confuse Buffer's streaming fetcher
    """
    print("\n--- HEAD ---")
    # follow_redirects=True because Supabase Storage signed URLs may 302 to
    # the underlying object storage on some plans.
    with httpx.Client(follow_redirects=True, timeout=30) as cli:
        head = cli.head(url)
        print(f"status: {head.status_code}")
        for k, v in sorted(head.headers.items()):
            print(f"{k}: {v}")

        print("\n--- GET Range: bytes=0-1023 ---")
        rng = cli.get(url, headers={"Range": "bytes=0-1023"})
        print(f"status: {rng.status_code}")
        # Only print the headers — body is binary and 1KB of mp4 is useless.
        for k, v in sorted(rng.headers.items()):
            print(f"{k}: {v}")
        print(f"body bytes received: {len(rng.content)}")


def query_buffer_post(buffer_post_id: str) -> None:
    """Ask Buffer what state the post is actually in.

    Manual-upload posts often sit `inQueue` indefinitely if Buffer's
    publish-time fetch failed, or transition to `failed` with a message.
    `sentAt` is non-null only on a successful publish.
    """
    print("\n--- Buffer post status ---")
    data = _buffer_request(
        """
        query GetPost($id: PostId!) {
            post(input: { id: $id }) {
                id
                status
                sentAt
                scheduledAt
                dueAt
                text
            }
        }
        """,
        {"id": buffer_post_id},
    )
    post = data.get("post") or {}
    if not post:
        print(f"Buffer returned no post for id={buffer_post_id!r}")
        return
    for key in ("id", "status", "sentAt", "scheduledAt", "dueAt"):
        print(f"{key}: {post.get(key)!r}")
    text = post.get("text") or ""
    if len(text) > 120:
        text = text[:117] + "..."
    print(f"text: {text!r}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    buffer_post_id = sys.argv[1].strip()
    if not buffer_post_id:
        raise SystemExit("Empty buffer_post_id argument.")

    for required in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "BUFFER_ACCESS_TOKEN"):
        if not os.environ.get(required):
            raise SystemExit(f"Missing required env var: {required}")

    storage_path, row = lookup_storage_path(buffer_post_id)
    print("--- posts row ---")
    print(f"id:                {row['id']}")
    print(f"platform:          {row['platform']}")
    print(f"status (our side): {row['status']}")
    print(f"created_at:        {row['created_at']}")
    print(f"storage_path:      {storage_path}")

    url = resign_url(storage_path)
    print(f"signed_url:        {_redact_token_query(url)}")

    probe_url(url)
    query_buffer_post(buffer_post_id)


if __name__ == "__main__":
    main()
