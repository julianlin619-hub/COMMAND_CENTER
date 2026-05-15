"use client";

/**
 * Queue-style TikTok manual upload (Pathway 3, batch mode).
 *
 * Why this exists: the previous single-form variant forced the user to
 * wait for each 3-phase upload (sign-url -> PUT -> finalize) to finish
 * before queueing the next one. For batches of 1-2 GB videos that was
 * painful, so we stamp the same flow N times in parallel.
 *
 * Architecture:
 *
 *   - One persistent compose form at the bottom (file + title + caption +
 *     Upload). Clicking Upload moves the field snapshot into a new
 *     "slot" rendered as a minimized tab above the form, then resets
 *     the form so the user can immediately compose the next upload.
 *   - Each slot fires its own sign-url -> single-PUT -> finalize chain
 *     independently. No global queue/throttle — HTTP/2 + browser
 *     connection limits already cap real parallelism. We cap the
 *     visible slot count at MAX_SLOTS so the UI doesn't get unbounded.
 *   - Slot state lives in React (so the UI re-renders on phase /
 *     progress changes). Non-serializable handles (XMLHttpRequest,
 *     AbortController) live in a useRef Map keyed by slot id — putting
 *     them in state would churn refs on every render.
 *   - Cancellation:
 *       signing    -> AbortController on the sign-url fetch
 *       uploading  -> xhr.abort() — leaves a partial (or empty)
 *                     object behind in Storage. The existing cleanup
 *                     cron won't sweep it because no posts row ever
 *                     referenced it. Accepted as a known minor leak;
 *                     see TODO in cancelSlot.
 *       finalizing -> AbortController on the finalize fetch. Buffer
 *                     may have already accepted the TikTok post by the
 *                     time the abort lands, so we surface a
 *                     "Buffer state unknown" message rather than
 *                     pretending we know the outcome.
 *   - No persistence: navigating away kills in-flight uploads. A
 *     beforeunload handler nags the user when any slot is non-terminal.
 *
 * Backend endpoints (unchanged from the single-form variant):
 *   POST /api/tiktok/manual-upload/sign-url  -> { storagePath, signedUrl }
 *   POST /api/tiktok/manual-upload           -> finalize + Buffer fan-out
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  UploadIcon,
  LoaderIcon,
  CheckCircle2Icon,
  XCircleIcon,
  XIcon,
  ArrowLeftIcon,
} from "lucide-react";

// Hard ceiling matched to the server's MAX_UPLOAD_BYTES in
// /api/tiktok/manual-upload/sign-url. Client-side check is purely for
// UX — the server still rejects oversize requests with a 413.
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

// File picker accept list. Mirrors the server-side allow-list in
// sign-url/route.ts so the OS dialog filters out files the server
// would reject anyway. mp4 / mov / webm / m4v are what Buffer's
// TikTok / YouTube Shorts / LinkedIn endpoints ingest.
const ACCEPT_VIDEO_TYPES = "video/mp4,video/quicktime,video/webm,video/x-m4v";

// Max simultaneous slots in the stack (any phase). When the stack hits
// this, the compose form's Upload button disables and we render an
// inline hint asking the user to dismiss a finished slot. Dismissing a
// slot immediately frees a spot.
const MAX_SLOTS = 30;

type SlotPhase =
  | "signing"
  | "uploading"
  | "finalizing"
  | "success"
  | "failed"
  | "cancelled";

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
  xBufferId?: string;
  xError?: string;
  error?: string;
};

type UploadSlot = {
  id: string;
  filename: string;
  fileSize: number;
  phase: SlotPhase;
  bytesUploaded: number;
  bytesTotal: number;
  message: string;
  tiktokBufferId?: string;
  youtubeBufferId?: string;
  youtubeError?: string;
  linkedinBufferId?: string;
  linkedinError?: string;
  xBufferId?: string;
  xError?: string;
};

type SlotRefs = {
  xhr?: XMLHttpRequest;
  signAbort?: AbortController;
  finalizeAbort?: AbortController;
  // Synchronous cancel flag. Mutated by cancelSlot, read by the async
  // flow in startUpload. We can't rely on reading the React state's
  // phase here because React batches state commits and passive
  // effects (useEffect) run after paint — by the time we'd see
  // phase === "cancelled" in slots, the microtask from the aborted
  // fetch would have already run and overwritten the slot back to
  // "failed". A ref mutation is synchronous and race-free.
  cancelled?: boolean;
};

// Phases where the user can still interrupt the upload. Used both to
// decide which button (Cancel vs Dismiss) to show and to fire the
// beforeunload warning.
const IN_FLIGHT_PHASES: ReadonlySet<SlotPhase> = new Set([
  "signing",
  "uploading",
  "finalizing",
]);

/**
 * Wrap a single PUT to a Supabase-signed upload URL in a Promise so the
 * per-slot async flow can await it. Returns the XHR synchronously
 * (alongside the Promise) so the queue can stash it and abort on
 * cancel — fetch() can't drive upload-progress events, so XHR is the
 * only option for a real progress bar.
 *
 * signed.signedUrl is fully formed by createSignedUploadUrl server-side
 * — token is embedded in the query string. The browser just PUTs the
 * raw file bytes, no auth headers needed.
 */
