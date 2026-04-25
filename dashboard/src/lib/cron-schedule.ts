/**
 * Cron schedule config + pure helpers shared by the Overview platform cards.
 *
 * Source of truth for schedules = render.yaml (NOT the prior hardcoded values
 * from cron-logs-tabs.tsx, which had drifted). Keyed by DB platform value so
 * cards can look up by `entry.platform`.
 */

export interface CronScheduleInfo {
  schedule: string;      // cron expression (UTC)
  description: string;   // human-readable local-time summary
}

// Mirrors render.yaml + .github/workflows/ig-pipeline.yml (instagram_2nd
// runs as a GitHub Actions workflow, not a Render cron, but the cadence
// shows up identically on the dashboard).
export const CRON_SCHEDULES: Record<string, CronScheduleInfo> = {
  threads:       { schedule: "0 11 * * *",  description: "Daily at 4:00 AM PDT" },
  tiktok:        { schedule: "0 11 * * *",  description: "Daily at 4:00 AM PDT" },
  instagram_2nd: { schedule: "0 11 * * *",  description: "Daily at 4:00 AM PDT" },
  facebook:      { schedule: "30 11 * * *", description: "Daily at 4:30 AM PDT" },
  instagram:     { schedule: "30 11 * * *", description: "Daily at 4:30 AM PDT" },
  linkedin:      { schedule: "0 12 * * *",  description: "Daily at 5:00 AM PDT" },
};

/** Compute the next UTC run time from a simple cron pattern. */
export function getNextRun(schedule: string): Date {
  const now = new Date();
  const parts = schedule.split(" ");
  const targetMinute = parseInt(parts[0]);
  const hourPart = parts[1];

  if (hourPart.startsWith("*/")) {
    const interval = parseInt(hourPart.slice(2));
    const hours: number[] = [];
    for (let h = 0; h < 24; h += interval) hours.push(h);

    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetHour = hours.find(
      (h) => h * 60 + targetMinute > currentMinutes
    );

    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(targetMinute);

    if (targetHour !== undefined) {
      next.setUTCHours(targetHour);
    } else {
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(hours[0]);
    }
    return next;
  }

  // Fixed-hour pattern (e.g., "0 11 * * *")
  const targetHour = parseInt(hourPart);
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(targetMinute);
  next.setUTCHours(targetHour);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Split a millisecond duration into h/m/s parts for a ticking display. */
export function formatCountdownParts(ms: number): { h: number; m: number; s: number } {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return { h, m, s };
}
