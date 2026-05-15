/**
 * Leila — LinkedIn Platform Detail Page
 *
 * Single pathway: Apify-source @LeilaHormozi tweets → render 1080×1080 quote
 * cards (Alex's Facebook template, reused) → queue on Buffer's Leila LinkedIn
 * channel with caption "Agree?". The cron (linkedin-leila-cron) drives all
 * three phases sequentially in one invocation.
 */

import Link from "next/link";
import { ArrowLeftIcon, PaletteIcon } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";

export const dynamic = "force-dynamic";

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  // Status: latest run regardless of job_type — content_apify,
  // content_generate, and buffer_send all fire sequentially in one cron
  // invocation, and a failure in any of the three should surface here.
  // Count: from buffer_send only, the phase that actually queues posts.
  const [latest, final] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status, started_at")
      .eq("platform", "linkedin_leila")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("posts_processed")
      .eq("platform", "linkedin_leila")
      .eq("job_type", "buffer_send")
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

export default async function LeilaLinkedInPage() {
  const lastRun = await getLatestRun();

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
          <PlatformIcon platform="linkedin" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Leila — LinkedIn</h1>
            <p className="text-sm text-muted-foreground">
              Quote-card images from recent @LeilaHormozi tweets
            </p>
          </div>
        </div>
      </div>

      {/* Run cadence + flow notes — kept inline (not split into its own
          component) because nothing else on the page needs them. */}
      <div className="mb-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-[var(--overview-fg)]/65">
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-[var(--overview-fg)]/40">Schedule</span>{" "}
            <span className="font-mono">Daily · 11:45 UTC (4:45 AM PDT)</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Source</span>{" "}
            <span className="font-mono">@LeilaHormozi via Apify</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Channel</span>{" "}
            <span className="font-mono">Buffer · LinkedIn (Leila)</span>
          </span>
        </div>
        <p className="mt-2 text-[var(--overview-fg)]/45">
          Three sequential phases in one cron invocation (<code className="font-mono">content_apify</code>,{" "}
          <code className="font-mono">content_generate</code>, <code className="font-mono">buffer_send</code>).
          Renders 1080×1080 quote cards using Alex&apos;s Facebook template — no Leila-specific template yet.
        </p>
      </div>

      <PathwayCard
        number={1}
        title="X → LinkedIn Quote Card"
        steps={[
          "Primary: scrape up to 5 recent @LeilaHormozi tweets from past 24h via Apify",
          "Wide fallback (only when primary returns 0): scrape up to 30 tweets ignoring time window (1-year lookback), pick exactly 1 fresh tweet — guarantees a post on quiet days",
          "Skip any whose source tweet text already exists in linkedin_leila posts (dedup)",
          "Render each as a 1080×1080 PNG quote card via /api/content-gen and upload to linkedin_leila/tweet-{uuid}.png",
          "Queue to Buffer's Leila LinkedIn channel with caption \"Agree?\"",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "linkedin-leila-cron" } }]}
        lastRun={lastRun}
      />

      {/* Sandbox entry point. Background/text/header are now locked in
          the cron path; this page survives as a preview tool for any
          further visual iteration the operator wants to do. */}
      <Link
        href="/leila/linkedin/design"
        className="group mt-4 flex items-center justify-between gap-3 rounded-xl border px-5 py-4 transition-colors hover:bg-white/[0.02]"
        style={{
          backgroundColor: "var(--card-warm-bg)",
          borderColor: "var(--card-warm-border)",
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border shrink-0"
            style={{
              backgroundColor: "rgba(174,86,48,0.09)",
              borderColor: "rgba(174,86,48,0.19)",
            }}
          >
            <PaletteIcon
              className="size-[15px]"
              style={{ color: "var(--terracotta)" }}
            />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[var(--overview-fg)]">
              Graphics design sandbox
            </div>
            <div className="text-[12px] text-[var(--overview-fg)]/55">
              Preview the locked-in Leila design (black bg, white text,
              Leila_Header.png) and experiment with other knobs.
            </div>
          </div>
        </div>
        <span className="text-[var(--overview-fg)]/40 group-hover:text-[var(--overview-fg)]/70 transition-colors text-[18px]">
          →
        </span>
      </Link>
    </AppShell>
  );
}
