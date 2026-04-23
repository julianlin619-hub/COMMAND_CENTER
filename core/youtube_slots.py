"""Fixed publish-slot generator for the studio-first YouTube scheduler.

Ten slots per UTC day, 144 minutes apart, anchored at 00:00 UTC:
    00:00, 02:24, 04:48, 07:12, 09:36, 12:00, 14:24, 16:48, 19:12, 21:36

A draft is "in" a slot iff its publish_at matches that timestamp exactly.
Conflict detection is separate — a slot is treated as taken if any existing
scheduled publish_at lands within ±conflict_window_minutes of it. That gives
us a small safety buffer against videos scheduled manually in Studio at
arbitrary times between cron runs.

This module is pure — no I/O, no env reads, no clocks from globals. The
caller passes `now`, the set of taken timestamps, and the lead-time minutes.
That makes it trivial to unit-test and keeps the scheduler's concerns (env
vars, database lookups) out of the slot math.

Ported from dashboard/src/lib/youtube-second-scheduler.ts. The main
difference: MAX_LOOKAHEAD_DAYS drops from 30 to 2 — a daily cron that
schedules at most 10 drafts per run never needs to look further than today
plus tomorrow.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

SLOT_COUNT = 10
SLOT_MINUTES = 144
MIN_LEAD_MINUTES = 30
MAX_LOOKAHEAD_DAYS = 2
CONFLICT_WINDOW_MINUTES = 10


class SlotExhaustedError(Exception):
    """Raised when no free slot is found within MAX_LOOKAHEAD_DAYS."""

    def __init__(self, lookahead_days: int) -> None:
        super().__init__(
            f"No free publish slot found within {lookahead_days} days."
        )


@dataclass(frozen=True)
class AssignedSlot:
    """A canonical slot we've chosen for a draft."""

    publish_at: datetime  # tz-aware UTC
    iso: str  # canonical "...Z" form, e.g. "2026-04-22T12:00:00Z"


def _to_iso_z(dt: datetime) -> str:
    """Render a tz-aware UTC datetime as an ISO string ending in Z.

    YouTube's API returns timestamps with "Z" (not "+00:00"); we match that
    form everywhere so string comparisons with API responses work without
    normalization.
    """
    assert dt.tzinfo is not None, "datetime must be tz-aware"
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate_slots(day: datetime) -> list[datetime]:
    """Return the 10 canonical UTC slots for the UTC day containing `day`.

    The input's time-of-day is ignored — only year/month/day (UTC) matter.
    """
    day_utc = day.astimezone(timezone.utc)
    anchor = datetime(
        day_utc.year, day_utc.month, day_utc.day, 0, 0, 0, tzinfo=timezone.utc
    )
    return [anchor + timedelta(minutes=k * SLOT_MINUTES) for k in range(SLOT_COUNT)]


def assign_next_slot(
    now: datetime,
    taken: set[datetime],
    *,
    min_lead_minutes: int = MIN_LEAD_MINUTES,
    conflict_window_minutes: int = CONFLICT_WINDOW_MINUTES,
    lookahead_days: int = MAX_LOOKAHEAD_DAYS,
) -> AssignedSlot:
    """Return the earliest free canonical slot >= now + min_lead_minutes.

    A canonical slot is considered taken if any datetime in `taken` falls
    within ±conflict_window_minutes of it — covers both our own prior
    assignments (exact match) and videos scheduled manually in Studio at
    off-canonical times (near match).

    Raises SlotExhaustedError after `lookahead_days` days with no free slot.
    """
    assert now.tzinfo is not None, "now must be tz-aware"
    earliest = now + timedelta(minutes=min_lead_minutes)
    window = timedelta(minutes=conflict_window_minutes)

    for offset in range(lookahead_days):
        day = now + timedelta(days=offset)
        for slot in generate_slots(day):
            if slot < earliest:
                continue
            if any(abs(slot - t) <= window for t in taken):
                continue
            return AssignedSlot(publish_at=slot, iso=_to_iso_z(slot))

    raise SlotExhaustedError(lookahead_days)
