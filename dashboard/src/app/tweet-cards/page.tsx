/**
 * Tweet Cards Platform Detail Page
 *
 * The unified entry point for both quote-card cron pathways:
 *   1. Outlier — Apify scrape of @AlexHormozi → render a Facebook
 *      1080×1080 PNG → fan out to the FB + LinkedIn + Pinterest Buffer
 *      channels (LI and Pinterest reuse the FB image bytes).
 *   2. Bank    — random unposted pick from data/TweetMasterBank.csv,
 *      then the same render + fan-out as Outlier.
 *   (The TikTok MP4 leg was retired Aug 2026; the Instagram leg is
 *   paused via IG_TWEET_CARD_FORMAT — the carousel cron owns IG now.)
 *
 * Replaces the old /tiktok page (which only showed the TikTok legs of
 * what was, before the merge, six separate cron files). cron_runs rows
 * still log under platform="tiktok" because that's the orchestrator's
 * identity — the FB/LI legs are recorded as rows in the `posts` table,
 * not as separate cron_runs entries. See cron/tiktok_pipeline.py for
 * the full rationale.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";

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
      {/* Shared hero header. No stat cluster — this page has no single-number
          live counts; the per-pathway status lives on the PathwayCards below.
          The platform icons ride in the header's `icon` slot so the
          multi-platform nature reads at a glance: the three live legs,
          Facebook + LinkedIn + Pinterest. */}
      <div className="cc-reveal">
        <DetailPageHeader
          icon={
            <div className="flex items-center gap-1.5">
              <PlatformIcon platform="facebook" className="size-7" />
              <PlatformIcon platform="linkedin" className="size-7" />
              <PlatformIcon platform="pinterest" className="size-7" />
            </div>
          }
          eyebrow="Multi-Platform Format"
          title="Tweet Cards"
          subtitle="Turn viral tweets into multi-platform quote cards"
        />
      </div>

      {/* Run cadence + dedup notes — kept inline (not split into its own
          component) because nothing else on the page needs them, and copy-
          worth of context belongs alongside the pathways it describes.
          Promoted to the shared .cc-surface card family. */}
      <div
        className="cc-surface mb-5 mt-7 px-4 py-3 text-xs text-white/65 cc-reveal"
        style={{ animationDelay: "0.06s" }}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-white/40">Schedule</span>{" "}
            <span className="font-mono">Daily · 11:00 / 11:15 UTC (4:00 AM PDT)</span>
          </span>
          <span>
            <span className="text-white/40">Source</span>{" "}
            <span className="font-mono">@AlexHormozi via Apify + data/TweetMasterBank.csv</span>
          </span>
          <span>
            <span className="text-white/40">Channels</span>{" "}
            <span className="font-mono">Buffer · Facebook + LinkedIn + Pinterest</span>
          </span>
        </div>
        <p className="mt-2 text-white/45">
          Per-platform dedup against the <code className="font-mono">posts</code> table —
          each leg (Facebook, LinkedIn, Pinterest) skips independently. One cron run renders the
          Facebook 1:1 PNG in-process via <code className="font-mono">/api/content-gen/generate</code>;
          LinkedIn and Pinterest reuse the same image bytes. FB and LI publish caption-free (the
          tweet text is on the card); Pinterest publishes the tweet text as the pin description.
        </p>
      </div>

      <div className="cc-reveal" style={{ animationDelay: "0.12s" }}>
      <PathwayCard
        number={1}
        title="X Outlier Reel"
        steps={[
          "Scrape latest 15 @AlexHormozi tweets via Apify (no time window — min 4,000 likes; configurable via TIKTOK_MIN_LIKES / TIKTOK_MAX_ITEMS)",
          "Filter out captions already on Facebook (the anchor leg; LinkedIn and Pinterest dedup independently later)",
          "Render each tweet as a 1080×1080 PNG via /api/content-gen/generate — LinkedIn and Pinterest reuse the same image bytes",
          "Queue each leg to Buffer: Facebook (image · post), LinkedIn (image), Pinterest (image · pin on the configured board, tweet text as description). FB/LI ship caption-free. Partial success allowed per tweet.",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-pipeline" } }]}
        lastRun={outlierLast}
      />
      </div>

      <div className="cc-reveal" style={{ animationDelay: "0.18s" }}>
      <PathwayCard
        number={2}
        title="X Bank Reel"
        steps={[
          "Pick 1 random unposted tweet from the tweet_bank table with ≥6,500 likes (configurable via TIKTOK_BANK_MIN_LIKES)",
          "Filter out if the caption is already on Facebook (the anchor leg; LinkedIn and Pinterest dedup independently later)",
          "Render a 1080×1080 PNG via /api/content-gen/generate — LinkedIn and Pinterest reuse the same image bytes",
          "Queue each leg to Buffer: Facebook (image · post), LinkedIn (image), Pinterest (image · pin on the configured board, tweet text as description). FB/LI ship caption-free. Partial success allowed.",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-bank-pipeline" } }]}
        lastRun={bankLast}
      />
      </div>
    </AppShell>
  );
}
