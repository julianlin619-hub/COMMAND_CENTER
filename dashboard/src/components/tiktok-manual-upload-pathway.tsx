"use client";

/**
 * Pathway 3 for the TikTok detail page: user-triggered manual upload.
 *
 * Visually mirrors <PathwayCard/> so the three TikTok pathways read as a set,
 * but the Run button opens <TikTokUploadDialog/> (which POSTs to
 * /api/tiktok/manual-upload) instead of firing a cron job.
 */

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadIcon } from "lucide-react";
import { TikTokUploadDialog } from "@/components/tiktok-upload-dialog";

const STEPS = [
  "Pick mp4 from your computer",
  "Upload to Supabase Storage",
  "Queue on Buffer: TikTok + YouTube Shorts (next open slot each)",
  "Auto-delete storage file 3 days after both publish",
];

export function TikTokManualUploadPathway({ number }: { number: number }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
                Pathway {number}
              </Badge>
              <CardTitle className="text-sm">Manual upload</CardTitle>
            </div>
            <Button onClick={() => setOpen(true)} size="sm">
              <UploadIcon />
              Upload
            </Button>
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
            User-triggered — no cron schedule.
          </p>
        </CardContent>
      </Card>

      <TikTokUploadDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
