/**
 * YouTube Platform Detail Page
 *
 * YouTube posts originate from the TikTok manual-upload dialog on /tiktok —
 * the same mp4 fans out to Buffer's TikTok and YouTube Shorts channels in
 * the same request. This page describes that flow and routes the user to
 * the dialog; no run button because there's no separate YouTube pipeline.
 */

import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeftIcon, UploadIcon } from "lucide-react";

export const dynamic = "force-dynamic";

const STEPS = [
  "Open the Manual Upload dialog on /tiktok",
  "Same mp4 is queued on Buffer's TikTok + YouTube Shorts channels",
  "Buffer auto-schedules each into its next open slot",
];

export default function YouTubePage() {
  return (
    <AppShell>
      <div className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Overview
        </Link>
        <div className="flex items-center gap-3">
          <PlatformIcon platform="youtube" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">YouTube</h1>
            <p className="text-sm text-muted-foreground">
              YouTube Shorts posts — queued via the TikTok manual-upload dialog
            </p>
          </div>
        </div>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
                Pathway 1
              </Badge>
              <CardTitle className="text-sm">Manual upload fan-out</CardTitle>
            </div>
            <Link href="/tiktok">
              <Button size="sm">
                <UploadIcon />
                Open TikTok upload
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="space-y-1.5">
            {STEPS.map((label, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] text-[var(--overview-fg)]/70">
                  {i + 1}
                </span>
                <span className="text-[var(--overview-fg)]/90">{label}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-[var(--overview-fg)]/45">
            User-triggered — no cron schedule. Title is required (YouTube needs one).
          </p>
        </CardContent>
      </Card>
    </AppShell>
  );
}
