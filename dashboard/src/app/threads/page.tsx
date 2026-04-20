/**
 * Threads Platform Detail Page
 *
 * Shows monitoring dashboard and manual controls for the Threads workflow:
 * content sourcing (Apify) and publishing (Buffer).
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
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { PlatformIcon } from "@/components/platform-icon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StaggeredContainer, StaggeredItem } from "@/components/motion/staggered-list";
import { HoverCard } from "@/components/motion/hover-card";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClockIcon,
  FileTextIcon,
  XCircleIcon,
  AlertCircleIcon,
} from "lucide-react";
import { WorkflowPipeline } from "./workflow-actions";

export const dynamic = "force-dynamic";

async function getThreadsData() {
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    publishedResult,
    scheduledResult,
    draftResult,
    failedResult,
    lastApifyResult,
    lastBankResult,
    lastPublishResult,
    recentPostsResult,
    recentCronsResult,
  ] = await Promise.all([
    // Stats counts
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "threads")
      .eq("status", "published"),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "threads")
      .eq("status", "scheduled"),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "threads")
      .eq("status", "draft"),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", "threads")
      .eq("status", "failed"),
    // Last cron run per job type in the last 24h (Apify and bank tracked separately)
    supabase
      .from("cron_runs")
      .select("*")
      .eq("platform", "threads")
      .eq("job_type", "content_apify")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("*")
      .eq("platform", "threads")
      .eq("job_type", "content_bank")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("cron_runs")
      .select("*")
      .eq("platform", "threads")
      .eq("job_type", "post")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1),
    // Recent posts and cron runs (last 24h)
    supabase
      .from("posts")
      .select("*")
      .eq("platform", "threads")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("cron_runs")
      .select("*")
      .eq("platform", "threads")
      .gte("started_at", since)
      .order("started_at", { ascending: false }),
  ]);

  return {
    published: publishedResult.count ?? 0,
    scheduled: scheduledResult.count ?? 0,
    drafts: draftResult.count ?? 0,
    failed: failedResult.count ?? 0,
    lastApify: lastApifyResult.data?.[0] ?? null,
    lastBank: lastBankResult.data?.[0] ?? null,
    lastPublish: lastPublishResult.data?.[0] ?? null,
    recentPosts: recentPostsResult.data ?? [],
    recentCrons: recentCronsResult.data ?? [],
  };
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "published":
      return (
        <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
          Published
        </Badge>
      );
    case "scheduled":
      return (
        <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
          Scheduled
        </Badge>
      );
    case "publishing":
      return (
        <Badge className="bg-yellow-500/15 text-yellow-500 border-yellow-500/25">
          Publishing
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return (
        <Badge className="bg-zinc-700 text-zinc-300">
          {status}
        </Badge>
      );
  }
}

function formatJobType(jobType: string): string {
  switch (jobType) {
    case "content_apify": return "Source: Apify";
    case "content_bank": return "Source: Bank";
    case "content": return "Source (legacy)";
    case "post": return "Publish";
    default: return jobType;
  }
}

function CronStatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return (
      <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
        <CheckCircle2Icon className="mr-1 size-3" />
        Success
      </Badge>
    );
  }
  if (status === "running") {
    return (
      <Badge className="bg-yellow-500/15 text-yellow-500 border-yellow-500/25">
        <ClockIcon className="mr-1 size-3" />
        Running
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/15 text-red-500 border-red-500/25">
      <XCircleIcon className="mr-1 size-3" />
      Failed
    </Badge>
  );
}

export default async function ThreadsPage() {
  const data = await getThreadsData();

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
          <PlatformIcon platform="threads" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Threads</h1>
            <p className="text-sm text-muted-foreground">
              Content sourcing and publishing
            </p>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <StaggeredContainer className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Published</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <CheckCircle2Icon className="size-4 text-green-500" />
                  <span className="text-2xl font-bold">{data.published}</span>
                </div>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>
        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Scheduled</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <ClockIcon className="size-4 text-blue-500" />
                  <span className="text-2xl font-bold">{data.scheduled}</span>
                </div>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>
        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Drafts</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <FileTextIcon className="size-4 text-zinc-400" />
                  <span className="text-2xl font-bold">{data.drafts}</span>
                </div>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>
        <StaggeredItem>
          <HoverCard>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Failed</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <AlertCircleIcon className="size-4 text-red-500" />
                  <span className="text-2xl font-bold">{data.failed}</span>
                </div>
              </CardContent>
            </Card>
          </HoverCard>
        </StaggeredItem>
      </StaggeredContainer>

      {/* Workflow Pipeline */}
      <div className="mb-6">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Workflow Pipeline
        </h2>
        <WorkflowPipeline
          lastApify={data.lastApify}
          lastBank={data.lastBank}
          lastPublish={data.lastPublish}
        />
      </div>

      <Separator className="mb-6" />

      {/* Recent Posts + Cron History */}
      <Tabs defaultValue="posts">
        <TabsList>
          <TabsTrigger value="posts">Recent Posts</TabsTrigger>
          <TabsTrigger value="crons">Cron History</TabsTrigger>
        </TabsList>

        <TabsContent value="posts">
          <Card>
            <CardHeader>
              <CardTitle>Recent Threads Posts</CardTitle>
              <CardDescription>
                Last 20 posts created for Threads
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.recentPosts.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No posts yet. Run the Source Content step to get started.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Caption</TableHead>
                      <TableHead className="w-[100px]">Status</TableHead>
                      <TableHead className="w-[140px]">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentPosts.map((post) => (
                      <TableRow key={post.id}>
                        <TableCell>
                          <p className="max-w-md truncate text-sm">
                            {post.caption || post.title || "—"}
                          </p>
                          {post.error_message && (
                            <p className="mt-0.5 max-w-md truncate text-xs text-red-400">
                              {post.error_message}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={post.status} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(post.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="crons">
          <Card>
            <CardHeader>
              <CardTitle>Cron Run History</CardTitle>
              <CardDescription>
                Cron executions for Threads in the last 24 hours
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.recentCrons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No cron runs in the last 24 hours.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Job Type</TableHead>
                      <TableHead className="w-[100px]">Status</TableHead>
                      <TableHead className="w-[80px]">Processed</TableHead>
                      <TableHead>Error</TableHead>
                      <TableHead className="w-[140px]">Started</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentCrons.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {formatJobType(run.job_type)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <CronStatusBadge status={run.status} />
                        </TableCell>
                        <TableCell className="text-sm">
                          {run.posts_processed}
                        </TableCell>
                        <TableCell>
                          {run.error_message ? (
                            <p className="max-w-xs truncate text-xs text-red-400">
                              {run.error_message}
                            </p>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(run.started_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
