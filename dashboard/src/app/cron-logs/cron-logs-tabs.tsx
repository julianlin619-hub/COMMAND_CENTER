"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  StaggeredTableBody,
  StaggeredTableRow,
} from "@/components/motion/staggered-list";

// ── Cron schedule config (mirrors render.yaml) ──────────────────────────
const CRON_SCHEDULES = [
  { platform: "threads", schedule: "0 12 * * *", description: "Daily at 4:00 AM PST" },
  { platform: "tiktok", schedule: "0 12 * * *", description: "Daily at 4:00 AM PST" },
  // instagram_2nd paused — waiting for new Instagram account
];

// ── Helpers ──────────────────────────────────────────────────────────────

/** Compute the next UTC run time from a simple cron pattern. */
function getNextRun(schedule: string): Date {
  const now = new Date();
  const parts = schedule.split(" ");
  const targetMinute = parseInt(parts[0]);
  const hourPart = parts[1];

  if (hourPart.startsWith("*/")) {
    const interval = parseInt(hourPart.slice(2));
    const hours: number[] = [];
    for (let h = 0; h < 24; h += interval) hours.push(h);

    const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetHour = hours.find(
      (h) => h * 60 + targetMinute > currentMinutes
    );

    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(targetMinute);

    if (targetHour !== undefined) {
      next.setUTCHours(targetHour);
    } else {
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(hours[0]);
    }
    return next;
  }

  // Fixed-hour pattern (e.g., "0 11 * * *")
  const targetHour = parseInt(hourPart);
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(targetMinute);
  next.setUTCHours(targetHour);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Format a duration as a short relative string like "in 2h 15m". */
function formatCountdown(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 60_000) return "any moment";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

// ── Sub-components ──────────────────────────────────────────────────────

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
  return (
    <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
      {status}
    </Badge>
  );
}

// ── Types ────────────────────────────────────────────────────────────────

interface CronRun {
  id: string;
  platform: string;
  job_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  posts_processed: number;
  error_message: string | null;
}

// ── Main component ──────────────────────────────────────────────────────

export function CronLogsTabs({ recentRuns }: { recentRuns: CronRun[] }) {
  return (
    <Tabs defaultValue={0}>
      <TabsList variant="line" className="mb-4">
        <TabsTrigger value={0}>Upcoming</TabsTrigger>
        <TabsTrigger value={1}>Recent (48h)</TabsTrigger>
      </TabsList>

      {/* ── Upcoming tab ─────────────────────────────────────────────── */}
      <TabsContent value={0}>
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>Platform</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Next Run (UTC)</TableHead>
                <TableHead>Countdown</TableHead>
              </TableRow>
            </TableHeader>
            <StaggeredTableBody>
              {CRON_SCHEDULES.map((cron) => {
                const next = getNextRun(cron.schedule);
                return (
                  <StaggeredTableRow key={cron.platform} className="border-border">
                    <TableCell className="capitalize font-medium">
                      {cron.platform}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {cron.description}
                    </TableCell>
                    <TableCell>
                      {next.toUTCString().replace(" GMT", " UTC")}
                    </TableCell>
                    <TableCell>
                      <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
                        {formatCountdown(next)}
                      </Badge>
                    </TableCell>
                  </StaggeredTableRow>
                );
              })}
            </StaggeredTableBody>
          </Table>
        </Card>
      </TabsContent>

      {/* ── Recent tab ───────────────────────────────────────────────── */}
      <TabsContent value={1}>
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
              {recentRuns.map((run) => {
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
              {recentRuns.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No cron runs in the last 48 hours.
                  </TableCell>
                </TableRow>
              )}
            </StaggeredTableBody>
          </Table>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
