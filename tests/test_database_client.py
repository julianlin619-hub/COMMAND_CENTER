"""get_client() must trim its env values.

A Supabase URL or key pasted into a Render / GitHub secret with a stray
space or newline is invisible in the UI, but supabase-py refuses a URL
that doesn't start with the scheme ("Invalid URL"). The factory strips
both values so every cron and script is protected at the single seam.
"""

from __future__ import annotations

import core.database as db


def test_get_client_strips_padded_env_values(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "  https://abc.supabase.co  \n")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", " service-key \n")
    # Force a fresh client; monkeypatch restores the singleton afterwards.
    monkeypatch.setattr(db, "_client", None)
    seen: dict[str, str] = {}

    def fake_create(url, key):
        seen["url"], seen["key"] = url, key
        return object()

    monkeypatch.setattr(db, "create_client", fake_create)

    db.get_client()

    assert seen == {"url": "https://abc.supabase.co", "key": "service-key"}