function startSignedPut(
  file: File,
  signed: SignUrlResponse,
  onProgress: (uploaded: number, total: number) => void,
): { xhr: XMLHttpRequest; done: Promise<void> } {
  let resolve: () => void;
  let reject: (err: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const xhr = new XMLHttpRequest();
  xhr.open("PUT", signed.signedUrl);
  xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
  // x-upsert lets us retry the same path without a 409 if the user
  // re-submits. The path includes a uuid so collisions are essentially
  // impossible, but the header is harmless.
  xhr.setRequestHeader("x-upsert", "true");

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      onProgress(event.loaded, event.total);
    }
  };
  xhr.onload = () => {
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
    // Network-level failure (DNS, connection drop). The signed URL is
    // still valid — user could retry via dismiss + re-add.
    reject(new Error("Network error during upload"));
  };
  xhr.onabort = () => {
    // cancelSlot called xhr.abort(). The catch block in startUpload
    // checks the cancelled flag and bails silently in that case.
    reject(new Error("Upload aborted"));
  };

  xhr.send(file);
  return { xhr, done };
}

export function TikTokUploadQueue() {
  // The stack itself, newest first. Every mutation flows through
  // setSlots(prev => prev.map(...) | filter(...) | [new, ...prev]).
  const [slots, setSlots] = useState<UploadSlot[]>([]);

  // Compose form state. The active File / strings live in component
  // state until the user clicks Upload, at which point the snapshot is
  // captured in the startUpload closure and the form resets.
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");

  // Ref to the file input so we can clear .value on submit. React's
  // controlled-input pattern doesn't work for <input type="file"> for
  // security reasons (you can only clear, not set, the value), so we
  // poke the DOM directly here.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Map of non-serializable per-slot handles. Keyed by slot id. We
  // delete entries when a slot reaches a terminal state (or gets
  // dismissed) so we don't accumulate cruft over a long session.
  const slotRefs = useRef<Map<string, SlotRefs>>(new Map());

  // Helper: patch a single slot in place. Used everywhere we transition
  // phase / update progress / record buffer IDs.
  const updateSlot = useCallback(
    (id: string, patch: Partial<UploadSlot>) => {
      setSlots((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  // Synchronous cancellation check. Used by startUpload's catch blocks
  // to skip overwriting a slot that the user just cancelled. The
  // alternative (reading phase from a slots ref) would race against
  // React's commit timing.
  const isCancelled = useCallback((id: string): boolean => {
    return slotRefs.current.get(id)?.cancelled === true;
  }, []);

  /**
   * The per-slot upload pipeline. Mirrors the original single-form
   * submit() exactly, but scoped to one slot id. Called fire-and-forget
   * from onUploadClick — slots run concurrently.
   *
   * Structure: an outer try / finally guarantees the slotRefs entry is
   * cleaned up on every exit path (success, failure, cancel, thrown
   * error). Each phase's inner catch only deals with state transitions,
   * not cleanup — that's the finally's job.
   *
   * Cancelled uploads leave a partial Storage object behind (no posts
   * row gets written, so the cleanup cron's group path can't see it).
   * Those are reaped by the orphan-sweep branch in
   * cron/tiktok_storage_cleanup.py (_cleanup_orphans), which runs
   * daily at 03:00 UTC and deletes unreferenced objects older than
   * 24h. Worst case: a cancelled upload's bytes linger for up to one
   * extra day before sweep.
   */
  const startUpload = useCallback(
    async (
      slotId: string,
      slotFile: File,
      slotTitle: string,
      slotCaption: string,
    ) => {
      const refs: SlotRefs = {};
      slotRefs.current.set(slotId, refs);

      try {
        // --- Phase 1: sign-url ---
        const signAbort = new AbortController();
        refs.signAbort = signAbort;

        let signed: SignUrlResponse;
        try {
          const res = await fetch("/api/tiktok/manual-upload/sign-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: slotFile.name,
              contentType: slotFile.type || "video/mp4",
              sizeBytes: slotFile.size,
            }),
            signal: signAbort.signal,
          });
          const json = (await res.json()) as
            | (SignUrlResponse & { error?: never })
            | { error: string };
          if (!res.ok || !("storagePath" in json)) {
            const err =
              "error" in json
                ? json.error
                : `Sign-url failed (${res.status})`;
            throw new Error(err);
          }
          signed = json;
        } catch (err) {
          // AbortError means cancelSlot already moved the slot to
          // "cancelled" — leave it alone. Otherwise mark failed.
          if (!isCancelled(slotId)) {
            updateSlot(slotId, {
              phase: "failed",
              message: `Failed to get upload token: ${(err as Error).message}`,
            });
          }
          return;
        }

        // --- Phase 2: single-PUT upload ---
        updateSlot(slotId, {
          phase: "uploading",
          message: "Uploading to Supabase Storage…",
        });

        const { xhr, done } = startSignedPut(
          slotFile,
          signed,
          (uploaded, total) => {
            updateSlot(slotId, {
              bytesUploaded: uploaded,
              bytesTotal: total,
            });
          },
        );
        refs.xhr = xhr;

        try {
          await done;
        } catch (err) {
          // xhr.abort() rejected via onabort -> "cancelled" already
          // set by cancelSlot. Otherwise this is a real network /
          // Supabase failure.
          if (!isCancelled(slotId)) {
            updateSlot(slotId, {
              phase: "failed",
              message: `Upload failed: ${(err as Error).message}`,
            });
          }
          return;
        }

        // --- Phase 3: finalize ---
        const finalizeAbort = new AbortController();
        refs.finalizeAbort = finalizeAbort;
        updateSlot(slotId, {
          phase: "finalizing",
          message: "Queueing on Buffer…",
        });

        try {
          const res = await fetch("/api/tiktok/manual-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storagePath: signed.storagePath,
              title: slotTitle,
              caption: slotCaption,
            }),
            signal: finalizeAbort.signal,
          });
          const data = (await res.json()) as FinalizeResponse;
          if (!res.ok || !data.ok) {
            throw new Error(data.error ?? `Finalize failed (${res.status})`);
          }
          // DB-dedup bookkeeping is swallowed in the route on every
          // fan-out leg — by the time we get here, *Error fields only
          // carry genuine Buffer-side failures (e.g. Buffer rejected
          // the post, channel not connected). So anyError here means
          // at least one platform genuinely didn't queue.
          const anyError = !!(
            data.youtubeError || data.linkedinError || data.xError
          );
          updateSlot(slotId, {
            phase: "success",
            tiktokBufferId: data.tiktokBufferId,
            youtubeBufferId: data.youtubeBufferId,
            youtubeError: data.youtubeError,
            linkedinBufferId: data.linkedinBufferId,
            linkedinError: data.linkedinError,
            xBufferId: data.xBufferId,
            xError: data.xError,
            message: anyError
              ? "Uploaded, but one platform failed to queue."
              : "Uploaded successfully.",
          });
        } catch (err) {
          // Caveat on cancel-during-finalize: Buffer may have queued
          // the TikTok post before the abort landed. We don't try to
          // reconcile — the "Buffer state unknown" message that
          // cancelSlot set tells the user to check manually.
          if (!isCancelled(slotId)) {
            updateSlot(slotId, {
              phase: "failed",
              message: `Finalize failed: ${(err as Error).message}`,
            });
          }
        }
      } finally {
        // Single cleanup site for every exit path. Even an unhandled
        // throw above (which would propagate to the fire-and-forget
        // void) clears the ref entry.
        slotRefs.current.delete(slotId);
      }
    },
    [isCancelled, updateSlot],
  );

  /**
   * User clicked Upload on the compose form. Snapshot the fields into a
   * new slot, reset the form, and kick off the upload fire-and-forget.
   */
  const onUploadClick = useCallback(() => {
    if (!file) return;
    if (slots.length >= MAX_SLOTS) return;
    if (file.size > MAX_FILE_BYTES) return;
    if (!title.trim() || !caption.trim()) return;

    const id = crypto.randomUUID();

    const newSlot: UploadSlot = {
      id,
      filename: file.name,
      fileSize: file.size,
      phase: "signing",
      bytesUploaded: 0,
      bytesTotal: file.size,
      message: "Requesting upload token…",
    };

    // Capture the field values before clearing the form — startUpload
    // is async and the state would be empty by the time it ran.
    const snapshotFile = file;
    const snapshotTitle = title;
    const snapshotCaption = caption;

    setSlots((prev) => [newSlot, ...prev]);

    // Reset the compose form. The file input has to be cleared via DOM
    // because <input type="file"> can't be set programmatically.
    setFile(null);
    setTitle("");
    setCaption("");
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Fire-and-forget. Errors are recorded on the slot, not thrown.
    void startUpload(id, snapshotFile, snapshotTitle, snapshotCaption);
  }, [file, title, caption, slots.length, startUpload]);

  /**
   * Cancel an in-flight slot. We pass the current phase in from the
   * click handler (the SlotTab knows its own slot) so we don't have to
   * round-trip through React state to find it. The synchronous
   * `refs.cancelled = true` is what the async flow checks before
   * overwriting state on rejection.
   */
  const cancelSlot = useCallback(
    (id: string, phase: SlotPhase) => {
      const refs = slotRefs.current.get(id);
      if (!refs) return;

      // Set this BEFORE calling abort() so the rejection microtask
      // sees the flag.
      refs.cancelled = true;

      if (phase === "signing") {
        refs.signAbort?.abort();
        updateSlot(id, { phase: "cancelled", message: "Cancelled." });
      } else if (phase === "uploading") {
        // xhr.abort() fires xhr.onabort which rejects the Promise in
        // startSignedPut. The catch block in startUpload sees the
        // cancelled flag and bails without overwriting state.
        refs.xhr?.abort();
        updateSlot(id, {
          phase: "cancelled",
          message: "Cancelled — partial upload left in Storage.",
        });
      } else if (phase === "finalizing") {
        refs.finalizeAbort?.abort();
        updateSlot(id, {
          phase: "cancelled",
          message:
            "Cancelled — Buffer state unknown, check the TikTok page.",
        });
      }
      // Terminal phases: noop — the action button is already Dismiss.
    },
    [updateSlot],
  );

  const dismissSlot = useCallback((id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    slotRefs.current.delete(id);
  }, []);

  // beforeunload nag — fires when the user tries to navigate away with
  // any slot still in-flight. Modern browsers ignore the returned
  // string and show their own generic message, but setting returnValue
  // is what actually triggers the dialog.
  useEffect(() => {
    const anyInFlight = slots.some((s) => IN_FLIGHT_PHASES.has(s.phase));
    if (!anyInFlight) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [slots]);

  const queueFull = slots.length >= MAX_SLOTS;
  const fileSizeOk = !file || file.size <= MAX_FILE_BYTES;
  const canSubmit =
    !!file &&
    fileSizeOk &&
    title.trim().length > 0 &&
    caption.trim().length > 0 &&
    !queueFull;

  return (
    <div className="max-w-xl space-y-4">
      {/* Slot stack — newest on top, growing downward as more are
          added. Hidden entirely when empty so the compose form isn't
          floating below a "(no uploads)" placeholder. */}
      {slots.length > 0 && (
        <div className="space-y-2">
          {slots.map((slot) => (
            <SlotTab
              key={slot.id}
              slot={slot}
              onCancel={() => cancelSlot(slot.id, slot.phase)}
              onDismiss={() => dismissSlot(slot.id)}
            />
          ))}
        </div>
      )}

      {/* Compose form — file picker + title + caption + Upload. Same
          fields and styling as the previous single-form variant; the
          only difference is the Upload button now hands off to the
          queue instead of running inline. */}
      <div className="space-y-5 pt-2">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
            Video (mp4 / mov / webm / m4v)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_VIDEO_TYPES}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setFile(e.target.files?.[0] ?? null)
            }
            className="block w-full text-sm text-[var(--overview-fg)]/80 file:mr-3 file:rounded-md file:border-0 file:bg-white/[0.06] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--overview-fg)] hover:file:bg-white/[0.1]"
          />
          {file && (
            <p
              className={`text-xs ${
                fileSizeOk
                  ? "text-[var(--overview-fg)]/50"
                  : "text-red-400"
              }`}
            >
              {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              {!fileSizeOk &&
                ` · over ${MAX_FILE_BYTES / (1024 * 1024 * 1024)} GB limit`}
            </p>
          )}
        </div>

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
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/55">
            Caption
          </label>
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="TikTok caption · YouTube description · LinkedIn post body"
            rows={4}
          />
          <p className="text-[11px] text-[var(--overview-fg)]/40">
            {caption.length} chars · TikTok truncates at 150 · LinkedIn at
            3000 · YouTube uses full text
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            onClick={onUploadClick}
            disabled={!canSubmit}
            className="gap-1.5"
          >
            <UploadIcon className="size-3.5" />
            Upload
          </Button>
          {queueFull && (
            <p className="text-xs text-amber-400">
              Queue full — dismiss a finished upload to add more.
            </p>
          )}
          <Link
            href="/"
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back to Overview
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * One row in the slot stack. Compact card with phase icon, filename,
 * phase label, and a Cancel/Dismiss button. Adds a progress bar row
 * during the upload phase and an inline buffer-ID badge row after
 * success.
 *
 * Kept inline in this file rather than its own file because it's
 * tightly coupled to the slot shape and not reused anywhere else. If
 * it grows past ~150 LOC, split it out.
 */
function SlotTab({
  slot,
  onCancel,
  onDismiss,
}: {
  slot: UploadSlot;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const inFlight = IN_FLIGHT_PHASES.has(slot.phase);
  const anyFanoutError = !!(
    slot.youtubeError || slot.linkedinError || slot.xError
  );

  // Phase-driven background. Mirrors the colors the old single-form
  // status panel used so the visual language stays consistent.
  const containerClasses =
    slot.phase === "success" && !anyFanoutError
      ? "bg-[#8ca082]/10 border-[#8ca082]/20"
      : slot.phase === "success" && anyFanoutError
      ? "bg-amber-500/10 border-amber-500/20"
      : slot.phase === "failed" || slot.phase === "cancelled"
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
      ? `Uploading ${progressPct.toFixed(1)}% · ${(
          slot.bytesUploaded /
          (1024 * 1024)
        ).toFixed(0)}/${(slot.bytesTotal / (1024 * 1024)).toFixed(0)} MB`
      : slot.phase === "finalizing"
      ? "Finalizing…"
      : slot.phase === "success"
      ? anyFanoutError
        ? "Done · partial"
        : "Done"
      : slot.phase === "failed"
      ? "Failed"
      : "Cancelled";

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${containerClasses}`}
    >
      <div className="flex items-center gap-2">
        {/* Phase icon */}
        {inFlight && (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-[var(--overview-fg)]/70" />
        )}
        {slot.phase === "success" && !anyFanoutError && (
          <CheckCircle2Icon className="size-3.5 shrink-0 text-[#8ca082]" />
        )}
        {slot.phase === "success" && anyFanoutError && (
          <XCircleIcon className="size-3.5 shrink-0 text-amber-400" />
        )}
        {(slot.phase === "failed" || slot.phase === "cancelled") && (
          <XCircleIcon className="size-3.5 shrink-0 text-red-400" />
        )}

        {/* Filename + size — truncated, full filename in tooltip. */}
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

        {/* Cancel (while in-flight) or Dismiss (when terminal). Same
            visual — an X icon button — but different aria-label so
            screen readers get the right verb. */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={inFlight ? onCancel : onDismiss}
          aria-label={inFlight ? "Cancel upload" : "Dismiss"}
          className="shrink-0 text-[var(--overview-fg)]/50 hover:text-[var(--overview-fg)]"
        >
          <XIcon />
        </Button>
      </div>

      {/* Slim progress bar during the upload phase. Hidden otherwise:
          the signing and finalizing phases are quick API calls where a
          spinner in the row label is enough. */}
      {slot.phase === "uploading" && (
        <div className="mt-1.5 h-1 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full bg-[#3b82f6] transition-[width] duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* Failure / cancellation message line. We render the slot's
          message text below the row so it can wrap on long error
          strings without breaking the compact header layout. */}
      {(slot.phase === "failed" || slot.phase === "cancelled") &&
        slot.message && (
          <p className="mt-1 text-[11px] text-red-400 break-words">
            {slot.message}
          </p>
        )}

      {/* On success: compact badges for buffer IDs and any partial
          fan-out errors. Same partial-success contract the original
          form rendered, just laid out horizontally instead of
          stacked. */}
      {slot.phase === "success" && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono text-[var(--overview-fg)]/60">
          {slot.tiktokBufferId && (
            <span>TT: {slot.tiktokBufferId}</span>
          )}
          {slot.youtubeBufferId && (
            <span>YT: {slot.youtubeBufferId}</span>
          )}
          {slot.linkedinBufferId && (
            <span>LI: {slot.linkedinBufferId}</span>
          )}
          {slot.xBufferId && (
            <span>X: {slot.xBufferId}</span>
          )}
          {slot.youtubeError && (
            <span className="text-red-400 break-words">
              YT failed: {slot.youtubeError}
            </span>
          )}
          {slot.linkedinError && (
            <span className="text-red-400 break-words">
              LI failed: {slot.linkedinError}
            </span>
          )}
          {slot.xError && (
            <span className="text-red-400 break-words">
              X failed: {slot.xError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
