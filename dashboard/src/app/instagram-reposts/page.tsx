/**
 * Instagram Reposts Page
 *
 * Manually-triggered tool: reads data/instagram-post-data-all.csv (sorted by
 * saves), lets the user set a batch size and optional age filter, then scrapes
 * each selected reel via Apify, transcribes it, picks a RAG caption, and
 * queues to Buffer on Instagram (alexhighlights2026).
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { parseInstagramPosts, getCsvPath } from "@/lib/instagram-posts";
import { RepostsCard } from "./reposts-card";
import type { PathwayLastRun } from "@/components/pathway-card";

export const dynamic = "force-dynamic";

async function getLastRun(): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at, posts_processed")
    .eq("platform", "instagram_2nd")
    .eq("job_type", "repost")
    .order("started_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  return {
    status: row.status as PathwayLastRun["status"],
    startedAt: row.started_at as string,
    count: (row.posts_processed as number | null) ?? 0,
  };
}

async function getRecentScheduled(): Promise<{ count7d: number; count30d: number }> {
  const supabase = getSupabaseClient();
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from("cron_runs")
    .select("posts_processed, started_at")
    .eq("platform", "instagram_2nd")
    .eq("job_type", "repost")
    .eq("status", "success")
    .gte("started_at", cutoff30);

  let count7d = 0;
  let count30d = 0;
  for (const r of data ?? []) {
    const n = (r.posts_processed as number | null) ?? 0;
    count30d += n;
    if (new Date(r.started_at as string).getTime() >= new Date(cutoff7).getTime()) {
      count7d += n;
    }
  }
  return { count7d, count30d };
}

export default async function InstagramRepostsPage() {
  const [lastRun, { count7d, count30d }] = await Promise.all([
    getLastRun(),
    getRecentScheduled(),
  ]);

  // Parse CSV server-side. Returns [] if the file is absent.
  const posts = parseInstagramPosts();
  const csvMissing = posts.length === 0;

  // Cap at 100 rows passed to client — the preview only shows ≤20 at a time.
  // Serialize Date → number (ms timestamp) for the server→client boundary.
  const previewPosts = posts.slice(0, 100).map((p) => ({
    postId: p.postId,
    permalink: p.permalink,
    saves: p.saves,
    publishTimeMs: p.publishTime.getTime(),
    postType: p.postType,
  }));

  return (
    <AppShell>
      <div className="cc-reveal">
        <DetailPageHeader
          icon={<PlatformIcon platform="instagram_2nd" className="size-8" />}
          eyebrow="Reposts · Instagram"
          title="Top Saves Reposts"
          subtitle="Resurface your best-performing reels"
          accent="#16B68A"
          stats={
            csvMissing
              ? []
              : [
                  { label: "Reposted · 7d", value: count7d },
                  { label: "Reposted · 30d", value: count30d },
                  { label: "Posts in CSV", value: posts.length },
                ]
          }
          backHref="/"
          backLabel="Command Center"
        />
      </div>

      <div className="mb-4 mt-7 cc-reveal" style={{ animationDelay: "0.06s" }}>
        {/* Pipeline metadata strip */}
        <div className="cc-surface mb-5 px-4 py-3 text-xs text-white/65">
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            <span>
              <span className="text-white/40">Schedule</span>{" "}
              <span className="font-mono">Manual — click Run below</span>
            </span>
            <span>
              <span className="text-white/40">Source</span>{" "}
              <span className="font-mono">data/instagram-post-data-all.csv</span>
            </span>
            <span>
              <span className="text-white/40">Channel</span>{" "}
              <span className="font-mono">Buffer · Instagram (alexhighlights2026)</span>
            </span>
            <span>
              <span className="text-white/40">CSV path</span>{" "}
              <span className="font-mono">{getCsvPath()}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="cc-reveal" style={{ animationDelay: "0.12s" }}>
        {csvMissing ? (
          <div className="cc-surface px-5 py-8 text-center">
            <p className="font-mono text-sm text-white/50">
              CSV not found at{" "}
              <code className="text-white/70">data/instagram-post-data-all.csv</code>
            </p>
            <p className="mt-2 text-xs text-white/35">
              Export your Instagram post data from Meta Business Suite and commit the CSV to
              enable this page.
            </p>
          </div>
        ) : (
          <RepostsCard posts={previewPosts} totalInCsv={posts.length} lastRun={lastRun} />
        )}
      </div>
    </AppShell>
  );
}
