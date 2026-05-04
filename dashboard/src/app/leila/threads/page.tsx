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
  // Latest run regardless of job_type — both content_apify and post fire
  // sequentially in one cron invocation, and a failure in either phase
  // should surface here.
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "threads_leila")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
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

      <PathwayCard
        number={1}
        title="Apify → Publish"
        steps={[
          "Fetch up to 5 recent @LeilaHormozi tweets via Apify (24h window)",
          "Dedupe against existing posts (platform=threads_leila)",
          "Queue verbatim on Buffer's Leila Threads channel",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "threads-leila-cron" } }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
