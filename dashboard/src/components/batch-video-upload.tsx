"use client";

/**
 * Batch video upload (auto title + caption).
 *
 * Drag a folder's worth of mp4s onto the drop zone (or pick them) and each one
 * is uploaded to Supabase Storage and then auto-scheduled: the server extracts
 * the audio, transcribes it, generates a YouTube-style title, and picks a
 * caption by matching the transcript against the tweet bank — then fans the
 * video out to Buffer for TikTok + YouTube Shorts + X. No title/caption fields:
 * that's the whole point of this pathway.
 *
 * Per-file flow (each file runs independently, concurrently):
 *   1. signing     — POST /api/tiktok/manual-upload/sign-url
 *   2. uploading   — single PUT of the file bytes to the signed URL (progress)
 *   3. processing  — POST /api/tiktok/manual-upload/batch, which spawns the
 *                    Python processor and waits for it (transcribe → title →
 *                    caption → Buffer fan-out). This is the slow phase.
 *   4. success/failed
 *
 * Sibling of tiktok-upload-queue.tsx (the manual title+caption pathway); the
 * sign-url + PUT mechanics mirror it.
 */

import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  UploadCloudIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
  XIcon,
} from "lucide-react";

// Mirror the server allow-list (sign-url/route.ts) and the 2 GB ceiling.
const ACCEPT_VIDEO_TYPES = "video/mp4,video/quicktime,video/webm,video/x-m4v";
const ACCEPTED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SLOTS = 30;

type BatchPhase = "signing" | "uploading" | "processing" | "success" | "failed";

type SignUrlResponse = { storagePath: string; signedUrl: string };

type BatchResult = {
  ok?: boolean;
  status?: string;
  title?: string;
  caption?: string;
  tiktok_buffer_id?: string;
  youtube_buffer_id?: string;
  youtube_error?: string;
  x_buffer_id?: string;
  x_error?: string;
  error?: string;
};

type BatchSlot = {
  id: string;
  filename: string;
  fileSize: number;
  phase: BatchPhase;
  bytesUploaded: number;
  bytesTotal: number;
  message: string;
  title?: string;
  caption?: string;
  tiktokBufferId?: string;
  youtubeBufferId?: string;
  youtubeError?: string;
  xBufferId?: string;
  xError?: string;
};

const IN_FLIGHT: ReadonlySet<BatchPhase> = new Set([
  "signing",
  "uploading",
  "processing",
]);

