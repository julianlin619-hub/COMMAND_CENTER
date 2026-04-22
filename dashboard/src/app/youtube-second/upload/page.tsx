"use client";

/**
 * YouTube (2nd channel) — direct-upload form.
 *
 * Two inputs: MP4 file + title. Everything else is hardcoded in
 * lib/youtube-second-defaults.ts.
 *
 * Flow (matches PLAN):
 *   1. POST /api/youtube-second/upload-init  → { post_id, upload_url, publish_at }
 *   2. Browser XHR-PUTs the file directly to YouTube's resumable endpoint
 *      (bytes never touch our server).
 *   3. POST /api/youtube-second/upload-complete with { post_id, video_id }
 *      → { permalink, publish_at }
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uploadToYouTube } from "@/lib/youtube-resumable-upload";

type Phase =
  | { kind: "idle" }
  | { kind: "initializing" }
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "finalizing" }
  | { kind: "done"; permalink: string; publishAt: string | null }
  | { kind: "error"; message: string };

const MAX_TITLE_LENGTH = 100;

export default function YouTubeSecondUploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const busy =
    phase.kind === "initializing" ||
    phase.kind === "uploading" ||
    phase.kind === "finalizing";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !title.trim()) return;

    try {
      setPhase({ kind: "initializing" });

      // Step 1: tell the backend to claim a slot and mint an upload URL.
      const initRes = await fetch("/api/youtube-second/upload-init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          filename: file.name,
          size: file.size,
          content_type: file.type || "video/mp4",
        }),
      });
      if (!initRes.ok) {
        const text = await initRes.text().catch(() => "");
        throw new Error(
          `Init failed (${initRes.status}): ${safePreview(text)}`,
        );
      }
      const init = (await initRes.json()) as {
        post_id: string;
        upload_url: string;
        publish_at: string;
      };

      // Step 2: stream the file straight to YouTube.
      setPhase({ kind: "uploading", loaded: 0, total: file.size });
      const { videoId } = await uploadToYouTube(init.upload_url, file, {
        onProgress: (loaded, total) =>
          setPhase({ kind: "uploading", loaded, total }),
      });

      // Step 3: verify + transition post → scheduled.
      setPhase({ kind: "finalizing" });
      const completeRes = await fetch("/api/youtube-second/upload-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: init.post_id, video_id: videoId }),
      });
      if (!completeRes.ok) {
        const text = await completeRes.text().catch(() => "");
        throw new Error(
          `Finalize failed (${completeRes.status}): ${safePreview(text)}`,
        );
      }
      const complete = (await completeRes.json()) as {
        permalink: string;
        publish_at: string | null;
      };

      setPhase({
        kind: "done",
        permalink: complete.permalink,
        publishAt: complete.publish_at,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function reset() {
    setFile(null);
    setTitle("");
    setPhase({ kind: "idle" });
  }

  return (
    <div
      className="min-h-screen px-6 py-10"
      style={{
        backgroundColor: "var(--overview-bg)",
        color: "var(--overview-fg)",
      }}
    >
      <div className="max-w-[640px] mx-auto">
        <header className="mb-8">
          <Link
            href="/"
            className="text-[11px] font-mono tracking-wider uppercase text-[var(--overview-fg)]/55 hover:text-[var(--overview-fg)]/80"
          >
            ← Back to Command Center
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            YouTube (2nd channel)
          </h1>
          <p className="mt-2 text-sm text-[var(--overview-fg)]/60">
            Upload a video. It&rsquo;ll be auto-scheduled to the next free
            publish slot (10 slots/day, UTC grid). The file streams directly
            to YouTube — bytes never touch our server.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>New upload</CardTitle>
          </CardHeader>
          <CardContent>
            {phase.kind === "done" ? (
              <DoneView
                permalink={phase.permalink}
                publishAt={phase.publishAt}
                onReset={reset}
              />
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="file">Video file</Label>
                  <Input
                    id="file"
                    type="file"
                    accept="video/*"
                    disabled={busy}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="text-[var(--overview-fg)]/40 file:mr-3 file:cursor-pointer file:rounded-md file:bg-zinc-800 file:px-3 file:py-1 file:text-zinc-100 hover:file:bg-zinc-700"
                  />
                  {file && (
                    <p className="text-xs text-[var(--overview-fg)]/55 font-mono">
                      {file.name} — {formatBytes(file.size)}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    type="text"
                    value={title}
                    disabled={busy}
                    maxLength={MAX_TITLE_LENGTH}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="My new video"
                  />
                  <p className="text-xs text-[var(--overview-fg)]/55">
                    {title.length} / {MAX_TITLE_LENGTH}
                  </p>
                </div>

                {phase.kind === "uploading" && (
                  <ProgressBar
                    loaded={phase.loaded}
                    total={phase.total}
                    label="Uploading to YouTube"
                  />
                )}
                {phase.kind === "initializing" && (
                  <StatusLine text="Claiming slot…" />
                )}
                {phase.kind === "finalizing" && (
                  <StatusLine text="Finalizing…" />
                )}
                {phase.kind === "error" && (
                  <div
                    className="rounded-md border px-3 py-2 text-sm"
                    style={{
                      borderColor: "rgba(220,80,60,0.35)",
                      backgroundColor: "rgba(220,80,60,0.08)",
                      color: "#f3c8c0",
                    }}
                  >
                    {phase.message}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    type="submit"
                    disabled={busy || !file || !title.trim()}
                  >
                    {busy ? "Uploading…" : "Upload & schedule"}
                  </Button>
                  {phase.kind === "error" && (
                    <Button type="button" variant="ghost" onClick={reset}>
                      Reset
                    </Button>
                  )}
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DoneView({
  permalink,
  publishAt,
  onReset,
}: {
  permalink: string;
  publishAt: string | null;
  onReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="text-sm">
        <div className="font-medium mb-1">Uploaded.</div>
        <div className="text-[var(--overview-fg)]/70">
          Scheduled — link will work at{" "}
          <span className="font-mono">
            {publishAt ? formatUtc(publishAt) : "slot time"}
          </span>
          .
        </div>
      </div>
      <a
        href={permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-sm font-mono underline underline-offset-2 break-all"
        style={{ color: "var(--terracotta)" }}
      >
        {permalink}
      </a>
      <p className="text-xs text-[var(--overview-fg)]/50">
        (Private on YouTube until the scheduled time — the link will say
        &ldquo;video unavailable&rdquo; until then, then flip to public
        automatically.)
      </p>
      <Button type="button" onClick={onReset}>
        Upload another
      </Button>
    </div>
  );
}

function ProgressBar({
  loaded,
  total,
  label,
}: {
  loaded: number;
  total: number;
  label: string;
}) {
  const pct = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-[var(--overview-fg)]/65 font-mono">
        <span>{label}</span>
        <span>
          {formatBytes(loaded)} / {formatBytes(total)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div
        className="h-1.5 w-full rounded-full overflow-hidden"
        style={{ backgroundColor: "rgba(255,255,255,0.07)" }}
      >
        <div
          className="h-full transition-[width] duration-100 ease-out"
          style={{
            width: `${pct}%`,
            backgroundColor: "var(--terracotta)",
          }}
        />
      </div>
    </div>
  );
}

function StatusLine({ text }: { text: string }) {
  return (
    <div className="text-xs font-mono text-[var(--overview-fg)]/65">{text}</div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUtc(iso: string): string {
  try {
    const d = new Date(iso);
    // YYYY-MM-DD HH:MM UTC — unambiguous and machine-friendly.
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
    );
  } catch {
    return iso;
  }
}

/** Keep error previews safe — strip anything that looks like a token. */
function safePreview(s: string): string {
  return s
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[REDACTED]")
    .slice(0, 200);
}
