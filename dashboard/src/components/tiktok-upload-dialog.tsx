"use client";

/**
 * Manual Upload Dialog (TikTok + YouTube Shorts).
 *
 * File picker + title + caption → POST /api/tiktok/manual-upload. On success,
 * the API has queued the video on Buffer's TikTok channel AND YouTube Shorts
 * channel (next open slot on each). The dialog shows both Buffer post IDs —
 * or a partial-success state if YouTube failed — and stays open so the user
 * can confirm, mirroring ig-pipeline-dialog's idle/running/success/error
 * pattern.
 *
 * Title is required: YouTube rejects video inserts without one.
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  UploadIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from "lucide-react";

const MAX_FILE_BYTES = 250 * 1024 * 1024;

type UploadStatus = "idle" | "running" | "success" | "error";

export function TikTokUploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const [tiktokBufferId, setTiktokBufferId] = useState<string | null>(null);
  const [youtubeBufferId, setYoutubeBufferId] = useState<string | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCaption("");
    setStatus("idle");
    setMessage("");
    setTiktokBufferId(null);
    setYoutubeBufferId(null);
    setYoutubeError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const sizeOk = !file || file.size <= MAX_FILE_BYTES;
  const canSubmit =
    status !== "running" &&
    !!file &&
    sizeOk &&
    title.trim().length > 0 &&
    caption.trim().length > 0;

  async function submit() {
    if (!file) return;
    setStatus("running");
    setMessage("Uploading to Supabase and sending to Buffer…");
    setTiktokBufferId(null);
    setYoutubeBufferId(null);
    setYoutubeError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      fd.append("caption", caption);
      const res = await fetch("/api/tiktok/manual-upload", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        tiktokBufferId?: string;
        youtubeBufferId?: string;
        youtubeError?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setStatus("success");
      setTiktokBufferId(data.tiktokBufferId ?? null);
      setYoutubeBufferId(data.youtubeBufferId ?? null);
      setYoutubeError(data.youtubeError ?? null);
      setMessage(
        data.youtubeError
          ? "TikTok queued, but the YouTube side failed — see below."
          : "Video queued on Buffer's TikTok + YouTube Shorts channels.",
      );
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon className="size-4 text-[#ae5630]" />
            Manual Upload · TikTok + YouTube Shorts
          </DialogTitle>
          <DialogDescription>
            Queues the same mp4 on Buffer&apos;s TikTok and YouTube Shorts
            channels (next open slot on each). The source file is removed from
            storage 3 days after Buffer publishes both.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
              Video (mp4)
            </label>
            <input
              type="file"
              accept="video/mp4"
              disabled={status === "running"}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-[var(--overview-fg)]/80 file:mr-3 file:rounded-md file:border-0 file:bg-white/[0.06] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--overview-fg)] hover:file:bg-white/[0.1]"
            />
            {file && (
              <p
                className={`text-xs ${
                  sizeOk
                    ? "text-[var(--overview-fg)]/50"
                    : "text-red-400"
                }`}
              >
                {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
                {!sizeOk && ` · over ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
              Title <span className="text-[var(--overview-fg)]/30 normal-case tracking-normal">(YouTube Shorts · required)</span>
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="YouTube video title — posted as-is"
              disabled={status === "running"}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
              Caption
            </label>
            <Textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Shown under the video on TikTok and used as the YouTube description"
              rows={3}
              disabled={status === "running"}
            />
            <p className="text-[11px] text-[var(--overview-fg)]/40">
              {caption.length} chars · TikTok truncates at 150 · YouTube uses full text as description
            </p>
          </div>

          {status !== "idle" && (
            <div
              className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                status === "success" && !youtubeError
                  ? "bg-[#8ca082]/10 text-[#8ca082]"
                  : status === "error"
                  ? "bg-red-500/10 text-red-400"
                  : status === "success" && youtubeError
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-white/[0.04] text-[var(--overview-fg)]/70"
              }`}
            >
              {status === "running" && <LoaderIcon className="size-3.5 mt-0.5 shrink-0 animate-spin" />}
              {status === "success" && !youtubeError && <CheckCircle2Icon className="size-3.5 mt-0.5 shrink-0" />}
              {status === "success" && youtubeError && <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />}
              {status === "error" && <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />}
              <div className="min-w-0 space-y-0.5">
                <p className="break-words">{message}</p>
                {tiktokBufferId && (
                  <p className="mt-0.5 font-mono text-[var(--overview-fg)]/60">
                    TikTok buffer id: {tiktokBufferId}
                  </p>
                )}
                {youtubeBufferId && (
                  <p className="font-mono text-[var(--overview-fg)]/60">
                    YouTube buffer id: {youtubeBufferId}
                  </p>
                )}
                {youtubeError && (
                  <p className="text-red-400 break-words">
                    YouTube failed: {youtubeError}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={status === "running"}
          >
            {status === "success" ? "Close" : "Cancel"}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            <UploadIcon className="size-3.5" />
            {status === "running" ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
