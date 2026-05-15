"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  PlayIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";

export interface PathwayAction {
  url: string;
  body?: unknown;
}

export interface PathwayLastRun {
  status: "success" | "failed" | "running";
  startedAt: string;
  /** posts_processed from the cron_runs row that drives this pathway's
   *  final phase (e.g. buffer_send, content_apify). Renders inline next
   *  to the "Last run" timestamp so the operator can see "did the last
   *  run actually produce anything?" at a glance. null means we don't
   *  have a count to show — render is suppressed. */
  count?: number | null;
}

export interface PathwayCardProps {
  // Optional — when this card is the *only* pathway on its page (e.g. the
  // Command Center filtered view), the "Pathway 1" badge is redundant and
  // we omit it. Pages that show multiple pathways still pass a number so
  // operators can refer to them ordinally.
  number?: number;
  title: string;
  steps: string[];
  actions: PathwayAction[];
  lastRun?: PathwayLastRun | null;
}

type RunStatus = "idle" | "running" | "success" | "error";

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ActionOutcome {
  /** Last action's full stdout+stderr, when the underlying API returned one
   *  (currently /api/cron/run does — others may not). Available in both the
   *  success and failure branches so the operator can see env-diag, phase
   *  progress, etc., not just the bottom error line. */
  output: string | null;
}

async function runActions(actions: PathwayAction[]): Promise<ActionOutcome> {
  let lastOutput: string | null = null;
  for (const action of actions) {
    const res = await fetch(action.url, {
      method: "POST",
      headers: action.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: action.body !== undefined ? JSON.stringify(action.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      status?: string;
      output?: string;
    };
    lastOutput = data.output ?? null;
    if (!res.ok) {
      throw new ActionError(
        data.error || `Request failed (${res.status}) at ${action.url}`,
        lastOutput,
      );
    }
    // /api/cron/run returns 200 with { status: "failed" } on Python exit(1)
    if (data.status === "failed") {
      throw new ActionError(
        data.error || `Cron job failed at ${action.url}`,
        lastOutput,
      );
    }
  }
  return { output: lastOutput };
}

class ActionError extends Error {
  constructor(message: string, public readonly output: string | null) {
    super(message);
    this.name = "ActionError";
  }
}

function LastRunLine({ lastRun }: { lastRun: PathwayLastRun }) {
  const relative = formatTimeAgo(lastRun.startedAt);

  // Append "· N posts" when we have a count from the underlying cron_run.
  // Use singular "post" for 1, plural "posts" otherwise — small detail but
  // the page reads weird without it.
  const countNode =
    typeof lastRun.count === "number" ? (
      <>
        <span>·</span>
        <span>
          {lastRun.count} {lastRun.count === 1 ? "post" : "posts"}
        </span>
      </>
    ) : null;

  if (lastRun.status === "success") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--overview-fg)]/55">
        <CheckCircle2Icon className="size-3 text-[#8ca082]" />
        <span>Last run: {relative}</span>
        <span>·</span>
        <span className="text-[#8ca082]">Success</span>
        {countNode}
      </div>
    );
  }
  if (lastRun.status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--overview-fg)]/55">
        <XCircleIcon className="size-3 text-red-500" />
        <span>Last run: {relative}</span>
        <span>·</span>
        <span className="text-red-500">Failed</span>
        {countNode}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--overview-fg)]/55">
      <LoaderIcon className="size-3 animate-spin text-[#ae5630]" />
      <span>Running since {relative}</span>
    </div>
  );
}

export function PathwayCard({
  number,
  title,
  steps,
  actions,
  lastRun,
}: PathwayCardProps) {
  const router = useRouter();
  const [status, setStatus] = useState<RunStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);

  async function handleRun() {
    setStatus("running");
    setMessage(null);
    setOutput(null);
    setOutputExpanded(false);
    try {
      const outcome = await runActions(actions);
      setStatus("success");
      setMessage("Pathway completed");
      setOutput(outcome.output);
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
      // Auto-expand on failure so the operator immediately sees env-diag /
      // phase logs / Python tracebacks without an extra click.
      if (err instanceof ActionError) {
        setOutput(err.output);
        setOutputExpanded(true);
      }
    } finally {
      router.refresh();
    }
  }

  const running = status === "running";
  const hasOutput = output !== null && output.length > 0;

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* Ordinal badge only renders when the page is showing more than
                one pathway. See PathwayCardProps.number for rationale. */}
            {number !== undefined && (
              <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
                Pathway {number}
              </Badge>
            )}
            <CardTitle className="text-sm">{title}</CardTitle>
          </div>
          <Button onClick={handleRun} disabled={running} size="sm">
            {running ? (
              <>
                <LoaderIcon className="animate-spin" />
                Running…
              </>
            ) : (
              <>
                <PlayIcon />
                Run
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="space-y-1.5">
          {steps.map((label, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] text-[var(--overview-fg)]/70">
                {i + 1}
              </span>
              <span className="text-[var(--overview-fg)]/90">{label}</span>
            </li>
          ))}
        </ol>

        <div className="mt-4 flex items-center justify-between gap-3">
          {lastRun ? (
            <LastRunLine lastRun={lastRun} />
          ) : (
            <span className="text-xs text-[var(--overview-fg)]/45">Never run</span>
          )}

          {status === "success" && message && (
            <span className="text-xs text-[#8ca082]">{message}</span>
          )}
          {status === "error" && message && (
            <span className="max-w-sm truncate text-xs text-red-500" title={message}>
              {message}
            </span>
          )}
        </div>

        {/* Full output panel — collapsible; auto-expanded on failure so the
            operator sees env-diag and the failing phase without scrolling
            past a truncated single-line error. */}
        {hasOutput && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setOutputExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-[var(--overview-fg)]/55 hover:text-[var(--overview-fg)]/85 transition-colors"
            >
              {outputExpanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
              {outputExpanded ? "Hide output" : "Show full output"}
            </button>
            {outputExpanded && (
              <>
                <Separator className="my-2" />
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-[var(--overview-fg)]/75">
                  {output}
                </pre>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
