"""Tests for core.youtube_studio_scheduler.

All tests use a `FakeYouTube` that records update calls and returns
pre-seeded PrivateVideo lists. Title cleaning is patched via
monkeypatch so we don't need an Anthropic API key.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from core import youtube_studio_scheduler as scheduler_mod
from core.exceptions import PlatformAPIError
from core.youtube_title_cleaner import CleanedTitle
from platforms.youtube import PrivateVideo


@dataclass
class UpdateCall:
    video_id: str
    title: str
    category_id: str
    publish_at_iso: str


class FakeYouTube:
    """Test double for platforms.youtube.YouTube.

    Only implements the two methods the scheduler calls. Adds
    sanitize_error so exception logging doesn't blow up.
    """

    def __init__(self, videos: list[PrivateVideo], *, raise_on_update: Exception | None = None):
        self._videos = videos
        self._raise_on_update = raise_on_update
        self.update_calls: list[UpdateCall] = []
        self.list_calls = 0

    def list_my_private_videos(self) -> list[PrivateVideo]:
        self.list_calls += 1
        # Mirror the adapter's ordering contract.
        return sorted(list(self._videos), key=lambda v: v.published_at)

    def update_video_schedule(self, video_id: str, *, title: str, category_id: str, publish_at_iso: str) -> None:
        if self._raise_on_update is not None:
            # Rotate through different errors if asked.
            exc = self._raise_on_update
            self._raise_on_update = None
            raise exc
        self.update_calls.append(
            UpdateCall(video_id=video_id, title=title, category_id=category_id, publish_at_iso=publish_at_iso)
        )

    def sanitize_error(self, error: Exception) -> str:
        return str(error)


@pytest.fixture(autouse=True)
def _patch_cleaner(monkeypatch):
    """Replace the LLM cleaner with a deterministic stub — Sonnet strips 'V4' only."""

    def fake_clean(raw: str, *, client=None):
        cleaned = raw.replace(" V4", "").replace("V4 ", "").strip()
        return CleanedTitle(
            original=raw, regex_cleaned=raw, final=cleaned, sonnet_applied=True
        )

    monkeypatch.setattr(scheduler_mod, "clean_title", fake_clean)


@pytest.fixture(autouse=True)
def _patch_insert_post(monkeypatch):
    """Capture insert_post calls without hitting Supabase."""
    inserted = []

    def fake_insert(post):
        inserted.append(post)
        return "fake-post-id"

    monkeypatch.setattr(scheduler_mod, "insert_post", fake_insert)
    return inserted


def _draft(
    video_id: str,
    title: str = "My Video V4",
    uploaded: str = "2026-04-20T00:00:00Z",
    publish_at: str | None = None,
    category_id: str = "22",
) -> PrivateVideo:
    return PrivateVideo(
        video_id=video_id,
        title=title,
        category_id=category_id,
        published_at=uploaded,
        publish_at=publish_at,
    )


def _now() -> datetime:
    return datetime(2026, 4, 22, 10, 0, tzinfo=timezone.utc)


class TestDryRun:
    def test_dry_run_makes_no_write_calls(self):
        client = FakeYouTube([_draft("a"), _draft("b"), _draft("c")])
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now=_now()
        )
        assert client.update_calls == []
        assert len(summary.scheduled) == 3
        assert summary.dry_run is True

    def test_dry_run_still_assigns_slots_and_cleans_titles(self):
        client = FakeYouTube([_draft("a", title="Hello V4", uploaded="2026-04-20T01:00:00Z")])
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now=_now()
        )
        outcome = summary.scheduled[0]
        assert outcome.cleaned_title == "Hello"  # V4 stripped by stubbed cleaner
        # Earliest usable slot for now=10:00 UTC + 30 min lead is 12:00 UTC.
        assert outcome.publish_at_iso == "2026-04-22T12:00:00Z"


class TestCap:
    def test_only_ten_scheduled_when_twenty_five_drafts(self):
        drafts = [
            _draft(f"id-{i:02d}", uploaded=f"2026-04-20T{i:02d}:00:00Z")
            for i in range(25)
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        assert len(summary.scheduled) == 10
        # Overflow is tracked as backlog, not as skipped (skipped is for errors).
        assert len(summary.skipped) == 0
        assert summary.backlog == 15


class TestConflictAvoidance:
    def test_skips_slot_within_conflict_window(self):
        # A manually-scheduled video at exactly 12:00 UTC blocks the 12:00 slot.
        # The next draft should land at 14:24 UTC.
        drafts = [
            _draft("scheduled-1", uploaded="2026-04-19T00:00:00Z", publish_at="2026-04-22T12:00:00Z"),
            _draft("draft-1", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].publish_at_iso == "2026-04-22T14:24:00Z"

    def test_off_canonical_manual_schedule_still_blocks(self):
        # A manually-scheduled video at 11:57 UTC (3 min before canonical 12:00)
        # falls inside the ±10 min conflict window, so 12:00 is considered taken.
        drafts = [
            _draft("scheduled-1", uploaded="2026-04-19T00:00:00Z", publish_at="2026-04-22T11:57:00Z"),
            _draft("draft-1", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        assert summary.scheduled[0].publish_at_iso == "2026-04-22T14:24:00Z"


class TestOrdering:
    def test_earliest_uploaded_scheduled_first(self):
        # Pass them out of order; scheduler must sort by published_at asc.
        drafts = [
            _draft("newer", uploaded="2026-04-21T00:00:00Z"),
            _draft("older", uploaded="2026-04-19T00:00:00Z"),
            _draft("middle", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        assert [o.video_id for o in summary.scheduled] == ["older", "middle", "newer"]


class TestErrorHandling:
    def test_quota_exceeded_stops_early_with_partial_summary(self):
        drafts = [_draft("a"), _draft("b"), _draft("c")]
        client = FakeYouTube(
            drafts,
            raise_on_update=PlatformAPIError(
                "quotaExceeded: you shall not pass", status_code=403
            ),
        )
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        # First call raised quota error → we break. No videos scheduled.
        assert len(summary.scheduled) == 0
        assert len(summary.skipped) == 1
        assert "quota" in summary.skipped[0].reason.lower()

    def test_non_quota_400_skips_one_continues_next(self):
        drafts = [_draft("a"), _draft("b")]
        client = FakeYouTube(
            drafts,
            raise_on_update=PlatformAPIError("bad request", status_code=400),
        )
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        # First draft failed, second succeeded → skipped has 1, scheduled has 1.
        assert len(summary.skipped) == 1
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].video_id == "b"


class TestPostRecord:
    def test_wet_run_writes_post_row(self, _patch_insert_post):
        client = FakeYouTube([_draft("only", title="Some Title V4")])
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        assert len(summary.scheduled) == 1
        assert len(_patch_insert_post) == 1
        post = _patch_insert_post[0]
        assert post.platform == "youtube"
        assert post.platform_post_id == "only"
        assert post.status == "scheduled"
        assert post.title == "Some Title"  # cleaned
        assert post.metadata["source"] == "studio"
        assert post.metadata["publish_at"] == "2026-04-22T12:00:00Z"
        assert post.metadata["original_title"] == "Some Title V4"
        assert post.metadata["cleaned_title"] == "Some Title"

    def test_dry_run_does_not_write_post_row(self, _patch_insert_post):
        client = FakeYouTube([_draft("only")])
        scheduler_mod.schedule_studio_drafts(client, dry_run=True, now=_now())
        assert _patch_insert_post == []


class TestQuotaTracking:
    def test_wet_run_charges_list_and_update(self):
        drafts = [_draft("a"), _draft("b"), _draft("c")]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now=_now())
        # 3 units (list) + 3 * 50 (updates) = 153
        assert summary.quota_used == 3 + 3 * 50

    def test_dry_run_only_charges_list(self):
        drafts = [_draft("a"), _draft("b")]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, dry_run=True, now=_now())
        assert summary.quota_used == 3  # list cost only; update is skipped
