/**
 * TikTok Platform Detail Page
 *
 * Two pathways:
 *   1. Outlier reel — fetch viral tweets via Apify, turn into TikTok videos
 *   2. Bank reel   — pick from the CSV bank and produce one extra reel per day
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

async function getLastRun(jobTypes: string[]): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "tiktok")
    .in("job_type", jobTypes)
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function TikTokPage() {
  const [outlierLast, bankLast] = await Promise.all([
    getLastRun(["content_fetch", "content_generate", "buffer_send"]),
    getLastRun(["bank_pick", "bank_generate", "bank_send"]),
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
          <PlatformIcon platform="tiktok" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">TikTok</h1>
            <p className="text-sm text-muted-foreground">
              Turn viral tweets into TikTok videos
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="Outlier reel"
        steps={[
          "Fetch recent tweets via Apify",
          "Select outlier candidates",
          "Generate video",
          "Send to Buffer",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-pipeline" } }]}
        lastRun={outlierLast}
      />

      <PathwayCard
        number={2}
        title="Bank reel"
        steps={[
          "Pick tweet from the CSV bank",
          "Generate video",
          "Send to Buffer",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "tiktok-bank-pipeline" } }]}
        lastRun={bankLast}
      />
    </AppShell>
  );
}
