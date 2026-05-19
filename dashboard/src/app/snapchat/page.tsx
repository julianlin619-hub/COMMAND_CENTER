/**
 * Snapchat Platform Detail Page
 *
 * Tweet-to-Snapchat Spotlight pipeline. Two-stage automation:
 *   1. /api/snapchat-pipeline (hourly, dashboard route) — picks a tweet,
 *      renders MP4, uploads to Storage, inserts posts+schedules row.
 *   2. cron/snapchat_pipeline.py (hourly, offset 5 min) — claims the
 *      schedule and drives Playwright headless Chromium against
 *      Snapchat's Web Uploader.
 *
 * Stats source — INTENTIONAL DIVERGENCE from /instagram-2nd:
 *   The IG-2nd page sums cron_runs.posts_processed because Buffer owns the
 *   actual publish (we only see "handed off to Buffer" counts on our side).
 *   Snapchat publishes itself end-to-end, so the truth lives in posts.status:
 *   we count rows directly, broken out by lifecycle state. This means the
 *   "Published · 7d" tile here is *real* posts that landed on Snapchat,
 *   not "posts we queued and hope Buffer ran".
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { Card, CardContent } from "@/components/ui/card";
import { parseBankFile, pickRandomUnused } from "@/lib/tweet-bank";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

interface PipelineStats {
  // Counts posts row by status in the last 7d. "Scheduled" lumps the three
  // mid-flight states (scheduled / publishing / published) because the
  // generator emits 'scheduled' and process_due_posts transitions through
  // 'publishing' to 'published' — for a 7d aggregate the union is the
  // "how many tweets did we put through the pipeline" number.
  scheduled7d: number;
  // Just the terminal-success rows. "Published · 7d" is the real-world
  // signal: how many actually landed on Snapchat.
  published7d: number;
  bankTotal: number;
  bankRemaining: number;
  bankUsed: number;
}

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  // /api/snapchat-pipeline writes a single cron_runs row per invocation
  // (job_type='generate'). Counterpart to ig-pipeline's row — same shape,
  // posts_processed = number of schedules inserted this run.
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at, posts_processed")
    .eq("platform", "snapchat")
    .eq("job_type", "generate")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
    count: (row.posts_processed as number | null) ?? 0,
  };
}

async function getStats(): Promise<PipelineStats> {
  const supabase = getSupabaseClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Two count queries — head:true + count:'exact' skips returning rows and
  // just gives us the integer. Way cheaper than .select('*') just to read
  // .length on the response.
  const [scheduledRes, publishedRes] = await Promise.all([
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "snapchat")
      .in("status", ["scheduled", "publishing", "published"])
      .gte("created_at", sevenDaysAgo),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "snapchat")
      .eq("status", "published")
      .gte("created_at", sevenDaysAgo),
  ]);

  const scheduled7d = scheduledRes.count ?? 0;
  const published7d = publishedRes.count ?? 0;

  // Bank stats — same wrap-and-fallback pattern as /instagram-2nd. If the
  // CSV is missing on disk we don't want to blow up the whole page.
  let bankTotal = 0;
  let bankRemaining = 0;
  try {
    bankTotal = parseBankFile().length;
    bankRemaining = pickRandomUnused("snapchat", 0).remainingUnused;
  } catch {
    bankTotal = 0;
    bankRemaining = 0;
  }

  return {
    scheduled7d,
    published7d,
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

export default async function SnapchatPage() {
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
          <PlatformIcon platform="snapchat" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Snapchat</h1>
            <p className="text-sm text-muted-foreground">
              Tweet-to-Spotlight via Playwright
            </p>
          </div>
        </div>
      </div>

      {/* No CronCountdown on this page — the publisher runs hourly (cron
          expression "5 then asterisks") and the lib/cron-schedule.ts parser
          only handles fixed-hour and "asterisk-slash-N" patterns. Hourly
          cadence is described in the flow-notes box below instead. If a
          maintainer extends the parser to handle "minute then asterisks",
          add a CRON_SCHEDULES entry for snapchat and put CronCountdown
          back here. */}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Scheduled · 7d"
          value={stats.scheduled7d.toString()}
          hint="Scheduled, publishing, or published"
        />
        <StatTile
          label="Published · 7d"
          value={stats.published7d.toString()}
          hint="Confirmed by Snapchat success page"
        />
        <StatTile
          label="Bank remaining"
          value={stats.bankRemaining.toString()}
          hint={`${stats.bankUsed} used of ${stats.bankTotal} (${bankPct}% left)`}
        />
      </div>

      {/* Flow notes — kept inline (not its own component) since nothing else
          on the page needs them. Documents the storage_state recovery flow
          so the operator sees it on the page that surfaces the failure. */}
      <div className="mb-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs text-[var(--overview-fg)]/65">
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-[var(--overview-fg)]/40">Schedule</span>{" "}
            <span className="font-mono">Hourly · generator :00, publisher :05 (UTC)</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Source</span>{" "}
            <span className="font-mono">data/TweetMasterBank.csv</span>
          </span>
          <span>
            <span className="text-[var(--overview-fg)]/40">Destination</span>{" "}
            <span className="font-mono">Snapchat Spotlight (Playwright headless)</span>
          </span>
        </div>
        <p className="mt-2 text-[var(--overview-fg)]/45">
          Session cookies live in <code className="font-mono">platform_session_state</code> (one row, platform=snapchat).
          If the publisher logs <code className="font-mono">AUTH_EXPIRED</code> on a post, re-run{" "}
          <code className="font-mono">scripts/capture_snapchat_auth.py</code> locally to refresh the row — Snapchat doesn&apos;t expose a token-refresh API,
          so a manual headed-browser login is the recovery path.
        </p>
      </div>

      <PathwayCard
        title="X Bank Reel → Snapchat Spotlight"
        steps={[
          "Pick 1 random unused tweet from data/TweetMasterBank.csv (usage tracked in data/snapchat-bank-history.json)",
          "Render PNG → MP4 (5s loop, 1080×1920) via /api/snapchat-pipeline",
          "Upload MP4 to Supabase Storage at snapchat/tweet-{hash}.mp4",
          "Insert posts + schedules row, scheduled_for = now()+4min",
          "Hourly cron/snapchat_pipeline.py (offset by 5 min) claims due posts and publishes via headless Chromium",
        ]}
        // Single end-to-end orchestrator. The Run button POSTs to the
        // generator route; the actual publish happens out-of-band on the
        // next Python cron tick. Operators tracking a specific run watch
        // posts.status flip from 'scheduled' → 'publishing' → 'published'.
        actions={[{ url: "/api/snapchat-pipeline" }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
