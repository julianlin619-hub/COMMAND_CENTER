/**
 * Cron Logs Page — history of background cron job runs.
 *
 * Shows status, timing, and error info for each platform's cron jobs.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StaggeredTableBody, StaggeredTableRow } from "@/components/motion/staggered-list";

export const dynamic = "force-dynamic";

function CronStatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return (
      <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
        success
      </Badge>
    );
  }
  if (status === "failed") {
    return <Badge variant="destructive">failed</Badge>;
  }
  return <Badge variant="secondary">{status}</Badge>;
}

export default async function CronLogsPage() {
  const supabase = getSupabaseClient();

  const { data: runs } = await supabase
    .from("cron_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(100);

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Cron Logs</h2>
        <p className="text-sm text-muted-foreground">
          Background job history across all platforms
        </p>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>Platform</TableHead>
              <TableHead>Job Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Posts</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <StaggeredTableBody>
            {runs?.map((run) => {
              const duration =
                run.finished_at && run.started_at
                  ? Math.round(
                      (new Date(run.finished_at).getTime() -
                        new Date(run.started_at).getTime()) /
                        1000
                    )
                  : null;
              return (
                <StaggeredTableRow key={run.id} className="border-border">
                  <TableCell className="capitalize">{run.platform}</TableCell>
                  <TableCell>{run.job_type}</TableCell>
                  <TableCell>
                    <CronStatusBadge status={run.status} />
                  </TableCell>
                  <TableCell>
                    {new Date(run.started_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {duration !== null ? (
                      `${duration}s`
                    ) : (
                      <span className="text-muted-foreground">running...</span>
                    )}
                  </TableCell>
                  <TableCell>{run.posts_processed}</TableCell>
                  <TableCell className="max-w-xs truncate text-red-500">
                    {run.error_message || (
                      <span className="text-zinc-600">-</span>
                    )}
                  </TableCell>
                </StaggeredTableRow>
              );
            })}
            {(!runs || runs.length === 0) && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-24 text-center text-muted-foreground"
                >
                  No cron runs yet.
                </TableCell>
              </TableRow>
            )}
          </StaggeredTableBody>
        </Table>
      </Card>
    </AppShell>
  );
}
