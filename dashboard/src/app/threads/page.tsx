/**
 * Threads Platform Detail Page
 *
 * Shows monitoring dashboard and manual controls for the Threads workflow:
 * content sourcing (Apify) and publishing (Buffer).
 */

import { getSupabaseClient } from "@/lib/supabase";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";
import { PathwayCard, type PathwayLastRun } from "@/components/pathway-card";
import { DetailPageHeader } from "@/components/command-center/detail-page-header";
import { CATEGORY_COLORS } from "@/lib/command-center-config";

export const dynamic = "force-dynamic";

async function getLastRun(jobType: string): Promise<PathwayLastRun | null> {
  const supabase = getSupabaseClient();
  // posts_processed is what each pathway records as "how many items did
  // this phase produce" — for Threads, content_apify/content_bank both
  // insert directly into the posts table, so this is the per-pathway
  // output count we want to display.
  const { data } = await supabase
    .from("cron_runs")
    .select("status, started_at, posts_processed")
    .eq("platform", "threads")
    .eq("job_type", jobType)
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

// `pathway` filters which PathwayCard renders so the Command Center can
// deep-link directly into a single workflow:
//   /threads?pathway=crosspost → just X Cross-Post (Pathway 1)
//   /threads?pathway=bank      → just X Bank-Post (Pathway 2)
//   /threads (no param)        → both, legacy behavior
type PathwayFilter = "crosspost" | "bank" | "all";

function parsePathway(value: string | string[] | undefined): PathwayFilter {
  if (value === "crosspost" || value === "bank") return value;
  return "all";
}

export default async function ThreadsPage({
  searchParams,
}: {
  // Next 15+: searchParams is async. We await it before reading keys.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const pathway = parsePathway(params.pathway);
  const showCrosspost = pathway === "all" || pathway === "crosspost";
  const showBank = pathway === "all" || pathway === "bank";
  const isFiltered = pathway !== "all";

  // Only fetch the run history for pathways we're going to render. The
  // queries are cheap, but skipping the unused one keeps the page honest
  // about what it's showing.
  const [apifyLast, bankLast] = await Promise.all([
    showCrosspost ? getLastRun("content_apify") : Promise.resolve(null),
    showBank ? getLastRun("content_bank") : Promise.resolve(null),
  ]);

  // When the page is filtered to a single pathway (the Command Center
  // deep-link case), the header reflects the *format* the user clicked —
  // "Crosspost" / "Bank Post" with the Written category's color rail —
  // instead of the generic platform "Threads" header. This makes the
  // detail page feel like a continuation of the Command Center card,
  // not a separate platform-centric screen.
  const writtenColor = CATEGORY_COLORS.written;
  const formatTitle =
    pathway === "crosspost" ? "Crosspost" : pathway === "bank" ? "Bank Post" : "Threads";
  const formatSubtitle =
    pathway === "crosspost"
      ? "Text syndication · X → Threads"
      : pathway === "bank"
        ? "Tweet bank syndication · CSV → Threads"
        : "Content sourcing and publishing";

  return (
    <AppShell>
      {/* One shared header drives both modes. When deep-linked to a single
          pathway (the Command Center card case) the header wears the Written
          category color and drops the period so it reads as a continuation of
          the card the user clicked; the unfiltered /threads visit keeps the
          platform icon and the default terracotta period. Both go through the
          same component now instead of two hand-rolled header branches. */}
      <div className="cc-reveal">
        <DetailPageHeader
          accent={isFiltered ? writtenColor : "var(--terracotta)"}
          titlePeriod={!isFiltered}
          icon={isFiltered ? undefined : <PlatformIcon platform="threads" className="size-8" />}
          eyebrow={isFiltered ? "Written · Threads" : "Platform"}
          title={formatTitle}
          subtitle={formatSubtitle}
        />
      </div>

      {/* Context band — schedule/account/channel + dedup notes. Promoted to
          the shared .cc-surface card family so it reads as the same surface
          as the home page tiles instead of a one-off hand-rolled box. */}
      <div
        className="cc-surface mb-5 mt-7 px-4 py-3 text-[12px] text-white/70 cc-reveal"
        style={{ animationDelay: "0.06s" }}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <span>
            <span className="text-white/40">Schedule</span>{" "}
            <span className="font-mono">Daily · 04:00 AM PDT (11:00 UTC)</span>
          </span>
          <span>
            <span className="text-white/40">Account</span>{" "}
            <span className="font-mono">@AlexHormozi</span>
          </span>
          <span>
            <span className="text-white/40">Channel</span>{" "}
            <span className="font-mono">Buffer · Threads</span>
          </span>
        </div>
        <p className="mt-2 text-white/45">
          {isFiltered
            ? "This pathway dedups by caption text against the "
            : "Both pathways dedup by caption text against the "}
          <code className="font-mono">posts</code> table, insert as{" "}
          <code className="font-mono">scheduled</code>, then Phase&nbsp;1 immediately publishes them via Buffer.
        </p>
      </div>

      {showCrosspost && (
        <div className="cc-reveal" style={{ animationDelay: "0.12s" }}>
        <PathwayCard
          // Hide the "Pathway 1" badge when this is the only card on the
          // page — the badge is only meaningful when there's also a Pathway 2
          // to disambiguate against.
          number={isFiltered ? undefined : 1}
          title="X Cross-Post"
          steps={[
            "Scrape new @AlexHormozi tweets from the past 24h via Apify (apidojo~tweet-scraper actor, up to 50 items, sorted Latest)",
            "Skip any whose caption text already exists in the posts table (dedup)",
            "Insert each as a scheduled Threads post (now), then publish to Buffer's Threads channel",
          ]}
          actions={[
            { url: "/api/threads/source" },
            { url: "/api/threads/publish" },
          ]}
          lastRun={apifyLast}
        />
        </div>
      )}

      {showBank && (
        <div className="cc-reveal" style={{ animationDelay: "0.18s" }}>
        <PathwayCard
          number={isFiltered ? undefined : 2}
          title="X Bank-Post"
          steps={[
            "Pick up to 24 random unposted entries from data/TweetMasterBank.csv (configurable via CONTENT_BANK_COUNT)",
            "Skip any whose caption text already exists in the posts table (dedup)",
            "Insert each as a scheduled Threads post (now), then publish to Buffer's Threads channel",
          ]}
          actions={[
            { url: "/api/threads/bank" },
            { url: "/api/threads/publish" },
          ]}
          lastRun={bankLast}
        />
        </div>
      )}
    </AppShell>
  );
}
