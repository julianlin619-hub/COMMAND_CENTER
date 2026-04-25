/**
 * Instagram (2nd) Platform Detail Page
 *
 * Tweet-to-Instagram pipeline: pick tweets from the CSV bank, generate
 * PNG/MP4 media, schedule to Instagram via Buffer (alexhighlights2026).
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { Card, CardContent } from "@/components/ui/card";
import { CronCountdown } from "@/components/cron-countdown";
import { parseBankFile, pickRandomUnused } from "@/lib/tweet-bank";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

interface PipelineStats {
  scheduled7d: number;
  scheduled30d: number;
  bankTotal: number;
  bankRemaining: number;
  bankUsed: number;
}

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "instagram_2nd")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

// Pull bank counts (cheap filesystem reads) plus aggregate posts_processed
// across recent successful cron runs. "Scheduled" here means: handed off to
// Buffer's queue — Buffer then publishes to Instagram on its own cadence.
async function getStats(): Promise<PipelineStats> {
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const { data: runs } = await supabase
    .from("cron_runs")
    .select("posts_processed, started_at")
    .eq("platform", "instagram_2nd")
    .eq("status", "success")
    .gte("started_at", cutoff);

  let scheduled7d = 0;
  let scheduled30d = 0;
  for (const r of runs ?? []) {
    const n = (r.posts_processed as number | null) ?? 0;
    scheduled30d += n;
    if (new Date(r.started_at as string).getTime() >= sevenDaysAgo) {
      scheduled7d += n;
    }
  }

  // Bank stats — wrapped because parseBankFile reads from disk and the file
  // can be missing in unusual deploy states. Don't blow up the page render
  // just because the CSV isn't there.
  let bankTotal = 0;
  let bankRemaining = 0;
  try {
    bankTotal = parseBankFile().length;
    bankRemaining = pickRandomUnused("instagram", 0).remainingUnused;
  } catch {
    bankTotal = 0;
    bankRemaining = 0;
  }

  return {
    scheduled7d,
    scheduled30d,
    bankTotal,
    bankRemaining,
    bankUsed: Math.max(0, bankTotal - bankRemaining),
  };
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-1.5 font-heading text-2xl font-semibold text-foreground">
          {value}
        </div>
        {hint && (
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

export default async function InstagramSecondPage() {
  const [lastRun, stats] = await Promise.all([getLatestRun(), getStats()]);

  const bankPct = stats.bankTotal
    ? Math.round((stats.bankRemaining / stats.bankTotal) * 100)
    : 0;

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
          <PlatformIcon platform="instagram_2nd" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Instagram (2nd)</h1>
            <p className="text-sm text-muted-foreground">
              Tweet-to-Instagram pipeline
            </p>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <CronCountdown platform="instagram_2nd" />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Scheduled · 7d"
          value={stats.scheduled7d.toString()}
          hint="Posts handed to Buffer's queue"
        />
        <StatTile
          label="Scheduled · 30d"
          value={stats.scheduled30d.toString()}
          hint="Successful runs only"
        />
        <StatTile
          label="Bank remaining"
          value={stats.bankRemaining.toString()}
          hint={`${stats.bankUsed} used of ${stats.bankTotal} (${bankPct}% left)`}
        />
      </div>

      <PathwayCard
        number={1}
        title="Bank → Instagram reel"
        steps={[
          "Pick tweets from the CSV bank",
          "Generate PNG images and MP4 videos",
          "Schedule to Instagram via Buffer (alexhighlights2026)",
        ]}
        // Single end-to-end orchestrator. The /pick, /generate, /schedule
        // sub-routes still exist for cron-driven step-by-step use, but the
        // dashboard button can't thread response data between them — the
        // orchestrator runs all three in-process so the picked → generated
        // → scheduled state flows through local variables.
        actions={[{ url: "/api/ig-pipeline" }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
