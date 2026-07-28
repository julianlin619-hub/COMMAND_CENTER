/**
 * Format health — derives a Healthy / Failing / Paused state for each
 * card on the Command Center home, from a single `posts` query.
 *
 * Why one query for the whole page (not per-card):
 *   Each Format declares the `posts.platform` values its automation
 *   writes to. Running one count per card means N round-trips for ~8
 *   live formats. Instead we fetch every row in the widest window once,
 *   bucket by platform in JS, then look the buckets up per card. The
 *   volume is tiny — daily crons + a couple of manual uploads — so the
 *   fetch is cheaper than the round-trip count.
 *
 * Threshold: ≥ 1 post inside the format's health window → "healthy".
 * Anything less on a non-paused format → "failing".
 *
 * Windows are per-format (`Format.healthWindowHours`, default 24h)
 * because not every cron is daily: the Instagram carousel runs every
 * 2 days, so its card needs a 48h window or it would read "failing"
 * on every off-day. To keep the single-query design, we fetch over the
 * WIDEST window any format declares and carry timestamps (not counts),
 * then apply each format's own cutoff when deriving its health.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Format, FormatHealth } from "@/lib/command-center-config";

// Default window for formats that don't declare one. Long enough to
// absorb the "loaded the dashboard just before today's cron fires"
// edge case for daily pipelines; short enough that a stalled daily
// cron drops to "failing" within a day.
const DEFAULT_HEALTH_WINDOW_HOURS = 24;

// Statuses that mean "Buffer accepted the post". `failed` and
// `buffer_error` rows are excluded intentionally: a row that errored
// out the door is not evidence the automation is healthy, even though
// it's evidence the cron tried.
const HEALTHY_POST_STATUSES = ["sent_to_buffer", "published"] as const;

/**
 * Fetch post timestamps in the widest health window any of the given
 * formats declares. Returns `platform -> created_at epoch-ms[]` so
 * `getFormatHealth` can apply each format's own (possibly narrower)
 * cutoff without another query.
 *
 * If the query fails, we return an empty map and log — the home page
 * keeps rendering with every live format showing "failing", which is
 * the safer default than crashing the page or silently flipping cards
 * green.
 */
export async function fetchHealthTimestamps(
  supabase: SupabaseClient,
  formats: Format[],
): Promise<Record<string, number[]>> {
  const maxWindowHours = formats.reduce(
    (max, f) => Math.max(max, f.healthWindowHours ?? DEFAULT_HEALTH_WINDOW_HOURS),
    DEFAULT_HEALTH_WINDOW_HOURS,
  );
  const cutoff = new Date(Date.now() - maxWindowHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("posts")
    .select("platform, created_at")
    .gte("created_at", cutoff)
    .in("status", HEALTHY_POST_STATUSES as unknown as string[]);

  if (error) {
    // Server-component log — surfaces in Render's web logs. We don't
    // re-throw because a broken health pill shouldn't take down the
    // home page; the cards will all read "failing" until the next
    // request, which is a reasonable "something's off" signal.
    console.error("[format-health] timestamp query failed", error);
    return {};
  }

  const timestamps: Record<string, number[]> = {};
  for (const row of data ?? []) {
    const { platform, created_at } = row as {
      platform: string | null;
      created_at: string | null;
    };
    if (!platform || !created_at) continue;
    (timestamps[platform] ??= []).push(new Date(created_at).getTime());
  }
  return timestamps;
}

/**
 * Derive a single format's health from its config + the timestamp map.
 * Order matters: `status: "paused"` always wins, so a card flagged as
 * operator-disabled in the config never appears healthy even if the
 * underlying platform happens to have rows in the window (e.g. a
 * sibling cron writes the same `posts.platform`).
 *
 * The "no healthPlatforms" branch is defensive — today every live
 * format in command-center-config.ts has healthPlatforms set — but
 * treating an untagged live format as "paused" (rather than "failing")
 * keeps a config gap from putting a red pill next to a working
 * automation.
 */
function getFormatHealth(
  format: Format,
  timestampsByPlatform: Record<string, number[]>,
): FormatHealth {
  if (format.status === "paused") return "paused";

  const platforms = format.healthPlatforms ?? [];
  if (platforms.length === 0) return "paused";

  // Apply THIS format's window. The fetch covered the widest window on
  // the page, so a daily format must re-narrow to its own 24h here or
  // it would ride on a slower sibling's older rows.
  const windowHours = format.healthWindowHours ?? DEFAULT_HEALTH_WINDOW_HOURS;
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;

  for (const p of platforms) {
    for (const ts of timestampsByPlatform[p] ?? []) {
      if (ts >= cutoffMs) return "healthy";
    }
  }
  return "failing";
}

/**
 * Home-page entry point: one call returns a Map keyed by format.id, so
 * CategorySection can hand each card its health without re-running any
 * logic.
 */
export function buildHealthMap(
  formats: Format[],
  timestampsByPlatform: Record<string, number[]>,
): Map<string, FormatHealth> {
  const out = new Map<string, FormatHealth>();
  for (const f of formats) out.set(f.id, getFormatHealth(f, timestampsByPlatform));
  return out;
}
