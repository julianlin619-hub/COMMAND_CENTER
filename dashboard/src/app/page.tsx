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
import { Separator } from "@/components/ui/separator";
import { PlatformIcon } from "@/components/platform-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StaggeredContainer, StaggeredItem } from "@/components/motion/staggered-list";
import { HoverCard } from "@/components/motion/hover-card";
import { CronTestRunButton } from "@/components/cron-test-run-button";

export const dynamic = "force-dynamic";

/* Each entry maps a unique key to its DB platform name and display label.
   Active platforms appear first; inactive ones are greyed out at the bottom. */
interface PlatformEntry {
  key: string;          // unique identifier (used as React key & route slug)
  platform: string;     // DB column value for queries
  label: string;        // what the user sees
  summary: string;      // one-line description of what this card/cron does
}

const ACTIVE_PLATFORMS: PlatformEntry[] = [
  {
    key: "threads",
    platform: "threads",
    label: "Threads",
    summary: "Posts once daily at 4am PDT — scraped tweets + CSV content bank, queued via Buffer.",
  },
  {
    key: "instagram-2nd",
    platform: "instagram_2nd",
    label: "Instagram (2nd)",
    summary: "Paused — waiting on a new Instagram account before posting resumes.",
  },
  {
    key: "tiktok",
    platform: "tiktok",
    label: "TikTok",
    summary: "Posts twice daily — 4am PDT from scraped tweets (>4k likes), 7am PDT from the CSV bank.",
  },
  {
    key: "facebook",
    platform: "facebook",
    label: "Facebook",
    summary: "Posts once daily at 6am PDT — reuses TikTok tweets as 1080×1080 quote cards via Buffer.",
  },
];

// Platforms with paused cron jobs — show "Pending" instead of health status
const PAUSED_PLATFORMS = new Set(["instagram_2nd"]);

const INACTIVE_PLATFORMS: PlatformEntry[] = [
  {
    key: "youtube",
    platform: "youtube",
    label: "YouTube",
    summary: "Not yet implemented — adapter stub only.",
  },
  {
    key: "instagram",
    platform: "instagram",
    label: "Instagram (main)",
    summary: "Not yet implemented — adapter stub only.",
  },
  {
    key: "linkedin",
    platform: "linkedin",
    label: "LinkedIn",
    summary: "Not yet implemented — adapter stub only.",
  },
];

const ALL_PLATFORMS = [...ACTIVE_PLATFORMS, ...INACTIVE_PLATFORMS];


async function getPlatformSummary(entry: PlatformEntry) {
  const supabase = getSupabaseClient();

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
      .select("status, started_at")
      .eq("platform", entry.platform)
      .order("started_at", { ascending: false })
      .limit(1),
  ]);

  return {
    ...entry,
    lastPost: lastPostResult.data?.[0]?.published_at ?? null,
    nextScheduled: nextScheduleResult.data?.[0]?.scheduled_for ?? null,
    // Healthy if the last cron succeeded OR if no cron has run yet (not a failure)
    cronHealthy: cronResult.data?.[0]?.status !== "failed",
    lastCronAt: cronResult.data?.[0]?.started_at ?? null,
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
      <StaggeredContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {activeSummaries.map((s) => {
          const cardContent = (
            <Card className="cursor-pointer">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <PlatformIcon platform={s.platform} className="size-5" />
                  <CardTitle>{s.label}</CardTitle>
                </div>
                <CardDescription className="text-xs leading-relaxed">
                  {s.summary}
                </CardDescription>
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
              <CardContent>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Last post</dt>
                    <dd>
                      {s.lastPost
                        ? new Date(s.lastPost).toLocaleDateString()
                        : "None"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Next scheduled</dt>
                    <dd>
                      {s.nextScheduled
                        ? new Date(s.nextScheduled).toLocaleDateString()
                        : "None"}
                    </dd>
                  </div>
                  <Separator />
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Last cron</dt>
                    <dd className="text-xs">
                      {s.lastCronAt
                        ? new Date(s.lastCronAt).toLocaleString()
                        : "Never"}
                    </dd>
                  </div>
                </dl>
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 opacity-40 grayscale">
        {inactiveSummaries.map((s) => (
          <Card key={s.key}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <PlatformIcon platform={s.platform} className="size-4" />
                <CardTitle className="text-sm">{s.label}</CardTitle>
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
