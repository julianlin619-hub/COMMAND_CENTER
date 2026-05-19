/**
 * Format health — derives a Healthy / Failing / Paused state for each
 * card on the Command Center home, from a single 24h `posts` query.
 *
 * Why one query for the whole page (not per-card):
 *   Each Format declares the `posts.platform` values its automation
 *   writes to. Running one count per card means N round-trips for ~8
 *   live formats. Instead we fetch every row in the window once, bucket
 *   by platform in JS, then look the buckets up per card. The volume is
 *   tiny — daily crons + a couple of manual uploads — so the fetch is
 *   cheaper than the round-trip count.
 *
 * Threshold: ≥ 1 post in the last 24h → "healthy". Anything less on a
 * non-paused format → "failing". Confirmed with the user; widens easily
 * if daily-volume thresholds turn out to matter.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Format, FormatHealth } from "@/lib/command-center-config";

// 24h window. Long enough to absorb the "loaded the dashboard just
// before today's cron fires" edge case for daily pipelines; short
// enough that a stalled cron drops to "failing" within a day.
const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;

// Statuses that mean "Buffer accepted the post". `failed` and
// `buffer_error` rows are excluded intentionally: a row that errored
// out the door is not evidence the automation is healthy, even though
// it's evidence the cron tried.
const HEALTHY_POST_STATUSES = ["sent_to_buffer", "published"] as const;

/**
 * Fetch the per-platform post counts in the health window. Returns a
 * plain map (`platform -> count`) so callers can do cheap lookups.
 *
 * If the query fails, we return an empty map and log — the home page
 * keeps rendering with every live format showing "failing", which is
 * the safer default than crashing the page or silently flipping cards
 * green.
 */
export async function fetchHealthCounts(
  supabase: SupabaseClient,
): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - HEALTH_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("posts")
    .select("platform")
    .gte("created_at", cutoff)
    .in("status", HEALTHY_POST_STATUSES as unknown as string[]);

  if (error) {
    // Server-component log — surfaces in Render's web logs. We don't
    // re-throw because a broken health pill shouldn't take down the
    // home page; the cards will all read "failing" until the next
    // request, which is a reasonable "something's off" signal.
    console.error("[format-health] count query failed", error);
    return {};
  }

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const p = (row as { platform: string | null }).platform;
    if (!p) continue;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}

/**
 * Derive a single format's health from its config + the count map.
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
  countsByPlatform: Record<string, number>,
): FormatHealth {
  if (format.status === "paused") return "paused";

  const platforms = format.healthPlatforms ?? [];
  if (platforms.length === 0) return "paused";

  let total = 0;
  for (const p of platforms) total += countsByPlatform[p] ?? 0;
  return total >= 1 ? "healthy" : "failing";
}

/**
 * Home-page entry point: one call returns a Map keyed by format.id, so
 * CategorySection can hand each card its health without re-running any
 * logic.
 */
export function buildHealthMap(
  formats: Format[],
  countsByPlatform: Record<string, number>,
): Map<string, FormatHealth> {
  const out = new Map<string, FormatHealth>();
  for (const f of formats) out.set(f.id, getFormatHealth(f, countsByPlatform));
  return out;
}
