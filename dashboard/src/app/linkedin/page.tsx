/**
 * LinkedIn Platform Detail Page
 *
 * Pathway 1: read recent Facebook posts (already-rendered quote cards) and
 * re-queue the same PNGs on Buffer's LinkedIn channel — no re-render.
 * Pathway 2: user-triggered manual mp4 upload, queued on Buffer's LinkedIn
 * channel via /api/linkedin/manual-upload.
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { LinkedInManualUploadPathway } from "@/components/linkedin-manual-upload-pathway";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "linkedin")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function LinkedInPage() {
  const lastRun = await getLatestRun();

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
          <PlatformIcon platform="linkedin" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">LinkedIn</h1>
            <p className="text-sm text-muted-foreground">
              Facebook quote-card requeues + manual mp4 uploads
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="Facebook → LinkedIn"
        steps={[
          "Read recent Facebook posts",
          "Send same images to Buffer (LinkedIn queue)",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "linkedin-pipeline" } }]}
        lastRun={lastRun}
      />

      <LinkedInManualUploadPathway number={2} />
    </AppShell>
  );
}
