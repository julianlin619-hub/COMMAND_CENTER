"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronRightIcon,
  DownloadIcon,
  FileTextIcon,
  LoaderIcon,
  SendIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";

interface CronRun {
  status: string;
  started_at: string;
  finished_at: string | null;
  posts_processed: number;
  error_message: string | null;
}

interface Phase {
  id: string;
  title: string;
  description: string;
  endpoint: string;
  icon: React.ReactNode;
  lastRun: CronRun | null;
}

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

function PhaseCard({ phase }: { phase: Phase }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch(phase.endpoint, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      router.refresh();
    }
  }

  const lastRun = phase.lastRun;
  const isSuccess = lastRun?.status === "success";

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-zinc-800">
            {phase.icon}
          </div>
          <div>
            <CardTitle className="text-sm font-medium">{phase.title}</CardTitle>
          </div>
        </div>
        <CardDescription className="text-xs">{phase.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end gap-3">
        {/* Last run info */}
        {lastRun ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last run</span>
              <span>{formatTimeAgo(lastRun.started_at)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              {isSuccess ? (
                <Badge className="bg-green-500/15 text-green-500 border-green-500/25 text-[10px]">
                  <CheckCircle2Icon className="mr-1 size-3" />
                  Success
                </Badge>
              ) : (
                <Badge className="bg-red-500/15 text-red-500 border-red-500/25 text-[10px]">
                  <XCircleIcon className="mr-1 size-3" />
                  Failed
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Processed</span>
              <span className="font-medium">{lastRun.posts_processed}</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No runs yet</p>
        )}

        {/* Trigger button */}
        <Button
          onClick={handleRun}
          disabled={loading}
          variant="outline"
          size="sm"
          className="w-full"
        >
          {loading ? (
            <>
              <LoaderIcon className="size-3 animate-spin" />
              Running…
            </>
          ) : (
            "Run Now"
          )}
        </Button>

        {/* Result / error feedback */}
        {result && (
          <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-400">
            {formatResult(phase.id, result)}
          </div>
        )}
        {error && (
          <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatResult(phaseId: string, data: Record<string, unknown>): string {
  switch (phaseId) {
    case "source_apify":
      return `Sourced ${data.sourced} new posts (${data.fetched} tweets found)`;
    case "source_bank":
      return `Sourced ${data.sourced} from bank (${data.remaining} remaining)`;
    case "publish":
      return `Published ${data.published}${data.failed ? `, ${data.failed} failed` : ""}`;
    default:
      return JSON.stringify(data);
  }
}

export function WorkflowPipeline({
  lastApify,
  lastBank,
  lastPublish,
}: {
  lastApify: CronRun | null;
  lastBank: CronRun | null;
  lastPublish: CronRun | null;
}) {
  const phases: Phase[] = [
    {
      id: "source_apify",
      title: "Source Tweets",
      description:
        "Fetch tweets from Apify and create scheduled posts in the queue.",
      endpoint: "/api/threads/source",
      icon: <DownloadIcon className="size-4 text-blue-400" />,
      lastRun: lastApify,
    },
    {
      id: "source_bank",
      title: "Source Bank",
      description:
        "Pick random entries from the content bank CSV and schedule them.",
      endpoint: "/api/threads/bank",
      icon: <FileTextIcon className="size-4 text-blue-400" />,
      lastRun: lastBank,
    },
    {
      id: "publish",
      title: "Publish",
      description:
        "Send queued posts to Threads via Buffer's API.",
      endpoint: "/api/threads/publish",
      icon: <SendIcon className="size-4 text-blue-400" />,
      lastRun: lastPublish,
    },
  ];

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
      {phases.map((phase, i) => (
        <div key={phase.id} className="flex flex-1 items-stretch gap-3">
          {i > 0 && (
            <div className="hidden items-center text-zinc-600 md:flex">
              <ChevronRightIcon className="size-4" />
            </div>
          )}
          <div className="flex-1">
            <PhaseCard phase={phase} />
          </div>
        </div>
      ))}
    </div>
  );
}
