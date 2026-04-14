"use client";

/**
 * Cron Run Button — sits on the dashboard home page and lets the user
 * trigger all cron jobs manually, as if Render's scheduler fired them.
 *
 * Each cron job is run sequentially via POST /api/cron/run, which spawns
 * the real Python script. Posts WILL be published, Apify/Buffer WILL be
 * called, and cron_runs WILL be logged.
 */

import { useState, useCallback } from "react";
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
import {
  PlayIcon,
  LoaderIcon,
  CircleCheckIcon,
  CircleXIcon,
  CircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";

interface CronJobDef {
  name: string;
  label: string;
  schedule: string;
}

// Matches the cron jobs defined in render.yaml and the CRON_MODULES map
// in /api/cron/run/route.ts.
const CRON_JOBS: CronJobDef[] = [
  { name: "threads-cron", label: "Threads", schedule: "0 11 * * *" },
  { name: "tiktok-pipeline", label: "TikTok Pipeline", schedule: "0 12 * * *" },
  { name: "tiktok-bank-pipeline", label: "TikTok Bank", schedule: "0 14 * * *" },
  { name: "facebook-pipeline", label: "Facebook Pipeline", schedule: "0 13 * * *" },
  { name: "instagram-cron", label: "Instagram", schedule: "0 */4 * * *" },
  { name: "youtube-cron", label: "YouTube", schedule: "0 */4 * * *" },
  { name: "linkedin-cron", label: "LinkedIn", schedule: "0 */4 * * *" },
];

type JobStatus = "pending" | "running" | "success" | "failed";

interface JobResult {
  status: JobStatus;
  output: string;
  durationMs?: number;
}

export function CronTestRunButton() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, JobResult>>({});
  // Track which job outputs are expanded (collapsed by default after completion)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const runAllCrons = useCallback(async () => {
    setRunning(true);
    setExpanded({});

    // Initialize all jobs as pending
    const initial: Record<string, JobResult> = {};
    for (const job of CRON_JOBS) {
      initial[job.name] = { status: "pending", output: "" };
    }
    setResults(initial);

    // Run each cron job sequentially — avoids resource conflicts and makes
    // output easier to follow.
    for (const job of CRON_JOBS) {
      setResults((prev) => ({
        ...prev,
        [job.name]: { status: "running", output: "" },
      }));

      try {
        const res = await fetch("/api/cron/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job: job.name }),
        });
        const data = await res.json();

        const status: JobStatus =
          res.ok && data.status === "success" ? "success" : "failed";

        setResults((prev) => ({
          ...prev,
          [job.name]: {
            status,
            output: data.output || data.error || "No output",
            durationMs: data.durationMs,
          },
        }));

        // Auto-expand failed jobs so the user sees what went wrong
        if (status === "failed") {
          setExpanded((prev) => ({ ...prev, [job.name]: true }));
        }
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [job.name]: {
            status: "failed",
            output: (err as Error).message,
          },
        }));
        setExpanded((prev) => ({ ...prev, [job.name]: true }));
      }
    }

    setRunning(false);
  }, []);

  /** Run a single cron job (called from the per-row play button). */
  const runSingleCron = useCallback(async (jobName: string) => {
    setResults((prev) => ({
      ...prev,
      [jobName]: { status: "running", output: "" },
    }));

    try {
      const res = await fetch("/api/cron/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: jobName }),
      });
      const data = await res.json();

      const status: JobStatus =
        res.ok && data.status === "success" ? "success" : "failed";

      setResults((prev) => ({
        ...prev,
        [jobName]: {
          status,
          output: data.output || data.error || "No output",
          durationMs: data.durationMs,
        },
      }));
      setExpanded((prev) => ({ ...prev, [jobName]: status === "failed" }));
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [jobName]: {
          status: "failed",
          output: (err as Error).message,
        },
      }));
      setExpanded((prev) => ({ ...prev, [jobName]: true }));
    }
  }, []);

  function handleOpen() {
    setOpen(true);
    runAllCrons();
  }

  function toggleExpand(jobName: string) {
    setExpanded((prev) => ({ ...prev, [jobName]: !prev[jobName] }));
  }

  const statusIcon = (status: JobStatus) => {
    switch (status) {
      case "pending":
        return <CircleIcon className="size-4 text-zinc-600" />;
      case "running":
        return <LoaderIcon className="size-4 animate-spin text-blue-500" />;
      case "success":
        return <CircleCheckIcon className="size-4 text-green-500" />;
      case "failed":
        return <CircleXIcon className="size-4 text-red-500" />;
    }
  };

  const statusBadge = (status: JobStatus) => {
    switch (status) {
      case "pending":
        return (
          <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/25">
            Pending
          </Badge>
        );
      case "running":
        return (
          <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
            Running
          </Badge>
        );
      case "success":
        return (
          <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
            Success
          </Badge>
        );
      case "failed":
        return (
          <Badge className="bg-red-500/15 text-red-500 border-red-500/25">
            Failed
          </Badge>
        );
    }
  };

  // Count results for the summary line
  const successCount = Object.values(results).filter(
    (r) => r.status === "success",
  ).length;
  const failCount = Object.values(results).filter(
    (r) => r.status === "failed",
  ).length;
  const doneCount = successCount + failCount;

  return (
    <>
      <Button
        variant="outline"
        onClick={handleOpen}
        disabled={running}
        className="gap-1.5"
      >
        {running ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
        Run all crons
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayIcon className="size-4 text-blue-500" />
              Cron Job Runner
            </DialogTitle>
            <DialogDescription>
              Runs each cron job for real — posts will be published and external
              APIs (Apify, Buffer) will be called.
            </DialogDescription>
          </DialogHeader>

          {/* Summary banner */}
          {doneCount > 0 && (
            <div className="rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-200 font-medium">{doneCount}</span> of{" "}
              {CRON_JOBS.length} complete
              {successCount > 0 && (
                <span className="text-green-500 ml-2">
                  {successCount} succeeded
                </span>
              )}
              {failCount > 0 && (
                <span className="text-red-500 ml-2">{failCount} failed</span>
              )}
            </div>
          )}

          {/* Per-cron job rows */}
          <div className="space-y-2">
            {CRON_JOBS.map((job) => {
              const result = results[job.name];
              const status = result?.status ?? "pending";
              const hasOutput =
                result?.output && status !== "pending" && status !== "running";
              const isExpanded = expanded[job.name];

              return (
                <div
                  key={job.name}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Expand/collapse toggle — only shown when there's output */}
                      {hasOutput ? (
                        <button
                          onClick={() => toggleExpand(job.name)}
                          className="shrink-0 text-zinc-500 hover:text-zinc-300"
                        >
                          {isExpanded ? (
                            <ChevronDownIcon className="size-4" />
                          ) : (
                            <ChevronRightIcon className="size-4" />
                          )}
                        </button>
                      ) : (
                        statusIcon(status)
                      )}
                      <span className="text-sm font-medium truncate">
                        {job.label}
                      </span>
                      <code className="text-[10px] text-zinc-500 font-mono">
                        {job.name}
                      </code>
                      {result?.durationMs != null && (
                        <span className="text-[10px] text-zinc-600">
                          {(result.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {statusBadge(status)}
                      {/* Per-row re-run button — only when not running */}
                      {!running && status !== "running" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => runSingleCron(job.name)}
                          disabled={
                            result?.status === "running"
                          }
                        >
                          <PlayIcon className="size-3" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Collapsible output log */}
                  {hasOutput && isExpanded && (
                    <>
                      <Separator className="my-2" />
                      <pre className="text-[11px] text-zinc-400 bg-zinc-900/60 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap font-mono leading-relaxed">
                        {result.output}
                      </pre>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={runAllCrons}
              disabled={running}
              className="gap-1.5"
            >
              <PlayIcon className="size-3" />
              Re-run all
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
