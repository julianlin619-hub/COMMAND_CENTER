/**
 * Dashboard Home Page — platform overview with stats, health cards,
 * and recent activity. Showcases a wide range of shadcn/ui components.
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/platform-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StaggeredContainer, StaggeredItem } from "@/components/motion/staggered-list";
import { HoverCard } from "@/components/motion/hover-card";
import { CronTestRunButton } from "@/components/cron-test-run-button";
import {
  PlatformCronSection,
  type CronRun,
} from "@/components/platform-cron-section";

export const dynamic = "force-dynamic";

/* Each entry maps a unique key to its DB platform name and display label.
   Active platforms appear first; inactive ones are greyed out at the bottom. */
interface PlatformEntry {
  key: string;          // unique identifier (used as React key & route slug)
  platform: string;     // DB column value for queries
  label: string;        // what the user sees
}

const ACTIVE_PLATFORMS: PlatformEntry[] = [
  { key: "threads", platform: "threads", label: "Threads" },
  { key: "instagram-2nd", platform: "instagram_2nd", label: "Instagram (2nd)" },
  { key: "tiktok", platform: "tiktok", label: "TikTok" },
  { key: "facebook", platform: "facebook", label: "Facebook" },
  { key: "instagram", platform: "instagram", label: "Instagram (main)" },
];

// Platforms with paused cron jobs — show "Pending" instead of health status
const PAUSED_PLATFORMS = new Set(["instagram_2nd"]);

const INACTIVE_PLATFORMS: PlatformEntry[] = [
  { key: "youtube", platform: "youtube", label: "YouTube" },
  { key: "linkedin", platform: "linkedin", label: "LinkedIn" },
];

const ALL_PLATFORMS = [...ACTIVE_PLATFORMS, ...INACTIVE_PLATFORMS];

/* One-line plain-English summary of what each active platform's cron
   actually does. Keyed by PlatformEntry.key. Sourced from cron/ + render.yaml —
   update here when the cron behavior changes. */
const PLATFORM_SUMMARIES: Record<string, string> = {
  threads:
    "Path 1: scrapes new @AlexHormozi tweets from the past 24h via Apify\nPath 2: picks 5 random tweets from TweetMasterBank CSV",
  "instagram-2nd":
    "Paused — waiting for the new Instagram account before automation resumes.",
  tiktok:
    "Path 1: pulls @AlexHormozi outlier tweets (≥4,000 likes, past 48h) from Apify, renders branded quote-card videos\nPath 2: picks 1 tweet from TweetMasterBank (≥6,500 likes), renders branded quote-card video",
  facebook:
    "Re-uses TikTok's selected tweets from the past 48h, renders them as 1080×1080 PNG quote cards",
  instagram:
    "Mirrors TikTok Path 1 reels to Instagram — same 1080×1920 MP4s, Buffer queue on the Hormozi IG account",
};


async function getPlatformSummary(entry: PlatformEntry) {
  const supabase = getSupabaseClient();

  // Widen the cron_runs query to the last 48h so the per-card "Recent runs"
  // collapsible has data. Health/last-cron-at are derived from the first row.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const [lastPostResult, nextScheduleResult, cronResult] = await Promise.all([
    supabase
      .from("posts")
      .select("published_at")
      .eq("platform", entry.platform)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1),
    supabase
      .from("schedules")
      .select("scheduled_for, posts!inner(platform)")
      .eq("posts.platform", entry.platform)
      .is("picked_up_at", null)
      .order("scheduled_for", { ascending: true })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("*")
      .eq("platform", entry.platform)
      .in("job_type", ["buffer_send", "bank_send", "post"])
      .gte("started_at", cutoff)
      .order("started_at", { ascending: false }),
  ]);

  const runs: CronRun[] = (cronResult.data as CronRun[] | null) ?? [];

  return {
    ...entry,
    lastPost: lastPostResult.data?.[0]?.published_at ?? null,
    nextScheduled: nextScheduleResult.data?.[0]?.scheduled_for ?? null,
    // Healthy if the last cron succeeded OR if no cron has run yet (not a failure)
    cronHealthy: runs[0]?.status !== "failed",
    lastCronAt: runs[0]?.started_at ?? null,
    runs,
  };
}

export default async function DashboardHome() {
  const allSummaries = await Promise.all(ALL_PLATFORMS.map(getPlatformSummary));

  const activeSummaries = allSummaries.filter((s) =>
    ACTIVE_PLATFORMS.some((a) => a.key === s.key),
  );
  const inactiveSummaries = allSummaries.filter((s) =>
    INACTIVE_PLATFORMS.some((a) => a.key === s.key),
  );

  return (
    <AppShell>
      {/* Toolbar — sits above the platform cards. Lets the user preview what
          every cron would do right now without actually triggering them. */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground">Platforms</h2>
        <CronTestRunButton />
      </div>

      {/* Active platform cards */}
      <StaggeredContainer className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {activeSummaries.map((s) => {
          const cardContent = (
            <Card className="cursor-pointer gap-6 py-8">
              <CardHeader className="px-6">
                <div className="flex items-center gap-2">
                  <PlatformIcon platform={s.platform} className="size-5" />
                  <CardTitle>{s.label}</CardTitle>
                </div>
                {PLATFORM_SUMMARIES[s.key] && (
                  <CardDescription className="text-xs leading-relaxed whitespace-pre-line">
                    {PLATFORM_SUMMARIES[s.key]}
                  </CardDescription>
                )}
                <CardAction>
                  <Tooltip>
                    <TooltipTrigger>
                      {PAUSED_PLATFORMS.has(s.platform) ? (
                        <Badge className="bg-yellow-500/15 text-yellow-500 border-yellow-500/25">
                          Pending
                        </Badge>
                      ) : s.cronHealthy ? (
                        <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
                          Healthy
                        </Badge>
                      ) : (
                        <Badge className="bg-red-500/15 text-red-500 border-red-500/25">
                          Failing
                        </Badge>
                      )}
                    </TooltipTrigger>
                    <TooltipContent>
                      {PAUSED_PLATFORMS.has(s.platform)
                        ? "Paused — waiting for new Instagram account"
                        : s.cronHealthy
                          ? `Last successful cron: ${s.lastCronAt ? new Date(s.lastCronAt).toLocaleString() : "N/A"}`
                          : "Cron job is failing — check Cron Logs for details"}
                    </TooltipContent>
                  </Tooltip>
                </CardAction>
              </CardHeader>
              <CardContent className="px-6">
                <PlatformCronSection platform={s.platform} runs={s.runs} />
              </CardContent>
            </Card>
          );

          return (
            <StaggeredItem key={s.key}>
              <HoverCard>
                <Link href={`/${s.key}`}>{cardContent}</Link>
              </HoverCard>
            </StaggeredItem>
          );
        })}
      </StaggeredContainer>

      {/* Inactive platforms — greyed out */}
      <h3 className="text-sm font-medium text-muted-foreground mt-8 mb-3">Coming soon</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 opacity-40 grayscale">
        {inactiveSummaries.map((s) => (
          <Card key={s.key} className="py-8">
            <CardHeader className="px-6">
              <div className="flex items-center gap-2">
                <PlatformIcon platform={s.platform} className="size-5" />
                <CardTitle>{s.label}</CardTitle>
              </div>
              <CardAction>
                <Badge variant="outline" className="text-[10px]">Inactive</Badge>
              </CardAction>
            </CardHeader>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
