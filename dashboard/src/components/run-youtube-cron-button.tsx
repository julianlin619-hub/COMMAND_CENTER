"use client";

/**
 * Manually trigger the YouTube studio-first cron from the dashboard.
 *
 * POSTs `{ job: "youtube-cron" }` to /api/cron/run, which spawns the real
 * Python script — same one Render fires on schedule. On completion, the
 * output log is shown in a dialog and the page is refreshed so newly
 * scheduled rows appear in the table.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { PlayIcon, LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Status = "idle" | "running" | "success" | "failed";

export function RunYouTubeCronButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [output, setOutput] = useState<string>("");
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const run = useCallback(async () => {
    setStatus("running");
    setOutput("");
    setDurationMs(null);
    setDialogOpen(true);

    try {
      const res = await fetch("/api/cron/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: "youtube-cron" }),
      });
      const data = (await res.json()) as {
        status?: string;
        output?: string;
        error?: string;
        durationMs?: number;
      };
      const ok = res.ok && data.status === "success";
      setStatus(ok ? "success" : "failed");
      setOutput(data.output || data.error || "No output");
      setDurationMs(data.durationMs ?? null);
      if (ok) router.refresh();
    } catch (err) {
      setStatus("failed");
      setOutput((err as Error).message);
    }
  }, [router]);

  const running = status === "running";

  return (
    <>
      <Button
        onClick={run}
        disabled={running}
        size="sm"
        variant="outline"
        className="gap-1.5"
      >
        {running ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <PlayIcon className="size-3.5" />
        )}
        {running ? "Running…" : "Run cron now"}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlayIcon className="size-4" />
              YouTube cron
              {status === "success" && (
                <span className="text-xs font-normal text-[#8ca082]">
                  · Success{durationMs != null && ` · ${(durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {status === "failed" && (
                <span className="text-xs font-normal text-red-500">
                  · Failed{durationMs != null && ` · ${(durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
              {running && (
                <span className="text-xs font-normal text-muted-foreground">
                  · Running…
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Runs `python -m cron.youtube_cron` — same script Render fires on
              schedule. Will discover new Studio drafts, call Claude for titles,
              and schedule publishes.
            </DialogDescription>
          </DialogHeader>

          {running && !output && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Waiting for output…
            </div>
          )}

          {output && (
            <pre className="text-[11px] bg-black/30 rounded p-2 overflow-x-auto max-h-[60vh] whitespace-pre-wrap font-mono leading-relaxed">
              {output}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
