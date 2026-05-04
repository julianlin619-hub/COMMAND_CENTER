/**
 * Leila — LinkedIn Platform Detail Page
 *
 * Single pathway: Apify-source @LeilaHormozi tweets → render 1080×1080 quote
 * cards (Alex's Facebook template, reused) → queue on Buffer's Leila LinkedIn
 * channel with caption "Agree?". The cron (linkedin-leila-cron) drives all
 * three phases sequentially in one invocation.
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";

export const dynamic = "force-dynamic";

async function getLatestRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  // Latest run regardless of job_type — content_apify, content_generate,
  // and buffer_send all fire sequentially in one cron invocation, and a
  // failure in any of the three should surface here.
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at")
    .eq("platform", "linkedin_leila")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
  };
}

export default async function LeilaLinkedInPage() {
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
            <h1 className="text-xl font-semibold">Leila — LinkedIn</h1>
            <p className="text-sm text-muted-foreground">
              Quote-card images from recent @LeilaHormozi tweets
            </p>
          </div>
        </div>
      </div>

      <PathwayCard
        number={1}
        title="Apify → Render → LinkedIn"
        steps={[
          "Fetch up to 5 recent @LeilaHormozi tweets via Apify (24h window, 72h fallback)",
          "Dedupe against existing posts (platform=linkedin_leila)",
          "Render each tweet into a 1080×1080 quote card (Alex's template) and upload to Storage",
          'Send each image to Buffer\'s Leila LinkedIn channel with caption "Agree?"',
        ]}
        actions={[{ url: "/api/cron/run", body: { job: "linkedin-leila-cron" } }]}
        lastRun={lastRun}
      />
    </AppShell>
  );
}
