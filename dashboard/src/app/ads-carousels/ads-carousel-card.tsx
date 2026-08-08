"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  PlayIcon,
  LoaderIcon,
  SaveIcon,
  FilterIcon,
  ExternalLinkIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { PathwayLastRun } from "@/components/pathway-card";

// Mirrors _MAX_BATCH in core/ads_carousel_pipeline.py.
const MAX_BATCH = 100;

interface AdsCarouselCardProps {
  settings: { defaultPrompt: string; ctaText: string };
  bankSize: number;
  totalPermutations: number;
  lastRun?: PathwayLastRun | null;
}

interface RunResult {
  ok: boolean;
  message: string;
  folderUrl?: string | null;
}

export function AdsCarouselCard({
  settings,
  bankSize,
  totalPermutations,
  lastRun,
}: AdsCarouselCardProps) {
  const router = useRouter();

  // Seeded from the saved defaults; what's in the fields is what runs —
  // "Save defaults" only controls what the page prefills next time.
  const [prompt, setPrompt] = useState(settings.defaultPrompt);
  const [ctaText, setCtaText] = useState(settings.ctaText);
  const [count, setCount] = useState(25);

  // One busy-flag for both actions — bank builds and generation share the
  // same Python pipeline and DB tables, so they must never run together.
  const [busy, setBusy] = useState<"idle" | "build_bank" | "generate">("idle");
  const [result, setResult] = useState<RunResult | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);

  type SaveStatus = "idle" | "saving" | "saved" | "error";
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const running = busy !== "idle";
  // Mirrors _TWEETS_PER_CAROUSEL in the pipeline: 7 tweets + CTA = 8 cards.
  const bankReady = bankSize >= 7;

  async function run(body: Record<string, unknown>, action: "build_bank" | "generate") {
    setBusy(action);
    setResult(null);
    setOutput(null);
    setOutputExpanded(false);

    try {
      const res = await fetch("/api/ads-carousels/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
        output?: string;
        // build_bank
        scanned?: number;
        bank_size?: number;
        // generate
        requested?: number;
        generated?: number;
        total_permutations?: number;
        folder_url?: string | null;
      };

      setOutput(data.output ?? null);

      if (!res.ok || data.status === "failed" || data.status === "error") {
        setResult({ ok: false, message: data.error ?? "Run failed — see the log below" });
        setOutputExpanded(true);
      } else if (action === "build_bank") {
        setResult({
          ok: true,
          message: `Bank built — kept ${data.bank_size ?? 0} of ${data.scanned ?? 0} scanned tweets`,
        });
      } else {
        const short =
          (data.generated ?? 0) < (data.requested ?? 0)
            ? ` (space saturated — asked for ${data.requested})`
            : "";
        setResult({
          ok: true,
          message: `Generated ${data.generated ?? 0} carousel(s)${short} · ${data.total_permutations ?? 0} total ever`,
          folderUrl: data.folder_url ?? null,
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy("idle");
      router.refresh();
    }
  }

  async function handleSaveDefaults() {
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/ads-carousels/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPrompt: prompt, ctaText }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    }
    // Let the confirmation linger briefly, then reset so the button is
    // ready for the next edit.
    setTimeout(() => setSaveStatus("idle"), 2500);
  }

  const hasOutput = output !== null && output.length > 0;

  return (
    <>
      {/* ── Step 1: the bank ── */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">1 · Build the Bank</CardTitle>
              <p className="mt-1 font-mono text-xs text-white/45 tabular">
                {bankSize} tweets in the ads bank
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => run({ action: "build_bank", prompt: prompt.trim() }, "build_bank")}
              disabled={running || prompt.trim().length === 0}
            >
              {busy === "build_bank" ? (
                <>
                  <LoaderIcon className="animate-spin" />
                  Filtering…
                </>
              ) : (
                <>
                  <FilterIcon />
                  {bankReady ? "Rebuild bank" : "Build bank"}
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-white/70">
            Claude reads every master-bank tweet (~5K) and keeps the ones that fit the brief
            below. Run this once — rebuilds wipe and refill the bank, and take a few minutes.
          </p>
          <label className="block">
            <span className="mb-1.5 block font-mono text-xs uppercase tracking-[0.1em] text-white/40">
              Brief
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={running}
              rows={3}
              placeholder="e.g. tweets about business and entrepreneurship — tactical or the entrepreneur mindset"
              className="w-full resize-y rounded bg-white/[0.07] px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:ring-1 focus:ring-white/20"
            />
          </label>
        </CardContent>
      </Card>

      {/* ── Step 2: generate permutations ── */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">2 · Generate Permutations</CardTitle>
              <p className="mt-1 font-mono text-xs text-white/45 tabular">
                {totalPermutations} carousels generated so far · every new one differs by ≥ 3 tweets
              </p>
            </div>
            <Button
              onClick={() =>
                run({ action: "generate", count, ctaText: ctaText.trim() }, "generate")
              }
              disabled={running || !bankReady || ctaText.trim().length === 0}
            >
              {busy === "generate" ? (
                <>
                  <LoaderIcon className="animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <PlayIcon />
                  Generate
                </>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* ── Steps ── */}
          <ol className="mb-5 space-y-1.5">
            {[
              "Pick 7 bank tweets at random, in random order (7 + CTA = 8 cards)",
              "Reject any pick sharing more than 6 tweets with ANY carousel ever made (ledger-backed, survives across runs)",
              "Render unique slides once on the 1080×1350 ads template — CTA is always the last slide",
              "Upload to Drive: one numbered folder per carousel (01.png … 10.png)",
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[11px] tabular text-white/70">
                  {i + 1}
                </span>
                <span className="text-white/90">{step}</span>
              </li>
            ))}
          </ol>

          {!bankReady && (
            <p className="mb-4 text-xs text-white/45">
              Build the bank first — generation needs at least 7 tweets to draw from.
            </p>
          )}

          {/* ── Inputs ── */}
          <div className="space-y-4 border-t border-white/[0.08] pt-4">
            <label className="block">
              <span className="mb-1.5 block font-mono text-xs uppercase tracking-[0.1em] text-white/40">
                CTA (last slide of every carousel)
              </span>
              <textarea
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                disabled={running}
                rows={3}
                placeholder="Exact CTA copy — rendered as the final slide of every carousel"
                className="w-full resize-y rounded bg-white/[0.07] px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/25 focus:ring-1 focus:ring-white/20"
              />
            </label>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-white/70">
                <span className="font-mono text-xs uppercase tracking-[0.1em] text-white/40">
                  How many
                </span>
                <input
                  type="number"
                  min={1}
                  max={MAX_BATCH}
                  value={count}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n)) setCount(Math.max(1, Math.min(MAX_BATCH, n)));
                  }}
                  disabled={running}
                  className="w-20 rounded bg-white/[0.07] px-2 py-0.5 font-mono text-xs text-white/90 outline-none tabular focus:ring-1 focus:ring-white/20"
                />
                <span className="font-mono text-[11px] text-white/35">max {MAX_BATCH}/run</span>
              </label>

              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveDefaults}
                disabled={running || saveStatus === "saving"}
              >
                <SaveIcon />
                {saveStatus === "saving"
                  ? "Saving…"
                  : saveStatus === "saved"
                    ? "Saved"
                    : saveStatus === "error"
                      ? "Save failed — retry"
                      : "Save brief + CTA as defaults"}
              </Button>
            </div>
          </div>

          {/* ── Last run (from DB) ── */}
          {!result && lastRun && (
            <div className="mt-5 flex items-center gap-2 text-xs text-white/45">
              <span className="font-mono">
                Last run ·{" "}
                {new Date(lastRun.startedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em]"
                style={{
                  backgroundColor:
                    lastRun.status === "success" ? "var(--pill-ok-bg)" : "var(--pill-warn-bg)",
                  color:
                    lastRun.status === "success" ? "var(--pill-ok-fg)" : "var(--pill-warn-fg)",
                }}
              >
                {lastRun.status}
              </span>
            </div>
          )}

          {/* ── Result (current run) ── */}
          {result && (
            <div className="mt-5 flex flex-wrap items-center gap-3 text-xs">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]"
                style={{
                  backgroundColor: result.ok ? "var(--pill-ok-bg)" : "var(--pill-warn-bg)",
                  color: result.ok ? "var(--pill-ok-fg)" : "var(--pill-warn-fg)",
                }}
              >
                {result.ok ? "Success" : "Failed"}
              </span>
              <span className="font-mono text-white/55">{result.message}</span>
              {result.folderUrl && (
                <a
                  href={result.folderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-white/80 underline decoration-white/30 underline-offset-2 hover:text-white"
                >
                  Open batch folder
                  <ExternalLinkIcon className="size-3" />
                </a>
              )}
            </div>
          )}

          {/* ── Output log ── */}
          {hasOutput && (
            <div className="mt-3">
              <button
                onClick={() => setOutputExpanded((v) => !v)}
                className="flex items-center gap-1 font-mono text-[11px] text-white/40 hover:text-white/60"
              >
                {outputExpanded ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
                Run log
              </button>
              {outputExpanded && (
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-white/65">
                  {output}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
