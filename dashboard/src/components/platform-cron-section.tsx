"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CronCountdown } from "@/components/cron-countdown";

export interface CronRun {
  id: string;
  platform: string;
  job_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  posts_processed: number;
  error_message: string | null;
}

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

/**
 * Countdown + collapsible recent-runs list for a single platform card.
 *
 * Composed inside a <Link> wrapper on the Overview page, so the collapsible
 * trigger must stop click propagation to avoid navigating when toggling.
 */
export function PlatformCronSection({
  platform,
  runs,
}: {
  platform: string;
  runs: CronRun[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <CronCountdown platform={platform} />

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          onClick={(e) => {
            // The card is wrapped in a Link — prevent navigation on toggle.
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <span>Scheduled to Buffer {runs.length > 0 && `(${runs.length})`}</span>
          {open ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
        </CollapsibleTrigger>
        <CollapsiblePanel className="pt-3">
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No posts scheduled in the last 48h
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {runs.map((run) => {
                const duration =
                  run.finished_at && run.started_at
                    ? Math.round(
                        (new Date(run.finished_at).getTime() -
                          new Date(run.started_at).getTime()) /
                          1000
                      )
                    : null;
                return (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {new Date(run.started_at).toLocaleString()}
                    </span>
                    <CronStatusBadge status={run.status} />
                    <span className="text-muted-foreground">
                      {duration !== null ? `${duration}s` : "running…"}
                    </span>
                    <span className="text-muted-foreground">
                      {run.posts_processed} posts
                    </span>
                    {run.error_message && (
                      <span className="w-full truncate text-red-500">
                        {run.error_message}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
