"use client";

/**
 * Tweet Extractor client island.
 *
 * Step ① Transcribe: point it at a LOCAL media file by absolute path (no upload
 * — the dashboard runs on the same machine as the file). The spawned Python
 * worker reads the file with ffmpeg and transcribes it via Deepgram (chunking
 * hours-long audio). The resulting transcript drops into the box below, with an
 * optional timestamped sentence view.
 *
 * Tweet extraction (the old Step ②) is TEMPORARILY PAUSED in the dashboard — it
 * now lives as a Claude skill on desktop. The transcript box stays so you can
 * copy the transcript out and feed it to that skill. The server-side extractor
 * (the old api/tweet-extractor/extract route + core/tweet_extractor.py) has been
 * removed — rebuild it here when extraction comes back to the dashboard.
 *
 * The transcription call runs server-side and can take tens of seconds (longer
 * for a multi-hour file), so the step shows a working state.
 */

import { useState } from "react";
import {
  LoaderIcon,
  CheckIcon,
  CopyIcon,
  ChevronDownIcon,
  FileAudioIcon,
  FolderOpenIcon,
  ClockIcon,
  PauseIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { FileBrowserDialog } from "./file-browser-dialog";

// One Deepgram sentence with whole-recording timestamps (from the transcribe step).
type Sentence = { text: string; start: number; end: number };

/** Seconds → H:MM:SS (or M:SS under an hour). */
function secondsToHMS(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function TweetExtractorClient() {
  const [transcript, setTranscript] = useState("");

  // Step ① state
  const [filePath, setFilePath] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [transcribedFrom, setTranscribedFrom] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  // Whole-recording sentence timestamps from the transcribe step (drives the
  // timestamped transcript view). Empty for a pasted transcript.
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [copiedTranscript, setCopiedTranscript] = useState(false);

  const canTranscribe = filePath.trim().length > 0 && !transcribing;

  async function handleTranscribe() {
    setTranscribing(true);
    setStep1Error(null);
    setTranscribedFrom(null);
    try {
      const res = await fetch("/api/tweet-extractor/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: filePath.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setTranscript(String(data.transcript ?? ""));
      setSentences(Array.isArray(data.sentences) ? (data.sentences as Sentence[]) : []);
      setTranscribedFrom(filePath.trim().split("/").pop() || filePath.trim());
    } catch (e) {
      setStep1Error(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setTranscribing(false);
    }
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopiedTranscript(true);
      setTimeout(() => setCopiedTranscript(false), 1500);
    } catch {
      // Clipboard can be blocked (no secure context / permissions) — no-op;
      // the user can still select the text manually.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Step ① — Transcribe ───────────────────────────────────────── */}
      <section className="cc-surface p-4">
        <StepLabel n={1} title="Transcribe a local video or audio file" />

        <p className="mt-2 text-[12px] leading-relaxed text-white/45">
          Click <span className="text-white/70">Browse</span> to pick a file, or paste
          an absolute path. No upload — it’s read straight from disk. MP4 · MOV ·
          WebM · MP3 · M4A · WAV.
        </p>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canTranscribe) handleTranscribe();
            }}
            placeholder="/Users/you/Movies/interview.mp4"
            spellCheck={false}
            className="flex-1 font-mono text-[13px]"
          />
          <Button
            variant="outline"
            onClick={() => setBrowserOpen(true)}
            disabled={transcribing}
          >
            <FolderOpenIcon className="size-4" />
            Browse…
          </Button>
          <Button onClick={handleTranscribe} disabled={!canTranscribe}>
            {transcribing ? (
              <>
                <LoaderIcon className="size-4 animate-spin" />
                Transcribing…
              </>
            ) : (
              <>
                <FileAudioIcon className="size-4" />
                Transcribe
              </>
            )}
          </Button>
        </div>

        <FileBrowserDialog
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          onPick={(p) => setFilePath(p)}
        />

        {transcribing && (
          <p className="mt-2 text-[12px] text-white/45">
            Extracting audio and running Deepgram. A long recording is split into
            chunks — this can take a few minutes.
          </p>
        )}
        {step1Error && (
          <p className="mt-2 text-[12px] text-[var(--pill-warn-fg)]">{step1Error}</p>
        )}
        {transcribedFrom && !step1Error && !transcribing && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--pill-ok-fg)]">
            <CheckIcon className="size-3.5" />
            Transcribed “{transcribedFrom}” — review and copy it below.
          </p>
        )}
      </section>

      {/* ── Step ② — Transcript (extraction paused) ───────────────────── */}
      <section className="cc-surface p-4">
        <StepLabel n={2} title="Transcript" />

        {/* Tweet extraction has moved off the dashboard — point the user to the
            Claude skill instead of showing a dead button. */}
        <div
          className="mt-3 flex items-start gap-2.5 rounded-lg p-3"
          style={{ background: "var(--pill-idle-bg)" }}
        >
          <PauseIcon
            className="mt-0.5 size-4 shrink-0"
            style={{ color: "var(--pill-idle-fg)" }}
          />
          <p className="text-[12px] leading-relaxed text-white/55">
            <span className="font-semibold text-white/75">
              Tweet extraction is temporarily paused here.
            </span>{" "}
            It now lives as a Claude skill on desktop — copy the transcript below
            and run it through the skill to mine verbatim tweet-worthy lines.
          </p>
        </div>

        <Textarea
          id="transcript"
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Transcript appears here after step 1 — or paste one directly."
          className="mt-3 min-h-[200px] resize-y font-mono text-[13px] leading-relaxed"
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="font-mono text-[11px] tabular text-white/40">
            {transcript.length.toLocaleString()} chars
          </span>
          <Button
            variant="outline"
            onClick={copyTranscript}
            disabled={transcript.trim().length === 0}
          >
            {copiedTranscript ? (
              <>
                <CheckIcon className="size-4" />
                Copied
              </>
            ) : (
              <>
                <CopyIcon className="size-4" />
                Copy transcript
              </>
            )}
          </Button>
        </div>

        {/* Timestamped transcript view (whole-recording sentence times). */}
        {sentences.length > 0 && (
          <div className="mt-4 border-t border-[var(--surface-border)] pt-3">
            <button
              type="button"
              onClick={() => setShowTimestamps((v) => !v)}
              className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/40 transition-colors hover:text-white/75"
            >
              <ClockIcon className="size-3.5" />
              Timestamped transcript ({sentences.length.toLocaleString()} sentences)
              <ChevronDownIcon
                className={
                  "size-3 transition-transform " + (showTimestamps ? "rotate-180" : "")
                }
              />
            </button>
            {showTimestamps && (
              <div className="mt-2 max-h-[45vh] space-y-1 overflow-y-auto rounded-lg border border-[var(--surface-border)] p-3">
                {sentences.map((s, i) => (
                  <p key={i} className="text-[13px] leading-relaxed text-white/70">
                    <span className="mr-2 font-mono text-[11px] tabular text-[var(--terracotta-hover)]">
                      {secondsToHMS(s.start)}
                    </span>
                    {s.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function StepLabel({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-semibold"
        style={{ background: "var(--terracotta-soft)", color: "var(--terracotta-hover)" }}
      >
        {n}
      </span>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-white/80">
        {title}
      </h2>
    </div>
  );
}
