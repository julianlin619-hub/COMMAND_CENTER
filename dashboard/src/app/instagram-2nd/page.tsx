/**
 * Instagram (2nd) Platform Detail Page
 *
 * Shows the tweet-to-Instagram pipeline workflow: pick tweets from the
 * shared CSV bank, generate PNG/MP4 media, and schedule to Instagram
 * via Zernio.
 */

import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { ArrowLeftIcon } from "lucide-react";
import { PipelineSteps } from "./pipeline-steps";

export const dynamic = "force-dynamic";

export default function InstagramSecondPage() {
  return (
    <AppShell>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Overview
        </Link>
        <div className="flex items-center gap-3">
          <PlatformIcon platform="instagram_2nd" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Instagram (2nd)</h1>
            <p className="text-sm text-muted-foreground">
              Tweet-to-Instagram pipeline — pick, generate, schedule
            </p>
          </div>
        </div>
      </div>

      {/* Pipeline workflow */}
      <PipelineSteps />
    </AppShell>
  );
}
