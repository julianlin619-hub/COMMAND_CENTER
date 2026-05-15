/**
 * Leila — Threads Platform Detail Page
 *
 * Single pathway: scrape recent @LeilaHormozi tweets via Apify and queue
 * them on Buffer's Leila Threads channel. Mirrors the Alex Threads page
 * shape but spawns the threads_leila cron in one shot (no separate bank
 * phase — source repo is Apify-only).
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";

export const dynamic = "force-dynamic";

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  // Status comes from whichever phase ran last (content_apify or post) so
  // any failure surfaces. Count comes from `post` — the publish phase —
  // since content_apify's posts_processed counts "tweets inserted" and post
  // counts "tweets published". Either is defensible; published is what the
  // operator most wants to see.
  const [latest, final] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status, started_at")
      .eq("platform", "threads_leila")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("posts_processed")
      .eq("platform", "threads_leila")
      .eq("job_type", "post")
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

export default async function LeilaThreadsPage() {
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
          <PlatformIcon platform="threads" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Leila — Threads</h1>
            <p className="text-sm text-muted-foreground">
              Verbatim repost of recent @LeilaHormozi tweets
            </p>
          </div>
        </div>
      </div>

      {/* Run cadence + dedup notes — kept inline (not split into its own
          component) because nothing else on the page needs them. */}
      <div className="mb-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-[var(--overview-fg)]/65">
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-[var(--overview-fg)]/40">Schedule</span>{" "}
            <span className="font-mono">Daily · 11:00 UTC (4:00 AM PDT)</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Source</span>{" "}
            <span className="font-mono">@LeilaHormozi via Apify</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Channel</span>{" "}
            <span className="font-mono">Buffer · Threads (Leila)</span>
          </span>
        </div>
        <p className="mt-2 text-[var(--overview-fg)]/45">
          Single-pathway pipeline — Apify-only, no content bank. Dedup by caption against{" "}
          <code className="font-mono">threads_leila</code> posts. Tweets containing hyperlinks are filtered out before insert.
        </p>
      </div>

      <PathwayCard
        number={1}
        title="X Cross-Post"
        steps={[
          "Scrape up to 5 recent @LeilaHormozi tweets from the past 24h via Apify (no engagement filter)",
          "Skip tweets containing hyperlinks (cron-side filter, not on the X side)",
          "Skip any whose source tweet text already exists in threads_leila posts (dedup)",
          "Queue verbatim to Buffer's Leila Threads channel",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "threads-leila-cron" } }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
