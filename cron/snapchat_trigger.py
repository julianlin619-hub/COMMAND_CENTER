"""Hourly trigger that POSTs to the dashboard's /api/snapchat-pipeline route.

The dashboard route does the heavy lifting (pick tweet, render MP4, upload
to Supabase Storage, insert posts+schedules). This script just kicks it.

Kept as a Python module under `runtime: python` rather than introducing a
`runtime: image` curl service, because every other cron in render.yaml is
Python. Adding a new runtime to chase 3 lines of HTTP would cost more in
maintenance than the install delta saves.
"""

from __future__ import annotations

import os
import sys

import requests


def main() -> int:
    cron_secret = os.environ.get("CRON_SECRET")
    dashboard_url = os.environ.get("DASHBOARD_URL")
    if not cron_secret or not dashboard_url:
        # Missing-env path — log to stderr so the Render run shows the cause
        # without a stack trace.
        print(
            "snapchat-trigger: CRON_SECRET and DASHBOARD_URL must both be set; "
            f"got CRON_SECRET={'SET' if cron_secret else 'MISSING'} "
            f"DASHBOARD_URL={'SET' if dashboard_url else 'MISSING'}",
            file=sys.stderr,
        )
        return 1

    url = f"{dashboard_url.rstrip('/')}/api/snapchat-pipeline"
    try:
        # 5-minute timeout because /api/snapchat-pipeline does ffmpeg
        # rendering inline and we've seen single-tweet runs hit ~90s on
        # cold-start dashboards. Better to hang than to silently retry.
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {cron_secret}"},
            timeout=300,
        )
    except requests.RequestException as e:
        print(f"snapchat-trigger: request failed: {e}", file=sys.stderr)
        return 1

    if not resp.ok:
        # Surface the response body so the operator sees the actual error
        # (e.g. "no unused tweets remaining in bank") without spelunking
        # dashboard logs.
        print(
            f"snapchat-trigger: {resp.status_code} from {url}: {resp.text[:500]}",
            file=sys.stderr,
        )
        return 1

    print(f"snapchat-trigger: OK ({resp.status_code}) {resp.text[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
