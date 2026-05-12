"use client";

/**
 * Inline form for TikTok manual upload (Pathway 3). Three-step flow:
 *
 *   1. Sign URL: POST /api/tiktok/manual-upload/sign-url → server mints a
 *      Supabase Storage signed upload URL scoped to a single object path.
 *   2. Direct PUT upload: the browser XHR-PUTs the mp4 straight to that
 *      signed URL. Single HTTP request, no Next.js involvement, progress
 *      tracked via xhr.upload.onprogress.
 *   3. Finalize: POST /api/tiktok/manual-upload with { storagePath, title,
 *      caption } → server signs a 7-day read URL and fans the video out
 *      to Buffer's TikTok / YouTube Shorts / LinkedIn queues.
 *
 * Why this isn't a single multipart POST anymore: the previous design
 * tried to stream the entire mp4 through our Next.js route on Render.
 * Render's proxy + undici's multipart parser couldn't sustain bodies
 * above ~90 MB ("Failed to parse body as FormData"). For 1–2 GB videos
 * the file must bypass our server entirely.
 *
 * Why single-PUT and not TUS resumable: tried TUS first; the token from
 * createSignedUploadUrl isn't honored by /storage/v1/upload/resumable
 * (RLS on storage.objects rejected the upload). createSignedUploadUrl's
 * signedUrl is designed for the single-PUT endpoint, which works
 * out-of-the-box with no RLS setup. Tradeoff: a network drop restarts
 * from byte zero — for 1–2 GB on a typical home connection (5–20 min
 * upload) this is acceptable; the signed URL TTL is plenty for retries.
 *
 * Lives on its own page (/tiktok/manual-upload). Title is required:
 * YouTube rejects video inserts without one. LinkedIn ignores it but
 * the row stores it for record-keeping.
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

// Hard ceiling matched to the server's MAX_UPLOAD_BYTES in
// /api/tiktok/manual-upload/sign-url. Client-side check is purely for
// UX — the server still rejects oversize requests with a 413.
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

type Phase =
  | "idle"
  | "signing"
  | "uploading"
  | "finalizing"
  | "success"
  | "error";

type SignUrlResponse = {
  storagePath: string;
  signedUrl: string;
};

type FinalizeResponse = {
  ok?: boolean;
  postId?: string;
  tiktokBufferId?: string;
  youtubeBufferId?: string;
  youtubeError?: string;
  linkedinBufferId?: string;
  linkedinError?: string;
  error?: string;
};

export function TikTokManualUploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [bytesTotal, setBytesTotal] = useState(0);
  const [tiktokBufferId, setTiktokBufferId] = useState<string | null>(null);
  const [youtubeBufferId, setYoutubeBufferId] = useState<string | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);
  const [linkedinBufferId, setLinkedinBufferId] = useState<string | null>(null);
  const [linkedinError, setLinkedinError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setTitle("");
    setCaption("");
    setPhase("idle");
    setMessage("");
    setBytesUploaded(0);
    setBytesTotal(0);
    setTiktokBufferId(null);
    setYoutubeBufferId(null);
    setYoutubeError(null);
    setLinkedinBufferId(null);
    setLinkedinError(null);
  }

  const sizeOk = !file || file.size <= MAX_FILE_BYTES;
  const busy =
    phase === "signing" || phase === "uploading" || phase === "finalizing";
  const canSubmit =
    !busy &&
    !!file &&
    sizeOk &&
    title.trim().length > 0 &&
    caption.trim().length > 0;

  /**
   * Wrap XMLHttpRequest's PUT in a Promise so the submit() flow can
   * await it. We use XHR (not fetch) because fetch can't report upload
   * progress in any browser — XHR's upload.onprogress is the only way
   * to drive a real progress bar for a multi-hundred-MB upload.
   *
   * The signedUrl is the complete URL returned by createSignedUploadUrl
   * server-side; it already encodes the bound token + path, so the
   * browser just PUTs the raw file bytes to it with the right
   * Content-Type. No auth header needed.
   */
  function runSignedPut(
    selectedFile: File,
    signedUrl: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signedUrl);
      xhr.setRequestHeader(
        "Content-Type",
        selectedFile.type || "video/mp4",
      );
      // x-upsert lets us retry the same path without a 409 if the user
      // re-submits the same form (path includes a uuid so collisions are
      // essentially impossible, but the header is harmless).
      xhr.setRequestHeader("x-upsert", "true");

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          setBytesUploaded(event.loaded);
          setBytesTotal(event.total);
        }
      };
      xhr.onload = () => {
        // Supabase Storage returns 200 on success. Anything else is an
        // error — surface the response body so the user can see what
        // happened (RLS, 413 size limit, etc.).
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(
            new Error(
              `Supabase returned ${xhr.status}: ${xhr.responseText || "no body"}`,
            ),
          );
        }
      };
      xhr.onerror = () => {
        // Network-level failure (DNS, connection drop). The signed URL
        // is still valid — user can hit Upload again to retry.
        reject(new Error("Network error during upload"));
      };
      xhr.onabort = () => {
        reject(new Error("Upload aborted"));
      };

      xhr.send(selectedFile);
    });
  }

  async function submit() {
    if (!file) return;

    setPhase("signing");
    setMessage("Requesting upload token…");
    setBytesUploaded(0);
    setBytesTotal(file.size);
    setTiktokBufferId(null);
    setYoutubeBufferId(null);
    setYoutubeError(null);
    setLinkedinBufferId(null);
    setLinkedinError(null);

    let signed: SignUrlResponse;
    try {
      const res = await fetch("/api/tiktok/manual-upload/sign-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "video/mp4",
          sizeBytes: file.size,
        }),
      });
      const json = (await res.json()) as
        | (SignUrlResponse & { error?: never })
        | { error: string };
      if (!res.ok || !("storagePath" in json)) {
        const err =
          "error" in json ? json.error : `Sign-url failed (${res.status})`;
        throw new Error(err);
      }
      signed = json;
    } catch (err) {
      setPhase("error");
      setMessage(`Failed to get upload token: ${(err as Error).message}`);
      return;
    }

    // Direct browser → Supabase Storage upload via single XHR PUT to the
    // signed URL.
    setPhase("uploading");
    setMessage("Uploading to Supabase Storage…");
    try {
      await runSignedPut(file, signed.signedUrl);
    } catch (err) {
      setPhase("error");
      setMessage(`Upload failed: ${(err as Error).message}`);
      return;
    }

    // Finalize: tell our server the upload is done; it signs a read URL
    // and runs the Buffer fan-out.
    setPhase("finalizing");
    setMessage("Queueing on Buffer…");
    try {
      const res = await fetch("/api/tiktok/manual-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: signed.storagePath,
          title,
          caption,
        }),
      });
      const data = (await res.json()) as FinalizeResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Finalize failed (${res.status})`);
      }
      setPhase("success");
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
      setPhase("error");
      setMessage(`Finalize failed: ${(err as Error).message}`);
    }
  }

  const anyFanoutError = !!(youtubeError || linkedinError);
  const progressPct =
    bytesTotal > 0 ? Math.min(100, (bytesUploaded / bytesTotal) * 100) : 0;
  const phaseLabel =
    phase === "signing"
      ? "Requesting upload token…"
      : phase === "uploading"
      ? "Uploading…"
      : phase === "finalizing"
      ? "Finalizing…"
      : phase === "success"
      ? "Done"
      : phase === "error"
      ? "Error"
      : "";

  return (
    <div className="max-w-xl space-y-5">
      {/* File picker — accept attribute filters the OS dialog to the
          formats Buffer can ingest. Must stay in sync with the
          ACCEPTED_VIDEO_TYPES whitelist in
          /api/tiktok/manual-upload/sign-url; the server is the
          authoritative gate, this is just OS-level UX. We also validate
          size client-side so the user gets immediate feedback rather
          than waiting for a 413 from the API. */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
          Video (mp4, mov, webm, m4v)
        </label>
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
          disabled={busy}
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
            {!sizeOk && ` · over ${MAX_FILE_BYTES / (1024 * 1024 * 1024)} GB limit`}
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
          disabled={busy}
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
          disabled={busy}
        />
        <p className="text-[11px] text-[var(--overview-fg)]/40">
          {caption.length} chars · TikTok truncates at 150 · LinkedIn at 3000 ·
          YouTube uses full text
        </p>
      </div>

      {/* Progress bar — only shown during the TUS upload phase, when
          bytesTotal is meaningful. Signing/finalizing are quick API
          calls so a spinner in the status panel is enough for those. */}
      {phase === "uploading" && bytesTotal > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-[var(--overview-fg)]/55">
            <span>Uploading to Supabase</span>
            <span className="font-mono">
              {(bytesUploaded / (1024 * 1024)).toFixed(1)} /{" "}
              {(bytesTotal / (1024 * 1024)).toFixed(1)} MB ·{" "}
              {progressPct.toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full bg-[#3b82f6] transition-[width] duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Status panel — phase-aware. Idle hides the panel. Success
          without errors is green; success-with-partial-failure is amber;
          error is red; signing/uploading/finalizing all share a neutral
          spinner state. */}
      {phase !== "idle" && (
        <div
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
            phase === "success" && !anyFanoutError
              ? "bg-[#8ca082]/10 text-[#8ca082]"
              : phase === "error"
              ? "bg-red-500/10 text-red-400"
              : phase === "success" && anyFanoutError
              ? "bg-amber-500/10 text-amber-400"
              : "bg-white/[0.04] text-[var(--overview-fg)]/70"
          }`}
        >
          {busy && (
            <LoaderIcon className="size-3.5 mt-0.5 shrink-0 animate-spin" />
          )}
          {phase === "success" && !anyFanoutError && (
            <CheckCircle2Icon className="size-3.5 mt-0.5 shrink-0" />
          )}
          {phase === "success" && anyFanoutError && (
            <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />
          )}
          {phase === "error" && (
            <XCircleIcon className="size-3.5 mt-0.5 shrink-0" />
          )}
          <div className="min-w-0 space-y-0.5">
            {busy && (
              <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--overview-fg)]/45">
                {phaseLabel}
              </p>
            )}
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

      {/* Footer actions. During upload/finalize: disabled Upload button
          (the user sees the progress bar + status panel). Post-success:
          a "Queue another" reset plus a back link. */}
      <div className="flex items-center gap-3 pt-1">
        {phase === "success" ? (
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
            {busy ? phaseLabel : "Upload"}
          </Button>
        )}
      </div>
    </div>
  );
}
