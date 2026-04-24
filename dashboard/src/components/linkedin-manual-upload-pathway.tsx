/**
 * Pathway 2 for the LinkedIn detail page.
 *
 * Manual mp4 uploads are unified under TikTok Pathway 3, which fans the same
 * video out to TikTok + YouTube Shorts + LinkedIn in one shot. This card is
 * a signpost — it explains the flow and links to /tiktok rather than
 * exposing a separate dialog.
 */

import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRightIcon } from "lucide-react";

const STEPS = [
  "Open the TikTok page",
  "Use Pathway 3 · Manual upload",
  "The same upload queues on Buffer's LinkedIn channel automatically",
  "Auto-delete storage file 3 days after all three publish",
];

export function LinkedInManualUploadPathway({ number }: { number: number }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
              Pathway {number}
            </Badge>
            <CardTitle className="text-sm">Manual upload (via TikTok)</CardTitle>
          </div>
          <Link href="/tiktok" className={buttonVariants({ size: "sm" })}>
            <ArrowRightIcon />
            Go to TikTok
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
          User-triggered — no cron schedule.
        </p>
      </CardContent>
    </Card>
  );
}
