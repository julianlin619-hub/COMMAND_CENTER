"use client";

/**
 * Cron Test Run Button — sits on the dashboard home page and lets the user
 * preview what would happen if every cron job ran right now.
 *
 * It's explicitly a DRY RUN: the /api/cron/test-run endpoint is read-only
 * — it checks schedules and DB state but never publishes, never calls
 * Apify/Buffer, and never writes to cron_runs/posts/schedules. The real
 * Render-scheduled cron jobs are not triggered and run on their normal
 * schedule.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PlayIcon, LoaderIcon, FlaskConicalIcon } from "lucide-react";

interface SimulatedStep {
  name: string;
  description: string;
  detail: string;
}

interface SimulatedCron {
  platform: string;
  label: string;
  cronName: string;
  schedule: string;
  kind: "publish" | "source_publish" | "pipeline";
  steps: SimulatedStep[];
  wouldPublish: number;
}

interface TestRunResponse {
  dryRun: boolean;
  simulatedAt: string;
  note: string;
  results: SimulatedCron[];
}

export function CronTestRunButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestRunResponse | null>(null);

  async function runSimulation() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/cron/test-run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Total "would publish" roll-up across all cron jobs, so the summary line
  // at the top of the dialog gives the user a single number to read.
  const totalWouldPublish =
    result?.results.reduce((acc, r) => acc + r.wouldPublish, 0) ?? 0;

  return (
    <>
      <Button
        variant="outline"
        onClick={runSimulation}
        disabled={loading}
        className="gap-1.5"
      >
        {loading ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <FlaskConicalIcon className="size-3.5" />
        )}
        Test run all crons
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConicalIcon className="size-4 text-blue-500" />
              Cron Dry Run
              <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
                Simulation
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Previews what every cron job would do right now. Nothing is
              published and the real Render crons are not triggered.
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-4 text-sm text-zinc-400">
              <LoaderIcon className="size-4 animate-spin" />
              Simulating all cron jobs…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {result && (
            <>
              {/* Summary banner */}
              <div className="rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400 space-y-1">
                <div>
                  <span className="text-zinc-200 font-medium">
                    {totalWouldPublish}
                  </span>{" "}
                  post(s) would be published across all platforms.
                </div>
                <div className="text-zinc-500">{result.note}</div>
              </div>

              {/* Per-cron breakdown */}
              <div className="space-y-3">
                {result.results.map((r) => (
                  <div
                    key={r.platform}
                    className="rounded-lg border border-border p-3"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">
                          {r.label}
                        </span>
                        <code className="text-[10px] text-zinc-500 font-mono">
                          {r.cronName}
                        </code>
                        <code className="text-[10px] text-zinc-600 font-mono">
                          {r.schedule}
                        </code>
                      </div>
                      {r.wouldPublish > 0 ? (
                        <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
                          {r.wouldPublish} would publish
                        </Badge>
                      ) : (
                        <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/25">
                          Nothing to publish
                        </Badge>
                      )}
                    </div>
                    <Separator className="mb-2" />
                    <ol className="space-y-1.5">
                      {r.steps.map((s, i) => (
                        <li key={i} className="text-xs">
                          <div className="flex items-start gap-2">
                            <span className="text-zinc-600 font-mono mt-0.5 shrink-0">
                              {i + 1}.
                            </span>
                            <div className="min-w-0">
                              <div className="text-zinc-200">{s.name}</div>
                              <div className="text-zinc-500">
                                {s.description}
                              </div>
                              <div className="text-zinc-400 mt-0.5">
                                {s.detail}
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runSimulation}
                  disabled={loading}
                  className="gap-1.5"
                >
                  <PlayIcon className="size-3" />
                  Re-run simulation
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
