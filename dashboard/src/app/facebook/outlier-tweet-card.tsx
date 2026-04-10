"use client";

/**
 * Outlier Tweet Card — 4-step pipeline for Facebook content generation.
 *
 * Same wizard pattern as TikTok's outlier-tweet-reel.tsx, but adapted for
 * the Facebook follower pipeline:
 *   1. Load TikTok Posts — from the database (no Apify fetch)
 *   2. Select — auto-dedup against existing Facebook posts
 *   3. Generate square images — via /api/content-gen/generate?platform=facebook
 *   4. Send to Buffer — via /api/content-gen/schedule?platform=facebook
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { normalizeTweetText } from "@/lib/tweet-normalize";
import {
  CheckCircle2Icon,
  XCircleIcon,
  LoaderIcon,
  CircleDotIcon,
  ImageIcon,
  SendIcon,
  ListChecksIcon,
  ZapIcon,
  PlayIcon,
  DatabaseIcon,
} from "lucide-react";

interface TikTokPost {
  id: string;
  caption: string;
  createdAt: string;
}

interface GeneratedItem {
  id: string;
  text: string;
  storagePath: string;
}

type StepStatus = "idle" | "running" | "success" | "error";

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "running":
      return <LoaderIcon className="size-4 animate-spin text-blue-500" />;
    case "success":
      return <CheckCircle2Icon className="size-4 text-green-500" />;
    case "error":
      return <XCircleIcon className="size-4 text-red-500" />;
    default:
      return <CircleDotIcon className="size-4 text-zinc-600" />;
  }
}

function StatusBadge({ status }: { status: StepStatus }) {
  const cls = {
    running: "bg-blue-500/15 text-blue-500 border-blue-500/25",
    success: "bg-green-500/15 text-green-500 border-green-500/25",
    error: "bg-red-500/15 text-red-500 border-red-500/25",
    idle: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  }[status];
  const text = { running: "Running", success: "Done", error: "Failed", idle: "Idle" }[status];
  return status === "error"
    ? <Badge variant="destructive">{text}</Badge>
    : <Badge className={cls}>{text}</Badge>;
}

interface OutlierTweetCardProps {
  initialTikTokPosts: TikTokPost[];
}

export function OutlierTweetCard({ initialTikTokPosts }: OutlierTweetCardProps) {
  const [posts] = useState<TikTokPost[]>(initialTikTokPosts);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [existingCaptions, setExistingCaptions] = useState<Set<string>>(new Set());
  const [generatedItems, setGeneratedItems] = useState<GeneratedItem[]>([]);

  // Step 1 is pre-loaded from server — starts as success if we have posts
  const [loadStatus, setLoadStatus] = useState<StepStatus>(
    initialTikTokPosts.length > 0 ? "success" : "idle"
  );
  const [loadMsg, setLoadMsg] = useState(
    initialTikTokPosts.length > 0
      ? `${initialTikTokPosts.length} TikTok posts loaded`
      : "No recent TikTok posts found"
  );
  const [selectStatus, setSelectStatus] = useState<StepStatus>("idle");
  const [selectMsg, setSelectMsg] = useState("Select posts to convert");
  const [genStatus, setGenStatus] = useState<StepStatus>("idle");
  const [genMsg, setGenMsg] = useState("Generate square images");
  const [sendStatus, setSendStatus] = useState<StepStatus>("idle");
  const [sendMsg, setSendMsg] = useState("Send to Buffer queue");

  const busy = [selectStatus, genStatus, sendStatus].includes("running");

  // Reset helpers
  const resetFrom = (step: 2 | 3 | 4) => {
    if (step <= 2) { setSelectedIds(new Set()); setExistingCaptions(new Set()); setSelectStatus("idle"); setSelectMsg("Select posts to convert"); }
    if (step <= 3) { setGeneratedItems([]); setGenStatus("idle"); setGenMsg("Generate square images"); }
    if (step <= 4) { setSendStatus("idle"); setSendMsg("Send to Buffer queue"); }
  };

  /* Step 2: Dedup against existing Facebook posts + auto-select */
  const runDedup = useCallback(async () => {
    resetFrom(2);
    setSelectStatus("running");
    setSelectMsg("Checking for duplicates...");
    try {
      // Normalize captions and check which ones already exist as Facebook posts
      const captions = posts.map((p) => normalizeTweetText(p.caption));
      const res = await fetch("/api/content-gen/check-dupes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions, platform: "facebook" }),
      });
      const data = await res.json();
      const existingSet = new Set(data.existing as string[]);
      setExistingCaptions(existingSet);

      // Auto-select posts that aren't dupes
      const newIds = new Set(
        posts
          .filter((p) => !existingSet.has(normalizeTweetText(p.caption)))
          .map((p) => p.id)
      );
      setSelectedIds(newIds);
      const dupeCount = posts.length - newIds.size;
      setSelectStatus("success");
      setSelectMsg(`${newIds.size} new` + (dupeCount > 0 ? `, ${dupeCount} dupes` : ""));
    } catch {
      // If dedup fails, select all — better to have duplicates than miss content
      setSelectedIds(new Set(posts.map((p) => p.id)));
      setSelectStatus("success");
      setSelectMsg("Dedup failed — all selected");
    }
  }, [posts]);

  function togglePost(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /* Step 3: Generate square images */
  const runGenerate = useCallback(async () => {
    const selected = posts.filter((p) => selectedIds.has(p.id));
    if (!selected.length) { setGenStatus("error"); setGenMsg("No posts selected"); return; }
    resetFrom(3);
    setGenStatus("running");
    setGenMsg(`Generating ${selected.length} square images...`);
    try {
      const res = await fetch("/api/content-gen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "facebook",
          tweets: selected.map((p) => ({ id: p.id, text: p.caption })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGeneratedItems(data.generated);
      setGenStatus("success");
      setGenMsg(`${data.generated.length} images ready`);
    } catch (e) {
      setGenStatus("error");
      setGenMsg(`${(e as Error).message}`);
    }
  }, [posts, selectedIds]);

  /* Step 4: Send to Buffer */
  const runSend = useCallback(async () => {
    if (!generatedItems.length) { setSendStatus("error"); setSendMsg("Nothing to send"); return; }
    setSendStatus("running");
    setSendMsg(`Sending ${generatedItems.length} to Buffer...`);
    try {
      const res = await fetch("/api/content-gen/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "facebook",
          items: generatedItems.map((g) => ({ text: g.text, storagePath: g.storagePath })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSendStatus("success");
      setSendMsg(`${data.sent.length} sent — publishing at next slots`);
    } catch (e) {
      setSendStatus("error");
      setSendMsg(`${(e as Error).message}`);
    }
  }, [generatedItems]);

  const steps = [
    { key: "load", label: "TikTok Posts", icon: DatabaseIcon, status: loadStatus, msg: loadMsg },
    { key: "select", label: "Select", icon: ListChecksIcon, status: selectStatus, msg: selectMsg, run: runDedup, canRun: !busy && posts.length > 0 },
    { key: "generate", label: "Generate", icon: ImageIcon, status: genStatus, msg: genMsg, run: runGenerate, canRun: !busy && selectedIds.size > 0 },
    { key: "send", label: "Buffer", icon: SendIcon, status: sendStatus, msg: sendMsg, run: runSend, canRun: !busy && generatedItems.length > 0 },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ZapIcon className="size-4 text-blue-500" />
          Outlier Tweet Card
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Step overview rows */}
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={s.key}>
              <div className="flex items-center gap-3 py-2">
                <div className="flex items-center justify-center size-6 rounded-full bg-zinc-800 text-[10px] font-medium text-zinc-400 shrink-0">
                  {s.status === "idle" ? i + 1 : <StatusIcon status={s.status} />}
                </div>
                <Icon className="size-3.5 text-zinc-500 shrink-0" />
                <span className="text-sm font-medium">{s.label}</span>
                <span className={`text-xs text-zinc-500 flex-1 ${s.status === "error" ? "whitespace-normal break-all" : "truncate"}`}>{s.msg}</span>
                <StatusBadge status={s.status} />
                {s.run && (
                  <Button variant="outline" size="icon-xs" disabled={!s.canRun} onClick={s.run}>
                    <PlayIcon className="size-3" />
                  </Button>
                )}
              </div>
              {i < steps.length - 1 && <Separator />}
            </div>
          );
        })}

        <Separator />

        {/* Info note */}
        <p className="text-[10px] text-zinc-600">
          Showing recent TikTok posts to repurpose as Facebook quote cards.
          No separate tweet fetch needed — Facebook piggybacks on TikTok&apos;s selection.
        </p>

        {/* Post selection list */}
        {posts.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400">{selectedIds.size}/{posts.length} selected</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="xs" onClick={() => setSelectedIds(new Set(posts.map((p) => p.id)))} disabled={busy}>All</Button>
                <Button variant="ghost" size="xs" onClick={() => setSelectedIds(new Set())} disabled={busy}>None</Button>
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 space-y-0.5">
              {posts.map((p) => {
                const normalized = normalizeTweetText(p.caption);
                const isDupe = existingCaptions.has(normalized);
                const checked = selectedIds.has(p.id);
                return (
                  <label key={p.id} className={`flex items-start gap-2 rounded px-2 py-1 cursor-pointer text-xs ${checked ? "bg-zinc-800" : "hover:bg-zinc-800/50"} ${isDupe ? "opacity-50" : ""}`}>
                    <input type="checkbox" checked={checked} onChange={() => togglePost(p.id)} className="mt-0.5 accent-blue-500" disabled={busy} />
                    <span className="flex-1 line-clamp-1 text-zinc-300">{p.caption}</span>
                    <span className="text-zinc-600 shrink-0 text-[10px]">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </span>
                    {isDupe && <Badge className="bg-yellow-500/15 text-yellow-500 border-yellow-500/25 text-[9px] px-1 py-0 shrink-0">dupe</Badge>}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Generated items */}
        {generatedItems.length > 0 && (
          <div className="max-h-28 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 text-xs text-zinc-400 space-y-0.5">
            {generatedItems.map((g) => (
              <div key={g.id} className="truncate px-1">
                <span className="text-green-500">&#10003;</span>{" "}
                <span className="text-zinc-600 font-mono">{g.storagePath}</span>
              </div>
            ))}
          </div>
        )}

        {/* Success banner */}
        {sendStatus === "success" && (
          <div className="rounded-lg bg-green-500/10 border border-green-500/25 px-3 py-1.5 text-xs text-green-400">
            {sendMsg}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
