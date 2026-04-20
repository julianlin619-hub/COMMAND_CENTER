/**
 * Threads Platform Detail Page
 *
 * Shows monitoring dashboard and manual controls for the Threads workflow:
 * content sourcing (Apify) and publishing (Buffer).
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

async function getLastRun(jobType: string): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "threads")
    .eq("job_type", jobType)
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function ThreadsPage() {
  const [apifyLast, bankLast] = await Promise.all([
    getLastRun("content_apify"),
    getLastRun("content_bank"),
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
          <PlatformIcon platform="threads" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Threads</h1>
            <p className="text-sm text-muted-foreground">
              Content sourcing and publishing
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="Apify → Publish"
        steps={[
          "Fetch recent tweets via Apify",
          "Publish to Threads via Buffer",
        ]}
        actions={[
          { url: "/api/threads/source" },
          { url: "/api/threads/publish" },
        ]}
        lastRun={apifyLast}
      />

      <PathwayCard
        number={2}
        title="Bank → Publish"
        steps={[
          "Pick tweets from the CSV bank",
          "Publish to Threads via Buffer",
        ]}
        actions={[
          { url: "/api/threads/bank" },
          { url: "/api/threads/publish" },
        ]}
        lastRun={bankLast}
      />
    </AppShell>
  );
}
