/**
 * Facebook Platform Detail Page
 *
 * Single pathway: read recent TikTok posts, generate square quote cards,
 * send them to Buffer's Facebook queue.
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
    .eq("platform", "facebook")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function FacebookPage() {
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
          <PlatformIcon platform="facebook" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Facebook</h1>
            <p className="text-sm text-muted-foreground">
              Repurpose TikTok tweets as Facebook quote cards
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="TikTok → Facebook"
        steps={[
          "Read recent TikTok posts",
          "Generate square quote images",
          "Send to Buffer (Facebook queue)",
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "facebook-pipeline" } }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
