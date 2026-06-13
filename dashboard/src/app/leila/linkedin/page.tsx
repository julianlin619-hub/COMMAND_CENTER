/**
 * Leila — LinkedIn Platform Detail Page
 *
 * Single pathway: Apify-source @LeilaHormozi tweets → render 1080×1080 quote
 * cards (Alex's Facebook template, reused) → queue on Buffer's Leila LinkedIn
 * channel with caption "Agree?". The cron (linkedin-leila-cron) drives all
 * three phases sequentially in one invocation.
 */

import Link from "next/link";
import { PaletteIcon } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";

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
      {/* Shared hero header — mirrors the Threads pathway page so both Leila
          detail pages read as siblings of each other and of the home screen. */}
      <div className="cc-reveal">
        <DetailPageHeader
          icon={<PlatformIcon platform="linkedin" className="size-8" />}
          eyebrow="Leila Pathway"
          title="LinkedIn"
          subtitle="Quote-card images from recent @LeilaHormozi tweets"
        />
      </div>

      {/* Run cadence + flow notes — kept inline (not split into its own
          component) because nothing else on the page needs them. Now a
          cc-surface so it shares the elevated card language. */}
      <div
        className="cc-reveal cc-surface mb-5 mt-7 px-5 py-4 text-xs text-white/65"
        style={{ animationDelay: "0.06s" }}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="font-mono uppercase tracking-[0.14em] text-white/40">
              Schedule
            </span>{" "}
            <span className="font-mono tabular">Daily · 11:45 UTC (4:45 AM PDT)</span>
          </span>
          <span>
            <span className="font-mono uppercase tracking-[0.14em] text-white/40">
              Source
            </span>{" "}
            <span className="font-mono">@LeilaHormozi via Apify</span>
          </span>
          <span>
            <span className="font-mono uppercase tracking-[0.14em] text-white/40">
              Channel
            </span>{" "}
            <span className="font-mono">Buffer · LinkedIn (Leila)</span>
          </span>
        </div>
        <p className="mt-2.5 text-white/45">
          Three sequential phases in one cron invocation (<code className="font-mono">content_apify</code>,{" "}
          <code className="font-mono">content_generate</code>, <code className="font-mono">buffer_send</code>).
          Renders 1080×1080 quote cards using Alex&apos;s Facebook template — no Leila-specific template yet.
        </p>
      </div>

      {/* PathwayCard is a shared command-center component (already styled in
          the refined terracotta language); wrapped in a reveal so it joins
          the staggered entrance. */}
      <div className="cc-reveal" style={{ animationDelay: "0.12s" }}>
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
      </div>

      {/* Sandbox entry point. Background/text/header are now locked in
          the cron path; this page survives as a preview tool for any
          further visual iteration the operator wants to do. Uses the
          interactive cc-surface so it gets the hover lift + terracotta
          accent rail on hover. */}
      <Link
        href="/leila/linkedin/design"
        className="cc-reveal cc-surface cc-surface--interactive group mt-4 flex items-center justify-between gap-3 px-5 py-4"
        style={{ animationDelay: "0.18s" } as React.CSSProperties}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border shrink-0"
            style={{
              backgroundColor: "var(--terracotta-soft)",
              borderColor: "var(--surface-border-hi)",
            }}
          >
            <PaletteIcon
              className="size-[15px]"
              style={{ color: "var(--terracotta)" }}
            />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[#edeae0]">
              Graphics design sandbox
            </div>
            <div className="text-[12px] text-white/55">
              Preview the locked-in Leila design (black bg, white text,
              Leila_Header.png) and experiment with other knobs.
            </div>
          </div>
        </div>
        <span className="text-[18px] text-white/40 transition-colors group-hover:text-white/70">
          →
        </span>
      </Link>
    </AppShell>
  );
}
