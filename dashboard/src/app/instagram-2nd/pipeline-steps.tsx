"use client";

/**
 * Interactive pipeline steps for the Instagram (2nd) workflow.
 * Each step can be run individually or all at once.
 *
 * Steps:
 *   1. Pick tweets — selects random unused tweets from the CSV bank
 *   2. Generate — renders PNG images and converts to MP4 videos
 *   3. Schedule — uploads videos to Zernio and schedules to Instagram
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  PlayIcon,
  CheckCircle2Icon,
  XCircleIcon,
  LoaderIcon,
  CircleDotIcon,
  ZapIcon,
  ImageIcon,
  SendIcon,
  DatabaseIcon,
} from "lucide-react";

type StepStatus = "idle" | "running" | "success" | "error";

interface StepState {
  status: StepStatus;
  message: string;
  data?: unknown;
}

interface BankStatus {
  totalTweets: number;
  usedTweets: number;
  remainingUnused: number;
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "running":
      return <LoaderIcon className="size-4 animate-spin text-blue-500" />;
    case "success":
      return <CheckCircle2Icon className="size-4 text-green-500" />;
    case "error":
      return <XCircleIcon className="size-4 text-red-500" />;
    default:
      return <CircleDotIcon className="size-4 text-zinc-600" />;
  }
}

function StatusBadge({ status }: { status: StepStatus }) {
  switch (status) {
    case "running":
      return (
        <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/25">
          Running
        </Badge>
      );
    case "success":
      return (
        <Badge className="bg-green-500/15 text-green-500 border-green-500/25">
          Done
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return (
        <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/25">
          Idle
        </Badge>
      );
  }
}

const INITIAL_STEPS: Record<string, StepState> = {
  pick: { status: "idle", message: "Pick random unused tweets from CSV bank" },
  generate: { status: "idle", message: "Render PNG images and convert to MP4 videos" },
  schedule: { status: "idle", message: "Upload to Zernio and schedule on Instagram" },
};

export function PipelineSteps() {
  const [bankStatus, setBankStatus] = useState<BankStatus | null>(null);
  const [steps, setSteps] = useState<Record<string, StepState>>({ ...INITIAL_STEPS });
  const [pickedTweets, setPickedTweets] = useState<{ hash: string; text: string }[]>([]);
  const [generatedItems, setGeneratedItems] = useState<
    { hash: string; text: string; mp4Path: string }[]
  >([]);

  const updateStep = useCallback(
    (step: string, update: Partial<StepState>) => {
      setSteps((prev) => ({
        ...prev,
        [step]: { ...prev[step], ...update },
      }));
    },
    []
  );

  // Fetch bank status on mount
  useEffect(() => {
    fetch("/api/ig-pipeline/status")
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) setBankStatus(data);
      })
      .catch(() => {});
  }, []);

  async function runPick() {
    updateStep("pick", { status: "running", message: "Picking tweets..." });
    try {
      const res = await fetch("/api/ig-pipeline/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 10 }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setPickedTweets(data.picked);
      updateStep("pick", {
        status: "success",
        message: `Picked ${data.picked.length} tweets (${data.remainingUnused} remaining in bank)`,
        data: data.picked,
      });
      // Refresh bank status
      fetch("/api/ig-pipeline/status")
        .then((r) => r.json())
        .then((d) => { if (!d.error) setBankStatus(d); })
        .catch(() => {});
    } catch (e) {
      updateStep("pick", {
        status: "error",
        message: `Failed: ${(e as Error).message}`,
      });
    }
  }

  async function runGenerate() {
    if (pickedTweets.length === 0) {
      updateStep("generate", {
        status: "error",
        message: "No tweets to generate — run Pick first",
      });
      return;
    }

    updateStep("generate", {
      status: "running",
      message: `Generating ${pickedTweets.length} images + videos...`,
    });
    try {
      const res = await fetch("/api/ig-pipeline/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweets: pickedTweets }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setGeneratedItems(data.generated);
      updateStep("generate", {
        status: "success",
        message: `Generated ${data.generated.length} PNG + MP4 files`,
        data: data.generated,
      });
    } catch (e) {
      updateStep("generate", {
        status: "error",
        message: `Failed: ${(e as Error).message}`,
      });
    }
  }

  async function runSchedule() {
    if (generatedItems.length === 0) {
      updateStep("schedule", {
        status: "error",
        message: "No generated items — run Generate first",
      });
      return;
    }

    updateStep("schedule", {
      status: "running",
      message: `Scheduling ${generatedItems.length} videos to Instagram...`,
    });
    try {
      const res = await fetch("/api/ig-pipeline/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generated: generatedItems }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      updateStep("schedule", {
        status: "success",
        message: `Scheduled ${data.scheduled.length} posts to Instagram`,
        data: data.scheduled,
      });
      // Refresh bank status after scheduling
      fetch("/api/ig-pipeline/status")
        .then((r) => r.json())
        .then((d) => { if (!d.error) setBankStatus(d); })
        .catch(() => {});
    } catch (e) {
      updateStep("schedule", {
        status: "error",
        message: `Failed: ${(e as Error).message}`,
      });
    }
  }

  async function runAll() {
    // Step 1: Pick
    updateStep("pick", { status: "running", message: "Picking tweets..." });
    let picked: { hash: string; text: string }[] = [];
    try {
      const res = await fetch("/api/ig-pipeline/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 10 }),
      });
      const data = await res.json().catch(() => null);
      // Validate the response before advancing state. Checking !res.ok catches
      // 500s where the body lacks an `error` key (e.g. proxy/HTML error pages);
      // the old `if (data.error)` check could silently treat these as success
      // and mutate state with undefined fields.
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      if (!Array.isArray(data?.picked)) {
        throw new Error("Malformed response from /api/ig-pipeline/pick");
      }
      picked = data.picked;
      setPickedTweets(picked);
      updateStep("pick", {
        status: "success",
        message: `Picked ${picked.length} tweets (${data.remainingUnused} remaining)`,
      });
    } catch (e) {
      updateStep("pick", { status: "error", message: `Failed: ${(e as Error).message}` });
      return;
    }

    if (picked.length === 0) {
      updateStep("pick", { status: "success", message: "No unused tweets remaining in bank" });
      return;
    }

    // Step 2: Generate
    updateStep("generate", { status: "running", message: `Generating ${picked.length} images + videos...` });
    let generated: { hash: string; text: string; mp4Path: string }[] = [];
    try {
      const res = await fetch("/api/ig-pipeline/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweets: picked }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      if (!Array.isArray(data?.generated)) {
        throw new Error("Malformed response from /api/ig-pipeline/generate");
      }
      generated = data.generated;
      setGeneratedItems(generated);
      updateStep("generate", { status: "success", message: `Generated ${generated.length} PNG + MP4 files` });
    } catch (e) {
      updateStep("generate", { status: "error", message: `Failed: ${(e as Error).message}` });
      return;
    }

    // Step 3: Schedule
    updateStep("schedule", { status: "running", message: `Scheduling ${generated.length} videos...` });
    try {
      const res = await fetch("/api/ig-pipeline/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generated }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // The schedule route returns `{ scheduled, error, failedHash }` on a
        // mid-batch failure so earlier items don't appear dropped. Include the
        // partial count in the error message so the user knows not to blindly
        // retry — retrying would hit already-scheduled items.
        const partial = Array.isArray(data?.scheduled) ? data.scheduled.length : 0;
        const base = data?.error || `Request failed (${res.status})`;
        throw new Error(partial > 0 ? `${base} (${partial} already scheduled)` : base);
      }
      if (!Array.isArray(data?.scheduled)) {
        throw new Error("Malformed response from /api/ig-pipeline/schedule");
      }
      updateStep("schedule", { status: "success", message: `Scheduled ${data.scheduled.length} posts to Instagram` });
      fetch("/api/ig-pipeline/status")
        .then((r) => r.json())
        .then((d) => { if (!d.error) setBankStatus(d); })
        .catch(() => {});
    } catch (e) {
      updateStep("schedule", { status: "error", message: `Failed: ${(e as Error).message}` });
    }
  }

  const isAnyRunning = Object.values(steps).some((s) => s.status === "running");

  const STEP_CONFIG = [
    { key: "pick", label: "Pick Tweets", icon: DatabaseIcon, run: runPick },
    { key: "generate", label: "Generate Media", icon: ImageIcon, run: runGenerate },
    { key: "schedule", label: "Schedule to IG", icon: SendIcon, run: runSchedule },
  ] as const;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ZapIcon className="size-4 text-blue-500" />
            Pipeline Steps
          </CardTitle>
          <Button
            onClick={runAll}
            disabled={isAnyRunning}
            className="gap-1.5"
          >
            <ZapIcon className="size-3.5" />
            Run All Steps
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Bank status summary */}
        {bankStatus && (
          <div className="flex items-center gap-3 rounded-lg bg-zinc-900 px-3 py-2 text-xs mb-4">
            <DatabaseIcon className="size-3.5 text-zinc-400" />
            <span className="text-zinc-400">Tweet Bank:</span>
            <span className="text-zinc-200 font-medium">
              {bankStatus.remainingUnused}
            </span>
            <span className="text-zinc-500">
              unused / {bankStatus.totalTweets} total
            </span>
          </div>
        )}

        {/* Pipeline steps */}
        <div className="space-y-0">
          {STEP_CONFIG.map((step, i) => {
            const state = steps[step.key];
            const StepIcon = step.icon;
            return (
              <div key={step.key}>
                <div className="flex items-center gap-3 py-3">
                  {/* Step number + status icon */}
                  <div className="flex items-center justify-center size-7 rounded-full bg-zinc-800 text-xs font-medium text-zinc-400 shrink-0">
                    {state.status === "idle" ? i + 1 : <StatusIcon status={state.status} />}
                  </div>

                  {/* Step info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <StepIcon className="size-3.5 text-zinc-500" />
                      <span className="text-sm font-medium">{step.label}</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">
                      {state.message}
                    </p>
                  </div>

                  {/* Status badge + run button */}
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={state.status} />
                    <Button
                      variant="outline"
                      size="icon-xs"
                      disabled={isAnyRunning}
                      onClick={step.run}
                    >
                      <PlayIcon className="size-3" />
                    </Button>
                  </div>
                </div>

                {/* Show picked tweets preview */}
                {step.key === "pick" && state.status === "success" && pickedTweets.length > 0 ? (
                  <div className="ml-10 mb-2 max-h-32 overflow-y-auto rounded-lg bg-zinc-900 p-2 text-xs text-zinc-400 space-y-1">
                    {pickedTweets.map((t) => (
                      <div key={t.hash} className="truncate">
                        <span className="text-zinc-600 font-mono">{t.hash}</span>{" "}
                        {t.text.slice(0, 80)}
                        {t.text.length > 80 ? "..." : ""}
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Show scheduled post IDs */}
                {step.key === "schedule" && state.status === "success" && state.data ? (
                  <div className="ml-10 mb-2 max-h-32 overflow-y-auto rounded-lg bg-zinc-900 p-2 text-xs text-zinc-400 space-y-1">
                    {(state.data as { hash: string; postId: string }[]).map((s) => (
                      <div key={s.hash} className="truncate">
                        <span className="text-green-500">&#10003;</span>{" "}
                        <span className="text-zinc-600 font-mono">{s.hash}</span>{" "}
                        &rarr; {s.postId}
                      </div>
                    ))}
                  </div>
                ) : null}

                {i < STEP_CONFIG.length - 1 && <Separator />}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
