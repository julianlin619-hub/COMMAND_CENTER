"use client";

/**
 * Outlier Tweet Reel — 4-step pipeline for TikTok content generation.
 * Fetch tweets → select → generate videos → send to Buffer.
 * All steps stay visible with inline run buttons.
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { normalizeTweetText } from "@/lib/tweet-normalize";
import {
  SearchIcon,
  CheckCircle2Icon,
  XCircleIcon,
  LoaderIcon,
  CircleDotIcon,
  ImageIcon,
  SendIcon,
  ListChecksIcon,
  ZapIcon,
  PlayIcon,
} from "lucide-react";

interface Tweet {
  id: string;
  text: string;
  likeCount: number;
  createdAt: string;
  url: string;
  retweetCount: number;
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

export function OutlierTweetReel({ defaultHandle }: { defaultHandle: string }) {
  const [handle, setHandle] = useState(defaultHandle);
  const [minLikes, setMinLikes] = useState(4000);
  const [maxItems, setMaxItems] = useState(30);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [existingCaptions, setExistingCaptions] = useState<Set<string>>(new Set());
  const [generatedItems, setGeneratedItems] = useState<GeneratedItem[]>([]);

  const [fetchStatus, setFetchStatus] = useState<StepStatus>("idle");
  const [fetchMsg, setFetchMsg] = useState("Configure and fetch outlier tweets");
  const [selectStatus, setSelectStatus] = useState<StepStatus>("idle");
  const [selectMsg, setSelectMsg] = useState("Select tweets to convert");
  const [genStatus, setGenStatus] = useState<StepStatus>("idle");
  const [genMsg, setGenMsg] = useState("Generate images + videos");
  const [sendStatus, setSendStatus] = useState<StepStatus>("idle");
  const [sendMsg, setSendMsg] = useState("Send to Buffer queue");

  const busy = [fetchStatus, selectStatus, genStatus, sendStatus].includes("running");

  // Reset helpers
  const resetFrom = (step: 1 | 2 | 3 | 4) => {
    if (step <= 1) { setTweets([]); setFetchStatus("idle"); setFetchMsg("Configure and fetch outlier tweets"); }
    if (step <= 2) { setSelectedIds(new Set()); setExistingCaptions(new Set()); setSelectStatus("idle"); setSelectMsg("Select tweets to convert"); }
    if (step <= 3) { setGeneratedItems([]); setGenStatus("idle"); setGenMsg("Generate images + videos"); }
    if (step <= 4) { setSendStatus("idle"); setSendMsg("Send to Buffer queue"); }
  };

  /* Step 1: Fetch */
  const runFetch = useCallback(async () => {
    resetFrom(1);
    setFetchStatus("running");
    setFetchMsg("Fetching...");
    try {
      const res = await fetch("/api/content-gen/fetch-tweets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, minLikes, maxItems }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTweets(data.tweets);
      setFetchStatus("success");
      setFetchMsg(`${data.tweets.length} tweets from @${handle}`);
      if (data.tweets.length > 0) await checkDupes(data.tweets);
    } catch (e) {
      setFetchStatus("error");
      setFetchMsg(`${(e as Error).message}`);
    }
  }, [handle, minLikes, maxItems]);

  /* Step 2: Dedup + select (auto-runs after fetch) */
  async function checkDupes(fetchedTweets: Tweet[]) {
    setSelectStatus("running");
    setSelectMsg("Checking dupes...");
    try {
      const captions = fetchedTweets.map((t) => normalizeTweetText(t.text));
      const res = await fetch("/api/content-gen/check-dupes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captions }),
      });
      const data = await res.json();
      const existingSet = new Set(data.existing as string[]);
      setExistingCaptions(existingSet);
      const newIds = new Set(
        fetchedTweets.filter((t) => !existingSet.has(normalizeTweetText(t.text))).map((t) => t.id)
      );
      setSelectedIds(newIds);
      const dupeCount = fetchedTweets.length - newIds.size;
      setSelectStatus("success");
      setSelectMsg(`${newIds.size} new` + (dupeCount > 0 ? `, ${dupeCount} dupes` : ""));
    } catch {
      setSelectedIds(new Set(fetchedTweets.map((t) => t.id)));
      setSelectStatus("success");
      setSelectMsg("Dedup failed — all selected");
    }
  }

  function toggleTweet(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /* Step 3: Generate */
  const runGenerate = useCallback(async () => {
    const selected = tweets.filter((t) => selectedIds.has(t.id));
    if (!selected.length) { setGenStatus("error"); setGenMsg("No tweets selected"); return; }
    resetFrom(3);
    setGenStatus("running");
    setGenMsg(`Generating ${selected.length} videos...`);
    try {
      const res = await fetch("/api/content-gen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweets: selected.map((t) => ({ id: t.id, text: t.text })) }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGeneratedItems(data.generated);
      setGenStatus("success");
      setGenMsg(`${data.generated.length} videos ready`);
    } catch (e) {
      setGenStatus("error");
      setGenMsg(`${(e as Error).message}`);
    }
  }, [tweets, selectedIds]);

  /* Step 4: Send to Buffer */
  const runSend = useCallback(async () => {
    if (!generatedItems.length) { setSendStatus("error"); setSendMsg("Nothing to send"); return; }
    setSendStatus("running");
    setSendMsg(`Sending ${generatedItems.length} to Buffer...`);
    try {
      const res = await fetch("/api/content-gen/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: generatedItems.map((g) => ({ text: g.text, storagePath: g.storagePath })) }),
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
    { key: "fetch", label: "Fetch Tweets", icon: SearchIcon, status: fetchStatus, msg: fetchMsg, run: runFetch, canRun: !busy && !!handle.trim() },
    { key: "select", label: "Select", icon: ListChecksIcon, status: selectStatus, msg: selectMsg },
    { key: "generate", label: "Generate", icon: ImageIcon, status: genStatus, msg: genMsg, run: runGenerate, canRun: !busy && selectedIds.size > 0 },
    { key: "send", label: "Buffer", icon: SendIcon, status: sendStatus, msg: sendMsg, run: runSend, canRun: !busy && generatedItems.length > 0 },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ZapIcon className="size-4 text-blue-500" />
          Outlier Tweet Reel
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
                <span className="text-xs text-zinc-500 truncate flex-1">{s.msg}</span>
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

        {/* Fetch config */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <span className="text-[10px] text-zinc-500">Handle</span>
            <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="AlexHormozi" disabled={busy} className="h-7 text-xs" />
          </div>
          <div className="w-20">
            <span className="text-[10px] text-zinc-500">Min Likes</span>
            <Input type="number" value={minLikes} onChange={(e) => setMinLikes(Number(e.target.value))} disabled={busy} className="h-7 text-xs" />
          </div>
          <div className="w-20">
            <span className="text-[10px] text-zinc-500">Max</span>
            <Input type="number" value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value))} disabled={busy} className="h-7 text-xs" />
          </div>
        </div>

        {/* Tweet selection list */}
        {tweets.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400">{selectedIds.size}/{tweets.length} selected</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="xs" onClick={() => setSelectedIds(new Set(tweets.map((t) => t.id)))} disabled={busy}>All</Button>
                <Button variant="ghost" size="xs" onClick={() => setSelectedIds(new Set())} disabled={busy}>None</Button>
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto rounded-lg bg-zinc-900 p-1.5 space-y-0.5">
              {tweets.map((t) => {
                const normalized = normalizeTweetText(t.text);
                const isDupe = existingCaptions.has(normalized);
                const checked = selectedIds.has(t.id);
                return (
                  <label key={t.id} className={`flex items-start gap-2 rounded px-2 py-1 cursor-pointer text-xs ${checked ? "bg-zinc-800" : "hover:bg-zinc-800/50"} ${isDupe ? "opacity-50" : ""}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleTweet(t.id)} className="mt-0.5 accent-blue-500" disabled={busy} />
                    <span className="flex-1 line-clamp-1 text-zinc-300">{t.text}</span>
                    <span className="text-zinc-600 shrink-0">{t.likeCount.toLocaleString()}</span>
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
