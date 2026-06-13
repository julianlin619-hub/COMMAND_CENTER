/**
 * Manual Upload page.
 *
 * Reached from the "Reposts" card on the Command Center home. Hosts the
 * batch upload drop zone: each video is transcribed, gets an auto-generated
 * title and a caption matched from the tweet bank, and is then scheduled
 * out to Buffer — no hand-typed title or caption anywhere.
 *
 * Note on the route name: the page used to live at /tiktok/manual-upload
 * because it was originally framed as a TikTok pathway. The underlying
 * workflow is platform-agnostic — the same mp4 is fanned out to TikTok,
 * YouTube Shorts, and (via the Twitter bridge) X — so nesting it under
 * /tiktok made the breadcrumb ("Back to TikTok") misleading. The page now
 * lives at /manual-upload and routes back to the Command Center.
 *
 * The API endpoints are intentionally still under /api/tiktok/manual-upload
 * — moving the backend wasn't requested and would force a coordinated
 * rename across the route handlers, signed-URL token issuer, and the
 * client fetch calls in batch-video-upload.tsx.
 */

import { AppShell } from "@/components/app-shell";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { SectionRail } from "@/components/command-center/section-rail";
import { BatchVideoUpload } from "@/components/batch-video-upload";

export const dynamic = "force-dynamic";

export default function ManualUploadPage() {
  return (
    <AppShell>
      {/* Shared hero header — no stat cluster (this is an upload surface, not
          a metrics view). */}
      <div className="cc-reveal">
        <DetailPageHeader
          eyebrow="Reposts · Multi-platform"
          title="Manual upload"
          subtitle="TikTok + YouTube Shorts + X (via Twitter bridge) — fan out the same mp4 to all three Buffer channels. Titles, captions, and scheduling are generated automatically."
        />
      </div>

      {/* Batch auto-schedule: drop a folder of mp4s; title + caption are
          generated from each video's transcript and fanned out automatically.
          Staggered ~0.06s after the header. The heading uses the shared
          SectionRail so its weight/rule match the home page's section rails. */}
      <section
        className="cc-reveal mt-9"
        style={{ animationDelay: "0.06s" } as React.CSSProperties}
      >
        <SectionRail label="Batch auto-schedule" />
        <p className="mb-5 mt-3 max-w-2xl text-sm text-white/55">
          Drag in a batch of videos. Each one is transcribed, gets an
          auto-generated title and a caption matched from the tweet bank, then
          is scheduled to TikTok + YouTube Shorts + X via Buffer.
        </p>
        <BatchVideoUpload />
      </section>
    </AppShell>
  );
}
