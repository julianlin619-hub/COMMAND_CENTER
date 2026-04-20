/**
 * Instagram (main) Platform Detail Page
 *
 * Shows the cron pipeline status for the Instagram cross-posting cron.
 * There is no manual wizard — this pipeline has no generation step,
 * it just forwards TikTok's existing MP4s to Buffer's Instagram queue.
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
  ImageIcon,
  SendIcon,
  ZapIcon,
} from "lucide-react";

export const dynamic = "force-dynamic";

/** Map cron job_type to a human-readable label + icon. */
const PHASE_META: Record<string, { label: string; icon: typeof ImageIcon }> = {
  content_fetch: { label: "Read TikTok Posts", icon: ImageIcon },
  buffer_send: { label: "Send to Buffer", icon: SendIcon },
};

export default async function InstagramPage() {
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Fetch cron runs for Instagram in the last 24h
  const { data: cronRuns } = await supabase
    .from("cron_runs")
    .select("*")
    .eq("platform", "instagram")
    .gte("started_at", since)
    .order("started_at", { ascending: false });

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
          <PlatformIcon platform="instagram" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Instagram</h1>
            <p className="text-sm text-muted-foreground">
              Cross-post TikTok videos &mdash; mirror outlier tweet reels to Instagram
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
              Daily 6:30 AM PDT (1:30 PM UTC)
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

      {/* ── Section 2: Note ──────────────────────────────────────────── */}
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Instagram auto-posts every TikTok video &mdash; no manual controls needed.
        </CardContent>
      </Card>
    </AppShell>
  );
}
