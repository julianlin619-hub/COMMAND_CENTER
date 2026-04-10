/**
 * TikTok Platform Detail Page
 *
 * Two sections:
 *   1. Cron Pipeline Status — shows the last run of each cron phase
 *   2. Manual Pipeline — the interactive 4-step wizard for manual runs
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeftIcon,
  SearchIcon,
  ImageIcon,
  SendIcon,
  ZapIcon,
} from "lucide-react";
import { OutlierTweetReel } from "./outlier-tweet-reel";

export const dynamic = "force-dynamic";

/** Map cron job_type to a human-readable label + icon. */
const PHASE_META: Record<string, { label: string; icon: typeof SearchIcon }> = {
  content_fetch: { label: "Fetch Tweets", icon: SearchIcon },
  content_generate: { label: "Generate Videos", icon: ImageIcon },
  buffer_send: { label: "Send to Buffer", icon: SendIcon },
};

export default async function TikTokPage() {
  const supabase = getSupabaseClient();
  const defaultHandle = process.env.APIFY_TWITTER_HANDLE || "AlexHormozi";

  // Fetch the most recent cron run for each TikTok job type.
  // We query all recent tiktok runs and pick the latest per job_type.
  const { data: cronRuns } = await supabase
    .from("cron_runs")
    .select("*")
    .eq("platform", "tiktok")
    .order("started_at", { ascending: false })
    .limit(20);

  // Group by job_type and take the most recent run of each
  const latestByPhase: Record<string, typeof cronRuns extends (infer T)[] | null ? T : never> = {};
  for (const run of cronRuns || []) {
    if (!latestByPhase[run.job_type]) {
      latestByPhase[run.job_type] = run;
    }
  }

  return (
    <AppShell>
      {/* Header */}
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
              Outlier Tweet Reel &mdash; turn viral tweets into TikTok videos
            </p>
          </div>
        </div>
      </div>

      {/* ── Section 1: Cron Pipeline Status ──────────────────────────── */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ZapIcon className="size-4 text-blue-500" />
              Cron Pipeline Status
            </CardTitle>
            <Badge className="bg-green-500/15 text-green-500 border-green-500/25 text-[10px]">
              Active — daily 4:00 AM PST
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {Object.entries(PHASE_META).map(([jobType, meta], i) => {
              const run = latestByPhase[jobType];
              const PhaseIcon = meta.icon;
              return (
                <div key={jobType}>
                  <div className="flex items-center gap-3 py-2">
                    <PhaseIcon className="size-3.5 text-zinc-500 shrink-0" />
                    <span className="text-sm font-medium flex-1">{meta.label}</span>

                    {run ? (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-zinc-500">
                          {new Date(run.started_at).toLocaleString()}
                        </span>
                        {run.posts_processed > 0 && (
                          <span className="text-zinc-400">
                            {run.posts_processed} processed
                          </span>
                        )}
                        {run.status === "success" ? (
                          <Badge className="bg-green-500/15 text-green-500 border-green-500/25 text-[10px]">
                            Success
                          </Badge>
                        ) : run.status === "failed" ? (
                          <Badge className="bg-red-500/15 text-red-500 border-red-500/25 text-[10px]">
                            Failed
                          </Badge>
                        ) : (
                          <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25 text-[10px]">
                            Running
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <Badge className="bg-zinc-500/15 text-zinc-500 border-zinc-500/25 text-[10px]">
                        Never run
                      </Badge>
                    )}
                  </div>
                  {i < Object.keys(PHASE_META).length - 1 && <Separator />}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Section 2: Manual Pipeline ───────────────────────────────── */}
      <h3 className="text-sm font-medium text-muted-foreground mb-3">
        Manual Pipeline
        <span className="ml-2 font-normal">
          — run each step manually for testing
        </span>
      </h3>
      <OutlierTweetReel defaultHandle={defaultHandle} />
    </AppShell>
  );
}
