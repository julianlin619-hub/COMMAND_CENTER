"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlayIcon, LoaderIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { PathwayLastRun } from "@/components/pathway-card";

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function formatSaves(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Serialized form passed from the server component (Date → number for boundary crossing).
interface SerializedPost {
  postId: string;
  permalink: string;
  saves: number;
  publishTimeMs: number;
  postType: string;
}

interface RepostsCardProps {
  posts: SerializedPost[];
  totalInCsv: number;
  lastRun?: PathwayLastRun | null;
}

export function RepostsCard({ posts, totalInCsv, lastRun }: RepostsCardProps) {
  const router = useRouter();

  const [batchSize, setBatchSize] = useState(10);
  const [ageFilter, setAgeFilter] = useState(false);

  type RunStatus = "idle" | "running" | "success" | "error";
  const [status, setStatus] = useState<RunStatus>("idle");
  const [summary, setSummary] = useState<{ processed: number; scheduled: number; failed: number } | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const now = Date.now();
  const sixMonthsAgo = now - SIX_MONTHS_MS;

  // Derive the preview list from the already-sorted props — no refetch needed.
  const filtered = useMemo(
    () =>
      ageFilter
        ? posts.filter((p) => p.publishTimeMs < sixMonthsAgo)
        : posts,
    [posts, ageFilter, sixMonthsAgo],
  );

  const selected = filtered.slice(0, batchSize);

  async function handleRun() {
    if (selected.length === 0) return;
    setStatus("running");
    setSummary(null);
    setOutput(null);
    setOutputExpanded(false);

    try {
      const res = await fetch("/api/instagram-reposts/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permalinks: selected.map((p) => p.permalink) }),
      });
      const data = await res.json().catch(() => ({})) as {
        status?: string;
        processed?: number;
        scheduled?: number;
        failed?: number;
        output?: string;
        error?: string;
      };

      setOutput(data.output ?? null);
      setSummary({
        processed: data.processed ?? 0,
        scheduled: data.scheduled ?? 0,
        failed: data.failed ?? 0,
      });

      if (!res.ok || data.status === "failed") {
        setStatus("error");
        if (data.status === "failed") setOutputExpanded(true);
      } else {
        setStatus("success");
      }
    } catch (err) {
      setStatus("error");
      setOutput(err instanceof Error ? err.message : "Unknown error");
      setOutputExpanded(true);
    } finally {
      router.refresh();
    }
  }

  const running = status === "running";
  const hasOutput = output !== null && output.length > 0;

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Top Saves Reposts</CardTitle>
            <p className="mt-1 text-xs text-white/45 font-mono">
              {totalInCsv} posts in CSV · Sorted by saves
            </p>
          </div>
          <Button onClick={handleRun} disabled={running || selected.length === 0} size="sm">
            {running ? (
              <>
                <LoaderIcon className="animate-spin" />
                Running…
              </>
            ) : (
              <>
                <PlayIcon />
                Run
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* ── Steps ── */}
        <ol className="space-y-1.5 mb-5">
          {[
            `Read data/instagram-post-data-all.csv (${totalInCsv} posts), sort by saves`,
            "Filter by age if enabled, then take the top batch",
            "Apify scrapes each Instagram reel URL → downloads the video",
            "Deepgram transcribes audio → RAG picks caption from tweet bank",
            "Queue to Buffer on Instagram (alexhighlights2026) as Reel",
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[11px] tabular text-white/70">
                {i + 1}
              </span>
              <span className="text-white/90">{step}</span>
            </li>
          ))}
        </ol>

        {/* ── Controls ── */}
        <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/[0.08] pt-4 text-sm">
          <label className="flex items-center gap-2 text-white/70">
            <span className="text-white/40 font-mono text-xs uppercase tracking-[0.1em]">Batch</span>
            <select
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="rounded bg-white/[0.07] px-2 py-0.5 font-mono text-xs text-white/90 outline-none focus:ring-1 focus:ring-white/20"
              disabled={running}
            >
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>{n} posts</option>
              ))}
            </select>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-white/70">
            <input
              type="checkbox"
              checked={ageFilter}
              onChange={(e) => setAgeFilter(e.target.checked)}
              disabled={running}
              className="rounded accent-[var(--terracotta)]"
            />
            <span className="text-xs text-white/70">Only posts ≥ 6 months old</span>
          </label>
        </div>

        {/* ── Preview ── */}
        {selected.length > 0 ? (
          <div className="mb-4">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-white/35">
              Preview — {selected.length} to repost
            </p>
            <ol className="space-y-1">
              {selected.map((p, i) => {
                const isOld = p.publishTimeMs < sixMonthsAgo;
                return (
                  <li
                    key={p.permalink}
                    className="flex items-baseline gap-2 font-mono text-[11px]"
                  >
                    <span className="w-4 shrink-0 text-right text-white/30 tabular">{i + 1}</span>
                    <span className="truncate text-white/80">{p.permalink.replace("https://www.instagram.com", "")}</span>
                    <span className="ml-auto shrink-0 tabular text-white/55">{formatSaves(p.saves)} saves</span>
                    <span className="shrink-0 text-white/35">{formatDate(p.publishTimeMs)}</span>
                    {isOld && (
                      <Badge className="shrink-0 border-0 bg-[#16B68A]/15 font-mono text-[9px] text-[#16B68A]">
                        old
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <p className="mb-4 text-xs text-white/40">
            {ageFilter
              ? "No posts match the ≥ 6 months filter."
              : "No posts available in the CSV."}
          </p>
        )}

        {/* ── Last run (from DB) ── */}
        {!summary && lastRun && (
          <div className="mt-3 flex items-center gap-2 text-xs text-white/45">
            <span className="font-mono">
              Last run ·{" "}
              {new Date(lastRun.startedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
            {typeof lastRun.count === "number" && (
              <span className="font-mono tabular">· {lastRun.count} scheduled</span>
            )}
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

        {/* ── Result summary (current run) ── */}
        {summary && (
          <div className="mt-3 flex items-center gap-3 text-xs">
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]"
              style={{
                backgroundColor: status === "success" ? "var(--pill-ok-bg)" : "var(--pill-warn-bg)",
                color: status === "success" ? "var(--pill-ok-fg)" : "var(--pill-warn-fg)",
              }}
            >
              {status === "success" ? "Success" : "Failed"}
            </span>
            <span className="font-mono text-white/55 tabular">
              Processed {summary.processed} · Scheduled {summary.scheduled} · Failed {summary.failed}
            </span>
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
  );
}
