/**
 * Manual Upload page.
 *
 * Reached from the "Reposts" card on the Command Center home. Hosts the
 * inline upload form (file picker + title + caption + Upload button) that
 * POSTs to /api/tiktok/manual-upload.
 *
 * Note on the route name: the page used to live at /tiktok/manual-upload
 * because it was originally framed as a TikTok pathway. The underlying
 * workflow is platform-agnostic — the same mp4 is fanned out to TikTok,
 * YouTube Shorts, LinkedIn, and (via the Twitter bridge) X — so nesting it
 * under /tiktok made the breadcrumb ("Back to TikTok") misleading. The
 * page now lives at /manual-upload and routes back to the Command Center.
 *
 * The API endpoints are intentionally still under /api/tiktok/manual-upload
 * — moving the backend wasn't requested and would force a coordinated
 * rename across the route handlers, signed-URL token issuer, and the
 * client fetch calls in tiktok-upload-queue.tsx.
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { TikTokUploadQueue } from "@/components/tiktok-upload-queue";

export const dynamic = "force-dynamic";

export default function ManualUploadPage() {
  return (
    <AppShell>
      <div className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Command Center
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Manual upload</h1>
          <p className="text-sm text-muted-foreground">
            TikTok + YouTube Shorts + LinkedIn — fan out the same mp4 to all
            three Buffer channels. Queue up to 30 uploads in parallel.
          </p>
        </div>
      </div>

      <TikTokUploadQueue />
    </AppShell>
  );
}
