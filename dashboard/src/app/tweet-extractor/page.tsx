/**
 * Tweet Extractor — local-media transcriber.
 *
 * Point it at a local video/audio file (or paste a transcript) and it returns a
 * full transcript with an optional timestamped sentence view, ready to copy out.
 *
 * Tweet extraction itself is temporarily paused on the dashboard — it now lives
 * as a Claude skill on desktop, so this page just produces the transcript you
 * feed to that skill. Nothing is stored or published.
 *
 * Server component shell (header + atmosphere); the form and results are a
 * "use client" island since they need state, fetch, and the clipboard.
 */

import { AppShell } from "@/components/app-shell";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { TweetExtractorClient } from "./tweet-extractor-client";

export const dynamic = "force-dynamic";

export default function TweetExtractorPage() {
  return (
    <AppShell>
      <div className="cc-reveal">
        <DetailPageHeader
          eyebrow="Written Format"
          title="Tweet Extractor"
          subtitle="Point it at a local video to transcribe it (or paste a transcript), then copy it out. Tweet extraction is temporarily paused here — it now lives as a Claude skill on desktop."
        />
      </div>

      <div className="cc-reveal mt-7" style={{ animationDelay: "0.06s" }}>
        <TweetExtractorClient />
      </div>
    </AppShell>
  );
}
