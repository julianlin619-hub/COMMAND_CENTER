/**
 * Cron Jobs Page — two tabs: upcoming scheduled runs and recent (48h) history.
 *
 * Server component fetches data from Supabase, then hands it to a client
 * component that handles the interactive tab switching.
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { CronLogsTabs } from "./cron-logs-tabs";

export const dynamic = "force-dynamic";

export default async function CronLogsPage() {
  const supabase = getSupabaseClient();

  // Only fetch runs from the last 48 hours
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: runs } = await supabase
    .from("cron_runs")
    .select("*")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false });

  return (
    <AppShell>
      <div className="mb-6">
        <h2 className="text-lg font-medium">Cron Jobs</h2>
        <p className="text-sm text-muted-foreground">
          Scheduled jobs and recent execution history
        </p>
      </div>
      <CronLogsTabs recentRuns={runs || []} />
    </AppShell>
  );
}
