/**
 * Tweet Cards Platform Detail Page
 *
 * The unified entry point for both quote-card cron pathways:
 *   1. Outlier — Apify scrape of @AlexHormozi → render TikTok MP4 +
 *      Facebook PNG + LinkedIn PNG → queue all three Buffer channels.
 *   2. Bank    — random unposted pick from data/TweetMasterBank.csv,
 *      then the same render + 3-channel fan-out as Outlier.
 *
 * Replaces the old /tiktok page (which only showed the TikTok legs of
 * what was, before the merge, six separate cron files). cron_runs rows
 * still log under platform="tiktok" because that's the orchestrator's
 * identity — the FB/LI legs are recorded as rows in the `posts` table,
 * not as separate cron_runs entries. See cron/tiktok_pipeline.py for
 * the full rationale.
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

// Status comes from the latest run across all phases (so a content_fetch
// failure still surfaces here even if buffer_send hasn't re-run yet). The
// count is pulled separately from the final-phase row so it represents
// "how many actually shipped" — not "how many we fetched."
//
// We still query platform="tiktok" because the unified pipelines write
// cron_runs rows under that platform key (the orchestrator's identity).
// The FB/LI legs are not separate cron_runs rows.
async function getLastRun(
  jobTypes: string[],
  finalPhase: string,
): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const [latest, final] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status, started_at")
      .eq("platform", "tiktok")
      .in("job_type", jobTypes)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("posts_processed")
      .eq("platform", "tiktok")
      .eq("job_type", finalPhase)
      .order("started_at", { ascending: false })
      .limit(1),
  ]);
  const row = latest.data?.[0];
  if (!row) return null;
  const finalRow = final.data?.[0];
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
    count: (finalRow?.posts_processed as number | null) ?? null,
  };
}

export default async function TweetCardsPage() {
  const [outlierLast, bankLast] = await Promise.all([
    getLastRun(["content_fetch", "content_generate", "buffer_send"], "buffer_send"),
    getLastRun(["bank_pick", "bank_generate", "bank_send"], "bank_send"),
  ]);

  return (
    <AppShell>
      <div className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Overview
        </Link>
        <div className="flex items-center gap-3">
          {/* Three platform icons inline make the multi-platform nature of
              this format obvious at a glance — one icon would have read
              as TikTok-only, which is exactly the misconception the page
              rename is correcting. */}
          <div className="flex items-center gap-1.5">
            <PlatformIcon platform="tiktok" className="size-7" />
            <PlatformIcon platform="facebook" className="size-7" />
            <PlatformIcon platform="linkedin" className="size-7" />
            <PlatformIcon platform="instagram" className="size-7" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Tweet Cards</h1>
            <p className="text-sm text-muted-foreground">
              Turn viral tweets into multi-platform quote cards
            </p>
          </div>
        </div>
      </div>

      {/* Run cadence + dedup notes — kept inline (not split into its own
          component) because nothing else on the page needs them, and copy-
          worth of context belongs alongside the pathways it describes. */}
      <div className="mb-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-[var(--overview-fg)]/65">
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-[var(--overview-fg)]/40">Schedule</span>{" "}
            <span className="font-mono">Daily · 11:00 / 11:15 UTC (4:00 AM PDT)</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Source</span>{" "}
            <span className="font-mono">@AlexHormozi via Apify + data/TweetMasterBank.csv</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Channels</span>{" "}
            <span className="font-mono">Buffer · TikTok + Facebook + LinkedIn + Instagram</span>
          </span>
        </div>
        <p className="mt-2 text-[var(--overview-fg)]/45">
          Per-platform dedup against the <code className="font-mono">posts</code> table —
          each leg (TikTok, Facebook, LinkedIn, Instagram) skips independently. One cron run renders the
          three variants in-process via <code className="font-mono">/api/content-gen/generate</code>;
          Instagram&apos;s feed post reuses the Facebook 1:1 PNG (same image bytes). All four queue to
          Buffer with caption &quot;Agree?&quot;
        </p>
      </div>

      <PathwayCard
        number={1}
        title="X Outlier Reel"
        steps={[
          "Scrape latest 15 @AlexHormozi tweets via Apify (no time window — min 4,000 likes; configurable via TIKTOK_MIN_LIKES / TIKTOK_MAX_ITEMS)",
          "Filter out captions already on TikTok (per-platform dedup; FB, LinkedIn, and Instagram legs dedup independently later)",
          "Render each tweet 3 ways via /api/content-gen/generate: 1080×1920 MP4 (TikTok) + 1080×1080 PNG (Facebook) + 1080×1080 PNG with LinkedIn color overrides. Instagram reuses the Facebook PNG.",
          "Queue each variant to Buffer: TikTok (video), Facebook (image · post), LinkedIn (image), Instagram (image · feed post) — caption \"Agree?\" Partial success allowed per tweet.",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-pipeline" } }]}
        lastRun={outlierLast}
      />

      <PathwayCard
        number={2}
        title="X Bank Reel"
        steps={[
          "Pick 1 random unposted tweet from data/TweetMasterBank.csv with ≥6,500 likes (configurable via TIKTOK_BANK_MIN_LIKES)",
          "Filter out if the caption is already on TikTok (per-platform dedup; FB, LinkedIn, and Instagram legs dedup independently later)",
          "Render 3 ways via /api/content-gen/generate: 1080×1920 MP4 (TikTok) + 1080×1080 PNG (Facebook) + 1080×1080 PNG with LinkedIn color overrides. Instagram reuses the Facebook PNG.",
          "Queue each variant to Buffer: TikTok (video), Facebook (image · post), LinkedIn (image), Instagram (image · feed post) — caption \"Agree?\" Partial success allowed.",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-bank-pipeline" } }]}
        lastRun={bankLast}
      />
    </AppShell>
  );
}
