/**
 * Facebook Platform Detail Page
 *
 * Two sections (same layout pattern as TikTok's page):
 *   1. Cron Pipeline Status — shows the last run of each cron phase
 *   2. Manual Pipeline — link to template designer + interactive wizard
 *
 * Facebook piggybacks on TikTok's tweet selection, so the wizard starts
 * with recent TikTok posts from the database rather than fetching from Apify.
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
import { OutlierTweetCard } from "./outlier-tweet-card";

export const dynamic = "force-dynamic";

/** Map cron job_type to a human-readable label + icon. */
const PHASE_META: Record<string, { label: string; icon: typeof ImageIcon }> = {
  content_fetch: { label: "Read TikTok Posts", icon: ImageIcon },
  content_generate: { label: "Generate Images", icon: ImageIcon },
  buffer_send: { label: "Send to Buffer", icon: SendIcon },
};

export default async function FacebookPage() {
  const supabase = getSupabaseClient();

  // Fetch the most recent cron runs for Facebook
  const { data: cronRuns } = await supabase
    .from("cron_runs")
    .select("*")
    .eq("platform", "facebook")
    .order("started_at", { ascending: false })
    .limit(20);

  // Group by job_type and take the most recent run of each
  const latestByPhase: Record<string, typeof cronRuns extends (infer T)[] | null ? T : never> = {};
  for (const run of cronRuns || []) {
    if (!latestByPhase[run.job_type]) {
      latestByPhase[run.job_type] = run;
    }
  }

  // Fetch recent TikTok posts to repurpose as Facebook quote cards.
  // These are posts that TikTok already selected and sent to Buffer.
  const { data: tiktokPosts } = await supabase
    .from("posts")
    .select("id, caption, created_at")
    .eq("platform", "tiktok")
    .eq("status", "sent_to_buffer")
    .order("created_at", { ascending: false })
    .limit(30);

  const initialTikTokPosts = (tiktokPosts || []).map((p) => ({
    id: p.id as string,
    caption: p.caption as string,
    createdAt: p.created_at as string,
  }));

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
          <PlatformIcon platform="facebook" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Facebook</h1>
            <p className="text-sm text-muted-foreground">
              Square quote cards &mdash; repurpose TikTok tweets as Facebook images
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
              Daily 6:00 AM PDT (1 PM UTC)
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
      <OutlierTweetCard initialTikTokPosts={initialTikTokPosts} />
    </AppShell>
  );
}