/** PUT the file bytes to a Supabase signed upload URL, reporting progress. */
function signedPut(
  file: File,
  signed: SignUrlResponse,
  onProgress: (uploaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signed.signedUrl);
    xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Supabase returned ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export function BatchVideoUpload() {
  const [slots, setSlots] = useState<BatchSlot[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateSlot = useCallback((id: string, patch: Partial<BatchSlot>) => {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** Run the full sign → upload → process chain for one file. */
  const processFile = useCallback(
    async (id: string, file: File) => {
      try {
        // --- Phase 1: sign-url ---
        const signRes = await fetch("/api/tiktok/manual-upload/sign-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "video/mp4",
            sizeBytes: file.size,
          }),
        });
        const signJson = (await signRes.json()) as
          | (SignUrlResponse & { error?: never })
          | { error: string };
        if (!signRes.ok || !("storagePath" in signJson)) {
          throw new Error(
            "error" in signJson ? signJson.error : `Sign-url failed (${signRes.status})`,
          );
        }

        // --- Phase 2: upload ---
        updateSlot(id, { phase: "uploading", message: "Uploading…" });
        await signedPut(file, signJson, (uploaded, total) =>
          updateSlot(id, { bytesUploaded: uploaded, bytesTotal: total }),
        );

        // --- Phase 3: process (transcribe → title → caption → Buffer) ---
        updateSlot(id, {
          phase: "processing",
          message: "Transcribing & generating title + caption…",
        });
        const procRes = await fetch("/api/tiktok/manual-upload/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storagePath: signJson.storagePath }),
        });
        const data = (await procRes.json()) as BatchResult;
        if (!procRes.ok || !data.ok) {
          throw new Error(data.error ?? `Processing failed (${procRes.status})`);
        }

        const anyError = !!(data.youtube_error || data.x_error);
        updateSlot(id, {
          phase: "success",
          title: data.title,
          caption: data.caption,
          tiktokBufferId: data.tiktok_buffer_id,
          youtubeBufferId: data.youtube_buffer_id,
          youtubeError: data.youtube_error,
          xBufferId: data.x_buffer_id,
          xError: data.x_error,
          message: anyError
            ? "Scheduled, but one platform failed to queue."
            : "Scheduled.",
        });
      } catch (err) {
        updateSlot(id, {
          phase: "failed",
          message: (err as Error).message,
        });
      }
    },
    [updateSlot],
  );

  /** Validate + enqueue a list of files, kicking off processing for each. */
  const addFiles = useCallback(
    (files: File[]) => {
      setSlots((prev) => {
        let room = MAX_SLOTS - prev.length;
        const newSlots: BatchSlot[] = [];
        for (const file of files) {
          if (room <= 0) break;
          // Skip non-video / oversize files with a visible failed slot so the
          // user knows they were rejected rather than silently dropped.
          const badType = !ACCEPTED_TYPES.has(file.type);
          const tooBig = file.size > MAX_FILE_BYTES;
          const id = crypto.randomUUID();
          const base: BatchSlot = {
            id,
            filename: file.name,
            fileSize: file.size,
            phase: badType || tooBig ? "failed" : "signing",
            bytesUploaded: 0,
            bytesTotal: file.size,
            message: badType
              ? "Unsupported format (mp4 / mov / webm / m4v only)."
              : tooBig
                ? `Over ${MAX_FILE_BYTES / (1024 * 1024 * 1024)} GB limit.`
                : "Requesting upload token…",
          };
          newSlots.push(base);
          room--;
          if (!badType && !tooBig) void processFile(id, file);
        }
        return [...newSlots, ...prev];
      });
    },
    [processFile],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const onPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files ?? []));
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [addFiles],
  );

  const dismissSlot = useCallback((id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const queueFull = slots.length >= MAX_SLOTS;

  return (
    <div className="max-w-xl space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
          dragging
            ? "border-[#3b82f6] bg-[#3b82f6]/10"
            : "border-white/[0.12] bg-white/[0.02] hover:bg-white/[0.04]"
        } ${queueFull ? "pointer-events-none opacity-50" : ""}`}
      >
        <UploadCloudIcon className="size-6 text-[var(--overview-fg)]/50" />
        <p className="text-sm text-[var(--overview-fg)]/80">
          Drag a batch of videos here, or click to choose
        </p>
        <p className="text-[11px] text-[var(--overview-fg)]/40">
          mp4 / mov / webm / m4v · up to 2 GB each · title &amp; caption
          generated automatically
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_VIDEO_TYPES}
          onChange={onPick}
          className="hidden"
        />
      </div>

      {queueFull && (
        <p className="text-xs text-amber-400">
          Queue full — dismiss a finished item to add more.
        </p>
      )}

      {/* Slot stack */}
      {slots.length > 0 && (
        <div className="space-y-2">
          {slots.map((slot) => (
            <BatchSlotTab
              key={slot.id}
              slot={slot}
              onDismiss={() => dismissSlot(slot.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BatchSlotTab({
  slot,
  onDismiss,
}: {
  slot: BatchSlot;
  onDismiss: () => void;
}) {
  const inFlight = IN_FLIGHT.has(slot.phase);
  const anyFanoutError = !!(slot.youtubeError || slot.xError);

  const containerClasses =
    slot.phase === "success" && !anyFanoutError
      ? "bg-[#8ca082]/10 border-[#8ca082]/20"
      : slot.phase === "success" && anyFanoutError
        ? "bg-amber-500/10 border-amber-500/20"
        : slot.phase === "failed"
          ? "bg-red-500/10 border-red-500/20"
          : "bg-white/[0.04] border-white/[0.06]";

  const progressPct =
    slot.bytesTotal > 0
      ? Math.min(100, (slot.bytesUploaded / slot.bytesTotal) * 100)
      : 0;

  const phaseLabel =
    slot.phase === "signing"
      ? "Signing…"
      : slot.phase === "uploading"
        ? `Uploading ${progressPct.toFixed(0)}%`
        : slot.phase === "processing"
          ? "Generating…"
          : slot.phase === "success"
            ? anyFanoutError
              ? "Scheduled · partial"
              : "Scheduled"
            : "Failed";

  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${containerClasses}`}>
      <div className="flex items-center gap-2">
        {inFlight && (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-[var(--overview-fg)]/70" />
        )}
        {slot.phase === "success" && !anyFanoutError && (
          <CheckCircle2Icon className="size-3.5 shrink-0 text-[#8ca082]" />
        )}
        {slot.phase === "success" && anyFanoutError && (
          <XCircleIcon className="size-3.5 shrink-0 text-amber-400" />
        )}
        {slot.phase === "failed" && (
          <XCircleIcon className="size-3.5 shrink-0 text-red-400" />
        )}

        <div className="min-w-0 flex-1">
          <p
            className="truncate font-medium text-[var(--overview-fg)]/85"
            title={slot.filename}
          >
            {slot.filename}
          </p>
          <p className="text-[10px] text-[var(--overview-fg)]/40">
            {(slot.fileSize / (1024 * 1024)).toFixed(1)} MB · {phaseLabel}
          </p>
        </div>

        {!inFlight && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 text-[var(--overview-fg)]/50 hover:text-[var(--overview-fg)]"
          >
            <XIcon />
          </Button>
        )}
      </div>

      {slot.phase === "uploading" && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full bg-[#3b82f6] transition-[width] duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {slot.phase === "failed" && slot.message && (
        <p className="mt-1 break-words text-[11px] text-red-400">{slot.message}</p>
      )}

      {/* On success: show the generated title + caption and buffer badges. */}
      {slot.phase === "success" && (
        <div className="mt-1.5 space-y-1">
          {slot.title && (
            <p className="text-[11px] text-[var(--overview-fg)]/80">
              <span className="text-[var(--overview-fg)]/40">Title:</span>{" "}
              {slot.title}
            </p>
          )}
          {slot.caption && (
            <p className="break-words text-[11px] text-[var(--overview-fg)]/70">
              <span className="text-[var(--overview-fg)]/40">Caption:</span>{" "}
              {slot.caption}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-[var(--overview-fg)]/60">
            {slot.tiktokBufferId && <span>TT: {slot.tiktokBufferId}</span>}
            {slot.youtubeBufferId && <span>YT: {slot.youtubeBufferId}</span>}
            {slot.xBufferId && <span>X: {slot.xBufferId}</span>}
            {slot.youtubeError && (
              <span className="break-words text-red-400">
                YT failed: {slot.youtubeError}
              </span>
            )}
            {slot.xError && (
              <span className="break-words text-red-400">
                X failed: {slot.xError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
