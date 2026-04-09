/**
 * Dashboard Home Page — platform overview with stats, health cards,
 * and recent activity. Showcases a wide range of shadcn/ui components.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { StaggeredContainer, StaggeredItem } from "@/components/motion/staggered-list";
import { HoverCard } from "@/components/motion/hover-card";
import { IgPipelineCard } from "@/components/ig-pipeline-card";
import {
  ActivityIcon,
  BarChart3Icon,
  CalendarIcon,
  CheckCircle2Icon,
  TrendingUpIcon,
  VideoIcon,
} from "lucide-react";

export const dynamic = "force-dynamic";

const PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "threads",
] as const;

/* Platform initials for avatar fallbacks */
const PLATFORM_INITIALS: Record<string, string> = {
  youtube: "YT",
  instagram: "IG",
  tiktok: "TK",
  linkedin: "LI",
  x: "X",
  threads: "TH",
};

/* Dummy recent activity data — shown in the Activity tab so the user can
   see Avatar, Badge, Separator, and timeline patterns in action. */
const RECENT_ACTIVITY = [
  {
    platform: "youtube",
    action: "Published",
    title: "How to Build a CLI in Rust",
    time: "2 hours ago",
    status: "published" as const,
  },
  {
    platform: "instagram",
    action: "Scheduled",
    title: "Behind the scenes reel",
    time: "4 hours ago",
    status: "scheduled" as const,
  },
  {
    platform: "tiktok",
    action: "Failed",
    title: "Quick coding tip #47",
    time: "5 hours ago",
    status: "failed" as const,
  },
  {
    platform: "linkedin",
    action: "Published",
    title: "Lessons from scaling to 1M users",
    time: "8 hours ago",
    status: "published" as const,
  },
  {
    platform: "x",
    action: "Published",
    title: "Thread: Why I switched to Bun",
    time: "12 hours ago",
    status: "published" as const,
  },
  {
    platform: "threads",
    action: "Scheduled",
    title: "Weekly engagement recap",
    time: "1 day ago",
    status: "scheduled" as const,
  },
];

async function getPlatformSummary(platform: string) {
  const supabase = getSupabaseClient();

  const [lastPostResult, nextScheduleResult, cronResult] = await Promise.all([
    supabase
      .from("posts")
      .select("published_at")
      .eq("platform", platform)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1),
    supabase
      .from("schedules")
      .select("scheduled_for, posts!inner(platform)")
      .eq("posts.platform", platform)
      .is("picked_up_at", null)
      .order("scheduled_for", { ascending: true })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("status, started_at")
      .eq("platform", platform)
      .order("started_at", { ascending: false })
      .limit(1),
  ]);

  return {
    platform,
    lastPost: lastPostResult.data?.[0]?.published_at ?? null,
    nextScheduled: nextScheduleResult.data?.[0]?.scheduled_for ?? null,
    cronHealthy: cronResult.data?.[0]?.status === "success",
    lastCronAt: cronResult.data?.[0]?.started_at ?? null,
  };
}

async function getQuickStats() {
  const supabase = getSupabaseClient();

  const [postsResult, schedulesResult, metricsResult] = await Promise.all([
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("schedules")
      .select("id", { count: "exact", head: true })
      .is("picked_up_at", null),
    supabase
      .from("engagement_metrics")
      .select("views")
      .gte("snapshot_at", new Date(Date.now() - 30 * 86400000).toISOString())
      .limit(500),
  ]);

  const totalViews = (metricsResult.data || []).reduce(
    (sum, m) => sum + (m.views || 0),
    0
  );

  return {
    totalPosts: postsResult.count ?? 0,
    pendingSchedules: schedulesResult.count ?? 0,
    totalViews,
  };
}

