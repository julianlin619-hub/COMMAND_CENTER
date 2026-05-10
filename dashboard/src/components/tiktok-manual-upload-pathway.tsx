/**
 * Pathway 3 card for the TikTok detail page: user-triggered manual upload.
 *
 * Visually mirrors <PathwayCard/> so the three TikTok pathways read as a
 * set. Unlike pathways 1 and 2 (which fire a cron via a Run button), this
 * card is a navigation entry: the entire card is wrapped in a <Link/> to
 * /tiktok/manual-upload, where the actual file picker + Upload button
 * live as an inline form. This keeps the click target large (matches the
 * platform-card pattern from the home overview in creator-tabs.tsx) and
 * gives the upload form room to breathe instead of cramming it into a
 * modal.
 *
 * No client state lives here anymore, so this is a server component.
 */

import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRightIcon } from "lucide-react";

const STEPS = [
  "Pick mp4 from your computer",
  "Upload to Supabase Storage",
  "Queue on Buffer: TikTok + YouTube Shorts + LinkedIn (next open slot each)",
  "Auto-delete storage file 3 days after all three publish",
];

export function TikTokManualUploadPathway({ number }: { number: number }) {
  return (
    <Link
      href="/tiktok/manual-upload"
      className="block group"
      aria-label="Open manual upload"
    >
      <Card className="mb-4 transition-colors group-hover:border-white/20">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <Badge className="bg-white/[0.08] text-[var(--overview-fg)]/80 border-white/10 text-[11px]">
                Pathway {number}
              </Badge>
              <CardTitle className="text-sm">Manual upload</CardTitle>
            </div>
            {/* Right-side affordance hints that the card is a link. We
                keep it subtle (40% opacity) and brighten on hover to match
                the rest of the dashboard's link styling. */}
            <ArrowRightIcon className="size-4 shrink-0 text-[var(--overview-fg)]/40 transition-colors group-hover:text-[var(--overview-fg)]/80" />
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
    </Link>
  );
}
