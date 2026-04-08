/**
 * Schedule Page — shows upcoming (not yet picked up) scheduled posts.
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

export default async function SchedulePage() {
  const supabase = getSupabaseClient();

  const { data: schedules } = await supabase
    .from("schedules")
    .select("*, posts(*)")
    .is("picked_up_at", null)
    .order("scheduled_for", { ascending: true })
    .limit(50);

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Schedule</h2>
        <p className="text-sm text-muted-foreground">
          Upcoming posts waiting to be published
        </p>
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>Platform</TableHead>
              <TableHead>Title / Caption</TableHead>
              <TableHead>Scheduled For</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <StaggeredTableBody>
            {schedules?.map((s) => (
              <StaggeredTableRow key={s.id} className="border-border">
                <TableCell className="capitalize">
                  {s.posts?.platform}
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  {s.posts?.title || s.posts?.caption || "-"}
                </TableCell>
                <TableCell>
                  {new Date(s.scheduled_for).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
                    {s.posts?.status || "scheduled"}
                  </Badge>
                </TableCell>
              </StaggeredTableRow>
            ))}
            {(!schedules || schedules.length === 0) && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  No upcoming scheduled posts.
                </TableCell>
              </TableRow>
            )}
          </StaggeredTableBody>
        </Table>
      </Card>
    </AppShell>
  );
}