function StatusBadge({ status }: { status: "published" | "scheduled" | "failed" }) {
  if (status === "published") {
    return (
      <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
        Published
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return (
    <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
      Scheduled
    </Badge>
  );
}

export default async function DashboardHome() {
  const [summaries, stats] = await Promise.all([
    Promise.all(PLATFORMS.map(getPlatformSummary)),
    getQuickStats(),
  ]);

  const healthyCount = summaries.filter((s) => s.cronHealthy).length;

  return (
    <AppShell>
      {/* Alert banner — system status notification */}
      <Alert className="mb-6">
        <ActivityIcon className="size-4" />
        <AlertTitle>All systems operational</AlertTitle>
        <AlertDescription>
          Cron jobs are running on schedule. {healthyCount} of {PLATFORMS.length} platforms healthy.
        </AlertDescription>
      </Alert>

      {/* Quick stat cards — top-level KPIs */}
      <StaggeredContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Total Posts</CardDescription>
                <CardAction>
                  <VideoIcon className="size-4 text-muted-foreground" />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.totalPosts}</div>
                <p className="text-xs text-muted-foreground">Across all platforms</p>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>

        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Scheduled</CardDescription>
                <CardAction>
                  <CalendarIcon className="size-4 text-muted-foreground" />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.pendingSchedules}</div>
                <p className="text-xs text-muted-foreground">Pending publication</p>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>

        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Healthy</CardDescription>
                <CardAction>
                  <CheckCircle2Icon className="size-4 text-muted-foreground" />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {healthyCount}
                  <span className="text-sm font-normal text-muted-foreground">
                    {" "}/ {PLATFORMS.length}
                  </span>
                </div>
                <Progress value={(healthyCount / PLATFORMS.length) * 100} className="mt-2" />
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>

        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Views (30d)</CardDescription>
                <CardAction>
                  <BarChart3Icon className="size-4 text-muted-foreground" />
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.totalViews.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground">
                  <TrendingUpIcon className="inline size-3 text-green-500 mr-1" />
                  Last 30 days
                </p>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>
      </StaggeredContainer>

      {/* Tabs — switch between platform overview and recent activity */}
      <Tabs defaultValue="platforms">
        <TabsList>
          <TabsTrigger value="platforms">Platforms</TabsTrigger>
          <TabsTrigger value="activity">Recent Activity</TabsTrigger>
        </TabsList>

        {/* Platforms tab — health cards for each platform */}
        <TabsContent value="platforms">
          <StaggeredContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {summaries.map((s) => {
              const cardContent = (
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Avatar size="sm">
                        <AvatarFallback className="text-[10px] font-bold">
                          {PLATFORM_INITIALS[s.platform]}
                        </AvatarFallback>
                      </Avatar>
                      <CardTitle className="capitalize">{s.platform}</CardTitle>
                    </div>
                    <CardAction>
                      <Tooltip>
                        <TooltipTrigger>
                          {s.cronHealthy ? (
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
                          {s.cronHealthy
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
                <StaggeredItem key={s.platform}>
                  <HoverCard>
                    {s.platform === "instagram" ? (
                      <IgPipelineCard>{cardContent}</IgPipelineCard>
                    ) : (
                      cardContent
                    )}
                  </HoverCard>
                </StaggeredItem>
              );
            })}
          </StaggeredContainer>
        </TabsContent>

        {/* Activity tab — recent events with avatars and timeline */}
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>Latest actions across all platforms</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-0">
                {RECENT_ACTIVITY.map((item, i) => (
                  <div key={i}>
                    <div className="flex items-center gap-4 py-3">
                      <Avatar size="sm">
                        <AvatarFallback className="text-[10px] font-bold">
                          {PLATFORM_INITIALS[item.platform]}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.platform} &middot; {item.time}
                        </p>
                      </div>
                      <StatusBadge status={item.status} />
                    </div>
                    {i < RECENT_ACTIVITY.length - 1 && <Separator />}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Skeleton loading preview — shows what loading states look like */}
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Loading Preview</CardTitle>
              <CardDescription>
                Skeleton components for loading states
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="size-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
