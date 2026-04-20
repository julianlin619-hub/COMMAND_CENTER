/**
 * Instagram (2nd) Platform Detail Page
 *
 * Tweet-to-Instagram pipeline: pick tweets from the CSV bank, generate
 * PNG/MP4 media, schedule to Instagram via Zernio.
 */

import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { ArrowLeftIcon } from "lucide-react";

export const dynamic = "force-dynamic";

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "instagram_2nd")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function InstagramSecondPage() {
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
          <PlatformIcon platform="instagram_2nd" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Instagram (2nd)</h1>
            <p className="text-sm text-muted-foreground">
              Tweet-to-Instagram pipeline
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="Bank → Instagram reel"
        steps={[
          "Pick tweets from the CSV bank",
          "Generate PNG images and MP4 videos",
          "Schedule to Instagram via Zernio",
        ]}
        actions={[
          { url: "/api/ig-pipeline/pick" },
          { url: "/api/ig-pipeline/generate" },
          { url: "/api/ig-pipeline/schedule" },
        ]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
