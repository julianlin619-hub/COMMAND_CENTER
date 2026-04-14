"use client";

/**
 * Bank Reel — 3-step pipeline for TikTok content from TweetMasterBank.
 * Pick from bank → generate video → send to Buffer.
 * Mirrors OutlierTweetReel but sources from the CSV bank instead of Apify.
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  BookOpenIcon,
  CheckCircle2Icon,
  XCircleIcon,
  LoaderIcon,
  CircleDotIcon,
  ImageIcon,
  SendIcon,
  PlayIcon,
} from "lucide-react";

interface BankTweet {
  tweetId: string;
  text: string;
  favoriteCount: number;
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

export function BankReel() {
  const [minLikes, setMinLikes] = useState(6500);
  const [picked, setPicked] = useState<BankTweet | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [generatedItems, setGeneratedItems] = useState<GeneratedItem[]>([]);

  const [pickStatus, setPickStatus] = useState<StepStatus>("idle");
  const [pickMsg, setPickMsg] = useState("Pick a random high-performing tweet");
  const [genStatus, setGenStatus] = useState<StepStatus>("idle");
  const [genMsg, setGenMsg] = useState("Generate video from picked tweet");
  const [sendStatus, setSendStatus] = useState<StepStatus>("idle");
  const [sendMsg, setSendMsg] = useState("Send to Buffer queue");

  const busy = [pickStatus, genStatus, sendStatus].includes("running");

  const resetFrom = (step: 1 | 2 | 3) => {
    if (step <= 1) { setPicked(null); setRemaining(null); setPickStatus("idle"); setPickMsg("Pick a random high-performing tweet"); }
    if (step <= 2) { setGeneratedItems([]); setGenStatus("idle"); setGenMsg("Generate video from picked tweet"); }
    if (step <= 3) { setSendStatus("idle"); setSendMsg("Send to Buffer queue"); }
  };

  /* Step 1: Pick from bank */
  const runPick = useCallback(async () => {
    resetFrom(1);
    setPickStatus("running");
    setPickMsg("Picking from bank...");
    try {
      const res = await fetch("/api/tiktok/bank-pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1, minLikes }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.picked?.length) {
        setPickStatus("error");
        setPickMsg(data.message || "No tweets available");
        return;
      }
      const tweet = data.picked[0];
      setPicked(tweet);
      setRemaining(data.remaining);
      setPickStatus("success");
      setPickMsg(`${tweet.favoriteCount.toLocaleString()} likes — ${data.remaining.toLocaleString()} remaining`);
    } catch (e) {
      setPickStatus("error");
      setPickMsg(`${(e as Error).message}`);
    }
  }, [minLikes]);

  /* Step 2: Generate video */
  const runGenerate = useCallback(async () => {
    if (!picked) { setGenStatus("error"); setGenMsg("No tweet picked"); return; }
    resetFrom(2);
    setGenStatus("running");
    setGenMsg("Generating video...");
    try {
      const res = await fetch("/api/content-gen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweets: [{ id: picked.tweetId, text: picked.text }] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setGeneratedItems(data.generated);
      setGenStatus("success");
      setGenMsg(`${data.generated.length} video ready`);
    } catch (e) {
      setGenStatus("error");
      setGenMsg(`${(e as Error).message}`);
    }
  }, [picked]);

  /* Step 3: Send to Buffer */
  const runSend = useCallback(async () => {
    if (!generatedItems.length) { setSendStatus("error"); setSendMsg("Nothing to send"); return; }
    setSendStatus("running");
    setSendMsg("Sending to Buffer...");
    try {
      const res = await fetch("/api/content-gen/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: generatedItems.map((g) => ({ text: g.text, storagePath: g.storagePath })) }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSendStatus("success");
      setSendMsg(`${data.sent.length} sent — publishing at next slot`);
    } catch (e) {
      setSendStatus("error");
      setSendMsg(`${(e as Error).message}`);
    }
  }, [generatedItems]);

  const steps = [
    { key: "pick", label: "Pick from Bank", icon: BookOpenIcon, status: pickStatus, msg: pickMsg, run: runPick, canRun: !busy },
    { key: "generate", label: "Generate", icon: ImageIcon, status: genStatus, msg: genMsg, run: runGenerate, canRun: !busy && !!picked },
    { key: "send", label: "Buffer", icon: SendIcon, status: sendStatus, msg: sendMsg, run: runSend, canRun: !busy && generatedItems.length > 0 },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpenIcon className="size-4 text-blue-500" />
          Bank Reel
          <span className="text-xs font-normal text-zinc-500">
            — 1 reel from TweetMasterBank
          </span>
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

        {/* Config */}
        <div className="flex items-end gap-2">
          <div className="w-28">
            <span className="text-[10px] text-zinc-500">Min Likes</span>
            <Input
              type="number"
              value={minLikes}
              onChange={(e) => setMinLikes(Number(e.target.value))}
              disabled={busy}
              className="h-7 text-xs"
            />
          </div>
          {remaining !== null && (
            <span className="text-xs text-zinc-500 pb-1">
              {remaining.toLocaleString()} unused tweets in bank
            </span>
          )}
        </div>

        {/* Picked tweet preview */}
        {picked && (
          <div className="rounded-lg bg-zinc-900 p-2.5 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <Badge className="bg-zinc-700 text-zinc-300 text-[9px]">
                {picked.favoriteCount.toLocaleString()} likes
              </Badge>
              <span className="text-zinc-600 font-mono text-[10px]">
                {picked.tweetId}
              </span>
            </div>
            <p className="text-zinc-300 leading-relaxed">{picked.text}</p>
          </div>
        )}

        {/* Generated items */}
        {generatedItems.length > 0 && (
          <div className="rounded-lg bg-zinc-900 p-1.5 text-xs text-zinc-400 space-y-0.5">
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
