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
import { BatchVideoUpload } from "@/components/batch-video-upload";

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
            TikTok + YouTube Shorts + LinkedIn + X (via Twitter bridge) — fan
            out the same mp4 to all four Buffer channels. Queue up to 30
            uploads in parallel.
          </p>
        </div>
      </div>

      {/* Batch auto-schedule: drop a folder of mp4s; title + caption are
          generated from each video's transcript and fanned out automatically.
          Sits above the manual title+caption form since it's the faster path
          for bulk reposts. */}
      <section className="mb-10">
        <h2 className="mb-1 text-sm font-semibold">Batch auto-schedule</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Drag in a batch of videos. Each one is transcribed, gets an
          auto-generated title and a caption matched from the tweet bank, then
          is scheduled to TikTok + YouTube Shorts + X via Buffer.
        </p>
        <BatchVideoUpload />
      </section>

      {/* Manual single upload with hand-written title + caption. */}
      <section>
        <h2 className="mb-1 text-sm font-semibold">Manual title &amp; caption</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Type the title and caption yourself for a single video.
        </p>
        <TikTokUploadQueue />
      </section>
    </AppShell>
  );
}
