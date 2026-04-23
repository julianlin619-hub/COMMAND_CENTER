"""Tests for core.youtube_studio_scheduler.

All tests use a `FakeYouTube` that records update calls and returns
pre-seeded PrivateVideo lists. Transcript fetching, title generation,
and all Supabase DB helpers are patched via monkeypatch so we don't need
network or an Anthropic API key.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from core import youtube_studio_scheduler as scheduler_mod
from core.exceptions import PlatformAPIError
from core.youtube_transcript import FetchedTranscript
from platforms.youtube import PrivateVideo

_TEST_CHANNEL_ID = "UC_TEST_CHANNEL"


@dataclass
class UpdateCall:
    video_id: str
    title: str
    category_id: str
    publish_at_iso: str


class FakeYouTube:
    """Test double for platforms.youtube.YouTube.

    Only implements the methods the scheduler calls. Adds sanitize_error
    so exception logging doesn't blow up, and a `channel_id` attribute
    that matches the real adapter's public property.
    """

    def __init__(self, videos: list[PrivateVideo], *, raise_on_update: Exception | None = None):
        self._videos = videos
        self._raise_on_update = raise_on_update
        self.update_calls: list[UpdateCall] = []
        self.list_calls = 0
        self.channel_id = _TEST_CHANNEL_ID

    def list_my_private_videos(self) -> list[PrivateVideo]:
        self.list_calls += 1
        # Mirror the adapter's ordering contract.
        return sorted(list(self._videos), key=lambda v: v.published_at)

    def update_video_schedule(self, video_id: str, *, title: str, category_id: str, publish_at_iso: str) -> None:
        if self._raise_on_update is not None:
            exc = self._raise_on_update
            self._raise_on_update = None
            raise exc
        self.update_calls.append(
            UpdateCall(video_id=video_id, title=title, category_id=category_id, publish_at_iso=publish_at_iso)
        )

    def sanitize_error(self, error: Exception) -> str:
        return str(error)


@pytest.fixture(autouse=True)
def patched_transcript(monkeypatch):
    """Default: `fetch_transcript` returns a 30-char standard transcript.

    Tests can mutate `.result` to simulate "transcript unavailable".
    """
    state = {"result": FetchedTranscript(text="mock transcript text here!!!!!", track_kind="standard")}

    def fake_fetch(client, video_id, *, quota=None):
        # Mirror the real fetch_transcript's quota-charging shape so the
        # quota-tracking tests see realistic costs.
        if quota is not None:
            quota.charge(50, reason=f"captions.list {video_id}")
            if state["result"] is not None:
                quota.charge(200, reason=f"captions.download {video_id}")
        return state["result"]

    monkeypatch.setattr(scheduler_mod, "fetch_transcript", fake_fetch)
    return state


@pytest.fixture(autouse=True)
def patched_generator(monkeypatch):
    """Default: `generate_title` returns a fixed string.

    Tests can mutate `.side_effect` to simulate title-generation failure.
    """
    state = {"side_effect": None, "return_value": "Mock Generated Title"}

    def fake_generate(transcript, *, client=None):
        if state["side_effect"] is not None:
            raise state["side_effect"]
        return state["return_value"]

    monkeypatch.setattr(scheduler_mod, "generate_title", fake_generate)
    return state


@pytest.fixture(autouse=True)
def _patch_insert_post(monkeypatch):
    """Capture insert_post calls without hitting Supabase."""
    inserted = []

    def fake_insert(post):
        inserted.append(post)
        return "fake-post-id"

    monkeypatch.setattr(scheduler_mod, "insert_post", fake_insert)
    return inserted


@pytest.fixture(autouse=True)
def patched_occupancy(monkeypatch):
    """Default: no pre-existing posts rows occupy any slot."""
    state = {"taken": set()}

    def fake_read():
        return set(state["taken"])

    monkeypatch.setattr(scheduler_mod, "get_scheduled_youtube_publish_times", fake_read)
    return state


@pytest.fixture(autouse=True)
def patched_tracker(monkeypatch):
    """Stub the fallback tracker so tests never hit Supabase.

    Exposes:
      state["counts"]: dict keyed on video_id, giving the CURRENT count
          the tracker would return from a read. bump_* increments this by
          1 (returns the new value); clear_* drops the key.
      state["bump_calls"] / state["clear_calls"]: call logs for assertions.
    """
    state: dict = {"counts": {}, "bump_calls": [], "clear_calls": []}

    def fake_get(channel_id, video_id):
        return state["counts"].get(video_id, 0)

    def fake_bump(channel_id, video_id, reason):
        state["bump_calls"].append((channel_id, video_id, reason))
        state["counts"][video_id] = state["counts"].get(video_id, 0) + 1
        return state["counts"][video_id]

    def fake_clear(channel_id, video_id):
        state["clear_calls"].append((channel_id, video_id))
        state["counts"].pop(video_id, None)

    monkeypatch.setattr(scheduler_mod, "get_title_fallback_skip_count", fake_get)
    monkeypatch.setattr(scheduler_mod, "bump_title_fallback_tracker", fake_bump)
    monkeypatch.setattr(scheduler_mod, "clear_title_fallback_tracker", fake_clear)
    return state


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


def _now_utc() -> datetime:
    return datetime(2026, 4, 22, 10, 0, tzinfo=timezone.utc)


class TestDryRun:
    def test_dry_run_makes_no_write_calls(self):
        client = FakeYouTube([_draft("a"), _draft("b"), _draft("c")])
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        assert client.update_calls == []
        assert len(summary.scheduled) == 3
        assert summary.dry_run is True

    def test_dry_run_still_assigns_slots_and_generates_titles(self):
        client = FakeYouTube([_draft("a", title="Hello V4", uploaded="2026-04-20T01:00:00Z")])
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        outcome = summary.scheduled[0]
        assert outcome.generated_title == "Mock Generated Title"
        assert outcome.caption_track_kind == "standard"
        assert outcome.transcript_chars == len("mock transcript text here!!!!!")
        assert outcome.title_source == "generated"
        # Earliest usable slot for now=10:00 UTC + 4h lead is 14:24 UTC.
        assert outcome.publish_at_iso == "2026-04-22T14:24:00Z"


class TestCap:
    def test_only_ten_scheduled_when_twenty_five_drafts(self):
        drafts = [
            _draft(f"id-{i:02d}", uploaded=f"2026-04-20T{i:02d}:00:00Z")
            for i in range(25)
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert len(summary.scheduled) == 10
        # Overflow is tracked as backlog, not as skipped (skipped is for errors).
        assert len(summary.skipped) == 0
        assert summary.backlog == 15


class TestConflictAvoidance:
    def test_skips_slot_within_conflict_window(self):
        # A manually-scheduled video at exactly 14:24 UTC blocks the 14:24 slot.
        # The next draft should land at 16:48 UTC.
        drafts = [
            _draft("scheduled-1", uploaded="2026-04-19T00:00:00Z", publish_at="2026-04-22T14:24:00Z"),
            _draft("draft-1", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].publish_at_iso == "2026-04-22T16:48:00Z"

    def test_off_canonical_manual_schedule_still_blocks(self):
        # A manually-scheduled video at 14:20 UTC (4 min before canonical 14:24)
        # falls inside the ±10 min conflict window, so 14:24 is considered taken.
        drafts = [
            _draft("scheduled-1", uploaded="2026-04-19T00:00:00Z", publish_at="2026-04-22T14:20:00Z"),
            _draft("draft-1", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert summary.scheduled[0].publish_at_iso == "2026-04-22T16:48:00Z"


class TestOccupancyFromPosts:
    def test_posts_table_slot_is_treated_as_taken(self, patched_occupancy):
        # Simulates: a prior cron wrote a scheduled posts row for 14:24
        # but the YouTube private-list call didn't return it (e.g. pagination,
        # or it was scheduled in a separate channel context).
        patched_occupancy["taken"] = {
            datetime(2026, 4, 22, 14, 24, tzinfo=timezone.utc)
        }
        client = FakeYouTube([_draft("only")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert summary.scheduled[0].publish_at_iso == "2026-04-22T16:48:00Z"

    def test_occupancy_read_failure_does_not_abort_run(self, monkeypatch):
        def raising_read():
            raise RuntimeError("supabase is down")

        monkeypatch.setattr(
            scheduler_mod, "get_scheduled_youtube_publish_times", raising_read
        )
        client = FakeYouTube([_draft("only")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        # Run completes; the one draft gets scheduled normally.
        assert len(summary.scheduled) == 1


class TestOrdering:
    def test_earliest_uploaded_scheduled_first(self):
        # Pass them out of order; scheduler must sort by published_at asc.
        drafts = [
            _draft("newer", uploaded="2026-04-21T00:00:00Z"),
            _draft("older", uploaded="2026-04-19T00:00:00Z"),
            _draft("middle", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
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
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
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
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        # First draft failed, second succeeded → skipped has 1, scheduled has 1.
        assert len(summary.skipped) == 1
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].video_id == "b"


class TestSlotExhausted:
    def test_slot_exhausted_skips_and_continues(self, patched_occupancy):
        # Fill every slot within the 2-day lookahead window. Both drafts
        # should be skipped with "slot exhausted"; the run must not raise
        # or break out of the loop.
        from core.youtube_slots import MAX_LOOKAHEAD_DAYS, generate_slots

        start = _now_utc()
        full: set[datetime] = set()
        from datetime import timedelta
        for offset in range(MAX_LOOKAHEAD_DAYS):
            full |= set(generate_slots(start + timedelta(days=offset)))
        patched_occupancy["taken"] = full

        drafts = [
            _draft("doomed-1", uploaded="2026-04-19T00:00:00Z"),
            _draft("doomed-2", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert len(summary.scheduled) == 0
        assert len(summary.skipped) == 2
        for skip in summary.skipped:
            assert "slot exhausted" in skip.reason


class TestTranscript:
    def test_first_skip_reason_includes_count(
        self, patched_transcript, _patch_insert_post
    ):
        patched_transcript["result"] = None
        client = FakeYouTube([_draft("only")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert client.update_calls == []
        assert _patch_insert_post == []
        assert len(summary.scheduled) == 0
        assert len(summary.skipped) == 1
        assert summary.skipped[0].reason == "transcript unavailable (1/3)"

    def test_skipped_when_title_generation_fails(
        self, patched_generator, _patch_insert_post
    ):
        patched_generator["side_effect"] = RuntimeError("claude exploded")
        client = FakeYouTube([_draft("only")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert client.update_calls == []
        assert _patch_insert_post == []
        assert len(summary.scheduled) == 0
        assert len(summary.skipped) == 1
        assert summary.skipped[0].reason == "title generation failed"

    def test_partial_transcript_failure_does_not_block_rest_of_run(
        self, patched_transcript, monkeypatch
    ):
        # First draft has no transcript, second does. Scheduler should skip
        # the first (counter=1, below fallback threshold) and still schedule
        # the second.
        calls = {"n": 0}
        original_result = patched_transcript["result"]

        def toggle_fetch(client, video_id, *, quota=None):
            calls["n"] += 1
            if quota is not None:
                quota.charge(50, reason=f"captions.list {video_id}")
            result = None if calls["n"] == 1 else original_result
            if result is not None and quota is not None:
                quota.charge(200, reason=f"captions.download {video_id}")
            return result

        monkeypatch.setattr(scheduler_mod, "fetch_transcript", toggle_fetch)

        drafts = [
            _draft("no-transcript", uploaded="2026-04-19T00:00:00Z"),
            _draft("has-transcript", uploaded="2026-04-20T00:00:00Z"),
        ]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].video_id == "has-transcript"
        assert len(summary.skipped) == 1
        assert summary.skipped[0].video_id == "no-transcript"


class TestFallbackTracker:
    def test_first_skip_bumps_to_1_and_skips(self, patched_transcript, patched_tracker):
        patched_transcript["result"] = None
        client = FakeYouTube([_draft("only")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert patched_tracker["bump_calls"] == [
            (_TEST_CHANNEL_ID, "only", "transcript unavailable")
        ]
        assert patched_tracker["clear_calls"] == []
        assert summary.skipped[0].reason == "transcript unavailable (1/3)"

    def test_third_skip_triggers_fallback(
        self, patched_transcript, patched_tracker, _patch_insert_post
    ):
        patched_transcript["result"] = None
        # Seed the tracker so the bump inside the run will produce count=3.
        patched_tracker["counts"]["stuck"] = 2
        client = FakeYouTube([_draft("stuck", title="hormozi_clip_v3.mp4")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())

        assert len(summary.scheduled) == 1
        outcome = summary.scheduled[0]
        assert outcome.title_source == "fallback"
        # _clean_raw_title strips ".mp4", "v3", and the underscores.
        assert outcome.generated_title == "hormozi clip"
        # After fallback, tracker is cleared.
        assert patched_tracker["clear_calls"] == [(_TEST_CHANNEL_ID, "stuck")]

        # Posts row carries the fallback metadata.
        assert len(_patch_insert_post) == 1
        post = _patch_insert_post[0]
        assert post.metadata["title_source"] == "fallback"
        assert post.metadata["fallback_skip_count"] == 3
        assert post.metadata["transcript_chars"] == 0
        assert post.metadata["caption_track_kind"] == ""

    def test_successful_generate_clears_tracker(self, patched_tracker):
        client = FakeYouTube([_draft("only")])
        scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert patched_tracker["clear_calls"] == [(_TEST_CHANNEL_ID, "only")]
        assert patched_tracker["bump_calls"] == []

    def test_title_gen_failure_does_not_bump_tracker(
        self, patched_generator, patched_tracker
    ):
        patched_generator["side_effect"] = RuntimeError("claude exploded")
        client = FakeYouTube([_draft("only")])
        scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert patched_tracker["bump_calls"] == []
        assert patched_tracker["clear_calls"] == []

    def test_dry_run_reads_tracker_but_does_not_write(
        self, patched_transcript, patched_tracker
    ):
        patched_transcript["result"] = None
        client = FakeYouTube([_draft("only")])
        scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        # Dry-run must not mutate the tracker.
        assert patched_tracker["bump_calls"] == []
        assert patched_tracker["clear_calls"] == []

    def test_dry_run_fallback_path_uses_read_count_plus_one(
        self, patched_transcript, patched_tracker, _patch_insert_post
    ):
        patched_transcript["result"] = None
        # Seed count=2 in the tracker; dry-run reads + 1 → 3 → fallback path.
        patched_tracker["counts"]["stuck"] = 2
        client = FakeYouTube([_draft("stuck", title="clip_v1.mp4")])
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        assert len(summary.scheduled) == 1
        assert summary.scheduled[0].title_source == "fallback"
        # Dry-run still mutates nothing.
        assert patched_tracker["bump_calls"] == []
        assert patched_tracker["clear_calls"] == []
        # Dry-run doesn't write posts rows.
        assert _patch_insert_post == []


class TestPostRecord:
    def test_wet_run_writes_post_row(self, _patch_insert_post):
        client = FakeYouTube([_draft("only", title="Some Title V4")])
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        assert len(summary.scheduled) == 1
        assert len(_patch_insert_post) == 1
        post = _patch_insert_post[0]
        assert post.platform == "youtube"
        assert post.platform_post_id == "only"
        assert post.status == "scheduled"
        assert post.title == "Mock Generated Title"
        assert post.metadata["source"] == "studio"
        assert post.metadata["publish_at"] == "2026-04-22T14:24:00Z"
        assert post.metadata["original_title"] == "Some Title V4"
        assert post.metadata["generated_title"] == "Mock Generated Title"
        assert post.metadata["caption_track_kind"] == "standard"
        assert post.metadata["transcript_chars"] == len(
            "mock transcript text here!!!!!"
        )
        assert post.metadata["title_source"] == "generated"
        # fallback_skip_count is absent on the happy path.
        assert "fallback_skip_count" not in post.metadata

    def test_dry_run_does_not_write_post_row(self, _patch_insert_post):
        client = FakeYouTube([_draft("only")])
        scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        assert _patch_insert_post == []


class TestQuotaTracking:
    def test_wet_run_charges_list_captions_download_update(self):
        drafts = [_draft("a"), _draft("b"), _draft("c")]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        # 3 (discovery) + 3 * (50 captions.list + 200 captions.download + 50 update) = 903
        assert summary.quota_used == 3 + 3 * (50 + 200 + 50)

    def test_dry_run_charges_list_and_captions_but_not_update(self):
        drafts = [_draft("a"), _draft("b")]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(
            client, dry_run=True, now_utc=_now_utc()
        )
        # 3 (discovery) + 2 * (50 + 200) — updates skipped in dry-run.
        assert summary.quota_used == 3 + 2 * (50 + 200)

    def test_transcript_unavailable_charges_list_only(self, patched_transcript):
        patched_transcript["result"] = None
        drafts = [_draft("a"), _draft("b")]
        client = FakeYouTube(drafts)
        summary = scheduler_mod.schedule_studio_drafts(client, now_utc=_now_utc())
        # 3 (discovery) + 2 * 50 (captions.list only; download never ran).
        # Both drafts are at count 1/3 so neither fallback fires.
        assert summary.quota_used == 3 + 2 * 50
