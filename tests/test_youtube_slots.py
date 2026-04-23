"""Tests for core.youtube_slots."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from core.youtube_slots import (
    MAX_LOOKAHEAD_DAYS,
    SLOT_COUNT,
    SLOT_MINUTES,
    SlotExhaustedError,
    _to_iso_z,
    assign_next_slot,
    generate_slots,
)


def utc(y: int, m: int, d: int, h: int = 0, mi: int = 0) -> datetime:
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


class TestGenerateSlots:
    def test_returns_ten_slots(self):
        slots = generate_slots(utc(2026, 4, 22))
        assert len(slots) == SLOT_COUNT

    def test_first_slot_is_midnight_utc(self):
        slots = generate_slots(utc(2026, 4, 22, 15, 37))  # time-of-day ignored
        assert slots[0] == utc(2026, 4, 22, 0, 0)

    def test_slots_are_144_minutes_apart(self):
        slots = generate_slots(utc(2026, 4, 22))
        deltas = [(b - a) for a, b in zip(slots, slots[1:])]
        assert all(d == timedelta(minutes=SLOT_MINUTES) for d in deltas)

    def test_all_canonical_slots_present(self):
        slots = generate_slots(utc(2026, 4, 22))
        expected_hours_minutes = [
            (0, 0), (2, 24), (4, 48), (7, 12), (9, 36),
            (12, 0), (14, 24), (16, 48), (19, 12), (21, 36),
        ]
        actual = [(s.hour, s.minute) for s in slots]
        assert actual == expected_hours_minutes

    def test_dst_boundary_anchors_to_utc_midnight(self):
        # DST in US starts 2026-03-08. Slots are UTC-anchored, so they must
        # not shift: 00:00 UTC stays 00:00 UTC regardless of local timezone.
        slots = generate_slots(utc(2026, 3, 8))
        assert slots[0] == utc(2026, 3, 8, 0, 0)
        assert slots[5] == utc(2026, 3, 8, 12, 0)


class TestAssignNextSlot:
    def test_picks_first_future_slot_when_queue_empty(self):
        # Cron fires at 10:00 UTC. With the 4-hour lead (MIN_LEAD_MINUTES=240),
        # the earliest usable slot is the first canonical slot >= 14:00 UTC,
        # which is 14:24 UTC. (Before the lead-time bump, this was 12:00.)
        now = utc(2026, 4, 22, 10, 0)
        result = assign_next_slot(now, taken=set())
        assert result.publish_at == utc(2026, 4, 22, 14, 24)
        assert result.iso == "2026-04-22T14:24:00Z"

    def test_skips_slots_before_lead_time(self):
        # 10:25 UTC + 4h lead = 14:25 earliest — too late for 14:24, so
        # the first free slot rolls forward to 16:48.
        now = utc(2026, 4, 22, 10, 25)
        result = assign_next_slot(now, taken=set())
        assert result.publish_at == utc(2026, 4, 22, 16, 48)

    def test_skips_taken_exact_slot(self):
        now = utc(2026, 4, 22, 10, 0)
        taken = {utc(2026, 4, 22, 14, 24)}  # 14:24 already used
        result = assign_next_slot(now, taken=taken)
        assert result.publish_at == utc(2026, 4, 22, 16, 48)

    def test_skips_slot_when_existing_publish_is_within_conflict_window(self):
        # A video manually scheduled at 14:20 UTC (within 10 min of the 14:24
        # canonical slot) should cause us to skip 14:24 and pick 16:48.
        now = utc(2026, 4, 22, 10, 0)
        taken = {utc(2026, 4, 22, 14, 20)}
        result = assign_next_slot(now, taken=taken)
        assert result.publish_at == utc(2026, 4, 22, 16, 48)

    def test_does_not_skip_when_existing_publish_is_outside_window(self):
        # 14:00 is 24 minutes before 14:24 — outside the ±10 min window,
        # so 14:24 remains free.
        now = utc(2026, 4, 22, 10, 0)
        taken = {utc(2026, 4, 22, 14, 0)}
        result = assign_next_slot(now, taken=taken)
        assert result.publish_at == utc(2026, 4, 22, 14, 24)

    def test_rolls_into_next_day_when_today_full(self):
        now = utc(2026, 4, 22, 10, 0)
        # Mark every future slot today as taken.
        taken = set(generate_slots(now))
        result = assign_next_slot(now, taken=taken)
        assert result.publish_at == utc(2026, 4, 23, 0, 0)

    def test_raises_when_lookahead_exhausted(self):
        now = utc(2026, 4, 22, 10, 0)
        # Fill all slots in the 2-day lookahead window.
        taken = set(generate_slots(now)) | set(generate_slots(now + timedelta(days=1)))
        with pytest.raises(SlotExhaustedError) as excinfo:
            assign_next_slot(now, taken=taken)
        assert str(MAX_LOOKAHEAD_DAYS) in str(excinfo.value)

    def test_requires_tz_aware_now(self):
        naive = datetime(2026, 4, 22, 10, 0)
        with pytest.raises(AssertionError):
            assign_next_slot(naive, taken=set())

    def test_iso_format_uses_z_suffix(self):
        # YouTube API returns timestamps ending in Z; we must match that form
        # so string comparisons work without normalization.
        now = utc(2026, 4, 22, 10, 0)
        result = assign_next_slot(now, taken=set())
        assert result.iso.endswith("Z")
        assert "+00:00" not in result.iso


def test_to_iso_z_converts_non_utc_to_z():
    # Input in a non-UTC zone should still serialize with the Z suffix.
    pst = timezone(timedelta(hours=-8))
    dt = datetime(2026, 4, 22, 4, 0, tzinfo=pst)  # = 12:00 UTC
    assert _to_iso_z(dt) == "2026-04-22T12:00:00Z"
