/**
 * TikTok Manual Upload subpage.
 *
 * Reached by clicking the Pathway 3 card on /tiktok. Hosts the inline
 * upload form (file picker + title + caption + Upload button) that POSTs
 * to /api/tiktok/manual-upload. Previously this was a modal dialog opened
 * from the pathway card; we moved it to its own page so the click target
 * is the whole card and the form has room to breathe.
 *
 * Server component — no data fetching is needed (the upload itself is
 * client-driven). force-dynamic matches the convention of neighboring
 * platform pages so we don't accidentally cache anything user-specific.
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { TikTokManualUploadForm } from "@/components/tiktok-manual-upload-form";

export const dynamic = "force-dynamic";

export default function TikTokManualUploadPage() {
  return (
    <AppShell>
      <div className="mb-6">
        <Link
          href="/tiktok"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to TikTok
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Manual upload</h1>
          <p className="text-sm text-muted-foreground">
            TikTok + YouTube Shorts + LinkedIn — fan out the same mp4 to all
            three Buffer channels (next open slot on each).
          </p>
        </div>
      </div>

      <TikTokManualUploadForm />
    </AppShell>
  );
}
