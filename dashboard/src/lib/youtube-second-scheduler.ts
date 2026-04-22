/**
 * Slot assignment for the YouTube second-channel upload flow.
 *
 * Rules (from PLAN):
 *   - 10 fixed publish slots per day, spaced 144 minutes apart, starting
 *     at 00:00 UTC: 00:00, 02:24, 04:48, 07:12, 09:36, 12:00, 14:24,
 *     16:48, 19:12, 21:36.
 *   - Slots must be at least MIN_LEAD_MINUTES in the future — YouTube's
 *     publishAt rejects timestamps very near now, and we want a buffer
 *     so the browser has time to finish uploading before the slot fires.
 *   - Scan today first, then roll forward day by day.
 *   - Bounded at MAX_LOOKAHEAD_DAYS to avoid infinite loops if a bug ever
 *     produces pathological input.
 *
 * This module is pure: no I/O, no DB, no clocks pulled from globals. The
 * caller passes `now` and the list of taken ISO timestamps. That makes it
 * trivial to unit-test (and makes race-condition reasoning simpler — the
 * advisory-lock-guarded caller provides a consistent snapshot).
 */

export const SLOT_COUNT = 10;
export const SLOT_MINUTES = 144;
export const MIN_LEAD_MINUTES = 30;
export const MAX_LOOKAHEAD_DAYS = 30;

/** Thrown when no free slot is found within MAX_LOOKAHEAD_DAYS. */
export class SlotExhaustedError extends Error {
  constructor(lookaheadDays: number) {
    super(
      `No free youtube_second publish slot found within ${lookaheadDays} days.`,
    );
    this.name = "SlotExhaustedError";
  }
}

/**
 * Produce ISO strings for the 10 UTC slots of the UTC day containing `day`.
 * The input's time-of-day is ignored — only year/month/day (UTC) matter.
 */
function slotsForDay(day: Date): string[] {
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();
  const out: string[] = [];
  for (let k = 0; k < SLOT_COUNT; k++) {
    // Date.UTC() returns ms since epoch for the given UTC components; no
    // local-tz drift. Each slot is k * 144 minutes past 00:00 UTC.
    const ms = Date.UTC(y, m, d, 0, k * SLOT_MINUTES, 0, 0);
    out.push(new Date(ms).toISOString());
  }
  return out;
}

/**
 * Return the earliest free slot ≥ now + MIN_LEAD_MINUTES that is not in
 * `takenSlots`. Compares as ISO strings — callers must normalize input
 * (e.g., `new Date(s).toISOString()`) before passing.
 *
 * Throws SlotExhaustedError after MAX_LOOKAHEAD_DAYS without a free slot.
 */
export function assignNextSlot(now: Date, takenSlots: readonly string[]): string {
  const takenSet = new Set(takenSlots);
  const earliestMs = now.getTime() + MIN_LEAD_MINUTES * 60 * 1000;

  for (let offset = 0; offset < MAX_LOOKAHEAD_DAYS; offset++) {
    // Build a UTC-midnight anchor for today+offset. Going via Date.UTC()
    // keeps the math in UTC and sidesteps DST.
    const anchor = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offset,
        0, 0, 0, 0,
      ),
    );
    for (const iso of slotsForDay(anchor)) {
      if (new Date(iso).getTime() < earliestMs) continue;
      if (takenSet.has(iso)) continue;
      return iso;
    }
  }

  throw new SlotExhaustedError(MAX_LOOKAHEAD_DAYS);
}
