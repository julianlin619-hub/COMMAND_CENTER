"use client";

/**
 * Inline form for TikTok manual upload — file picker + title + caption,
 * POSTs to /api/tiktok/manual-upload, which fans the same mp4 out to
 * Buffer's TikTok + YouTube Shorts + LinkedIn queues.
 *
 * Lives on its own page (/tiktok/manual-upload) instead of in a dialog —
 * the pathway 3 card on /tiktok now navigates here. Keeping all the state
 * (file/title/caption) and the partial-success rendering local means we
 * don't need a parent to coordinate, and the page itself stays a server
 * component.
 *
 * Title is required: YouTube rejects video inserts without one. LinkedIn
 * ignores it but the row stores it for record-keeping.
 */

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  UploadIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
  ArrowLeftIcon,
} from "lucide-react";

const MAX_FILE_BYTES = 250 * 1024 * 1024;

type UploadStatus = "idle" | "running" | "success" | "error";

export function TikTokManualUploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const [tiktokBufferId, setTiktokBufferId] = useState<string | null>(null);
  const [youtubeBufferId, setYoutubeBufferId] = useState<string | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);
  const [linkedinBufferId, setLinkedinBufferId] = useState<string | null>(null);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCaption("");
    setStatus("idle");
    setMessage("");
    setTiktokBufferId(null);
    setYoutubeBufferId(null);
    setYoutubeError(null);
    setLinkedinBufferId(null);
    setLinkedinError(null);
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
    setLinkedinBufferId(null);
    setLinkedinError(null);
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
        linkedinBufferId?: string;
        linkedinError?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setStatus("success");
      setTiktokBufferId(data.tiktokBufferId ?? null);
      setYoutubeBufferId(data.youtubeBufferId ?? null);
      setYoutubeError(data.youtubeError ?? null);
      setLinkedinBufferId(data.linkedinBufferId ?? null);
      setLinkedinError(data.linkedinError ?? null);
      const anyError = !!(data.youtubeError || data.linkedinError);
      setMessage(
        anyError
          ? "TikTok queued, but at least one fan-out failed — see below."
          : "Video queued on Buffer's TikTok + YouTube Shorts + LinkedIn channels.",
      );
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    }
  }

  const anyFanoutError = !!(youtubeError || linkedinError);

  return (
    <div className="max-w-xl space-y-5">
      {/* File picker — accept attribute restricts to mp4 in the OS dialog,
          but we still validate the size client-side so the user gets
          immediate feedback rather than waiting for a 413 from the API. */}
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
              sizeOk ? "text-[var(--overview-fg)]/50" : "text-red-400"
            }`}
          >
            {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
            {!sizeOk && ` · over ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`}
          </p>
        )}
      </div>

      {/* Title is required because YouTube's videos.insert rejects empty
          titles. LinkedIn ignores it — but we still store it on the
          LinkedIn posts row for parity. */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
          Title{" "}
          <span className="text-[var(--overview-fg)]/30 normal-case tracking-normal">
            (YouTube Shorts · required)
          </span>
        </label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="YouTube video title — posted as-is"
          disabled={status === "running"}
        />
      </div>

      {/* Caption is shared across all three platforms. The API truncates
          per-platform when it builds each Buffer payload — the live char
          count below is just informational so the user can tell whether
          TikTok will cut things off. */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
          Caption
        </label>
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="TikTok caption · YouTube description · LinkedIn post body"
          rows={4}
          disabled={status === "running"}
        />
        <p className="text-[11px] text-[var(--overview-fg)]/40">
          {caption.length} chars · TikTok truncates at 150 · LinkedIn at 3000 ·
          YouTube uses full text
        </p>
      </div>

      {/* Status panel — same idle/running/success/error states the dialog
          version had. Success-with-fan-out-error gets its own amber tone
          so it doesn't read as a clean "all good" pass. */}
      {status !== "idle" && (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
            status === "success" && !anyFanoutError
              ? "bg-[#8ca082]/10 text-[#8ca082]"
              : status === "error"
              ? "bg-red-500/10 text-red-400"
              : status === "success" && anyFanoutError
              ? "bg-amber-500/10 text-amber-400"
              : "bg-white/[0.04] text-[var(--overview-fg)]/70"
          }`}
        >
          {status === "running" && (
            <LoaderIcon className="size-3.5 mt-0.5 shrink-0 animate-spin" />
          )}
          {status === "success" && !anyFanoutError && (
            <CheckCircle2Icon className="size-3.5 mt-0.5 shrink-0" />
          )}
          {status === "success" && anyFanoutError && (
            <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />
          )}
          {status === "error" && (
            <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />
          )}
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
            {linkedinBufferId && (
              <p className="font-mono text-[var(--overview-fg)]/60">
                LinkedIn buffer id: {linkedinBufferId}
              </p>
            )}
            {linkedinError && (
              <p className="text-red-400 break-words">
                LinkedIn failed: {linkedinError}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Footer actions. Pre-success: just an Upload button (the form is
          the whole page, so there's no Cancel — the back link in the page
          header serves that role). Post-success: a "Queue another" reset
          plus a back link, so the user doesn't have to navigate away to
          submit a second video. */}
      <div className="flex items-center gap-3 pt-1">
        {status === "success" ? (
          <>
            <Button onClick={reset} className="gap-1.5">
              <UploadIcon className="size-3.5" />
              Queue another
            </Button>
            <Link
              href="/tiktok"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeftIcon className="size-3.5" />
              Back to TikTok
            </Link>
          </>
        ) : (
          <Button onClick={submit} disabled={!canSubmit} className="gap-1.5">
            <UploadIcon className="size-3.5" />
            {status === "running" ? "Uploading…" : "Upload"}
          </Button>
        )}
      </div>
    </div>
  );
}
