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
import {
  PlayIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";

export interface PathwayAction {
  url: string;
  body?: unknown;
}

export interface PathwayLastRun {
  status: "success" | "failed" | "running";
  startedAt: string;
}

export interface PathwayCardProps {
  number: number;
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

async function runActions(actions: PathwayAction[]): Promise<void> {
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
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status}) at ${action.url}`);
    }
    // /api/cron/run returns 200 with { status: "failed" } on Python exit(1)
    if (data.status === "failed") {
      throw new Error(data.output || data.error || `Cron job failed at ${action.url}`);
    }
  }
}

function LastRunLine({ lastRun }: { lastRun: PathwayLastRun }) {
  const relative = formatTimeAgo(lastRun.startedAt);
  if (lastRun.status === "success") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--overview-fg)]/55">
        <CheckCircle2Icon className="size-3 text-[#8ca082]" />
        <span>Last run: {relative}</span>
        <span>·</span>
        <span className="text-[#8ca082]">Success</span>
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

  async function handleRun() {
    setStatus("running");
    setMessage(null);
    try {
      await runActions(actions);
      setStatus("success");
      setMessage("Pathway completed");
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    } finally {
      router.refresh();
    }
  }

  const running = status === "running";

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
              Pathway {number}
            </Badge>
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
      </CardContent>
    </Card>
  );
}
