/**
 * Dashboard Home — platform overview.
 *
 * Visual language: warm near-black surface with terracotta accents,
 * DM Sans + JetBrains Mono typography, animated accent strip on each
 * card. Data (health, schedules, queue counts) is real — drawn from
 * Supabase and the cron schedule config, not hardcoded.
 */

import { FaYoutube } from "react-icons/fa6";
import { getSupabaseClient } from "@/lib/supabase";
import { CRON_SCHEDULES } from "@/lib/cron-schedule";
import { CreatorTabs, type PlatformSummary } from "@/components/creator-tabs";
import type { OverviewStatus } from "@/components/overview/status-pill";

export const dynamic = "force-dynamic";

/* How the footer "Buffer" count should be computed for a given platform.
   - sent_recent: count posts whose status is in `statuses` (default
     ["sent_to_buffer"]), created within the last N hours. Works for both
     direct-send pipelines (status ends at 'sent_to_buffer') and scheduler
     pipelines that flip status to 'published' after publishing (Threads).
   - hidden: the pill is omitted entirely (paused platforms, YouTube drafts). */
type BufferMetric =
  | { kind: "sent_recent"; hours: number; statuses?: string[] }
  | { kind: "hidden" };

// Window for the "Sent to Buffer" count on platform cards. Tune here.
const BUFFER_WINDOW_HOURS = 24;

interface PlatformEntry {
  key: string;       // unique ID, also the default route slug (/threads, /tiktok, …)
  creator: "alex" | "leila";
  platform: string;  // DB column value used to query posts/schedules/cron_runs
  label: string;
  href?: string;     // optional override for the card link
  bufferMetric: BufferMetric;
  // True for cards whose pipeline isn't wired yet — skip DB queries and
  // render a synthetic "pending" summary so the card stays informative
  // without crashing on a missing platform_enum value.
  placeholder?: boolean;
}

const ACTIVE_PLATFORMS: PlatformEntry[] = [
  {
    key: "threads",
    creator: "alex",
    platform: "threads",
    label: "Threads",
    // Threads is scheduler-based but the same cron run immediately picks up
    // the schedule and publishes, flipping status to 'published'. So the
    // "unpicked schedules" count is ~always 0 — we count recently published
    // Threads posts instead, which reflects actual throughput.
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS, statuses: ["published"] },
  },
  {
    key: "instagram-2nd",
    creator: "alex",
    platform: "instagram_2nd",
    label: "Instagram (2nd)",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "tiktok",
    creator: "alex",
    platform: "tiktok",
    label: "TikTok",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "facebook",
    creator: "alex",
    platform: "facebook",
    label: "Facebook",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "linkedin",
    creator: "alex",
    platform: "linkedin",
    label: "LinkedIn",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "instagram",
    creator: "alex",
    platform: "instagram",
    label: "Instagram (main)",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "youtube",
    creator: "alex",
    platform: "youtube",
    label: "YouTube",
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
  {
    key: "youtube-second",
    creator: "alex",
    platform: "youtube_second",
    label: "YouTube (2nd)",
    href: "/youtube-second",
    bufferMetric: { kind: "hidden" },
  },
  {
    key: "leila-threads",
    creator: "leila",
    platform: "threads_leila",
    label: "Threads",
    href: "/leila/threads",
    // Same shape as Alex's threads — the cron immediately publishes via
    // Buffer, so we count published rows in the recent window for throughput.
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS, statuses: ["published"] },
  },
  {
    key: "leila-linkedin",
    creator: "leila",
    platform: "linkedin_leila",
    label: "LinkedIn",
    href: "/leila/linkedin",
    // Direct-send pipeline (status terminates at "sent_to_buffer", same as
    // Alex's Facebook/LinkedIn flows). Default `statuses` is fine.
    bufferMetric: { kind: "sent_recent", hours: BUFFER_WINDOW_HOURS },
  },
];

// Paused platforms show "Pending" instead of deriving from cron_runs.
const PAUSED_PLATFORMS = new Set<string>([]);

const INACTIVE_PLATFORMS: { key: string; label: string; icon: typeof FaYoutube }[] = [];

/* One-line plain-English summary of what each active platform's cron does.
   Kept in sync with cron/ + render.yaml behavior. */
const PLATFORM_SUMMARIES: Record<string, string> = {
  threads:
    "Path 1: scrapes new @AlexHormozi tweets from the past 24h via Apify\nPath 2: picks 5 random tweets from TweetMasterBank CSV",
  "instagram-2nd":
    "Picks tweets from TweetMasterBank, renders branded quote-card 5s reels (PNG → MP4), schedules to the alexhighlights2026 IG via Buffer.",
  tiktok:
    "Path 1: pulls @AlexHormozi outlier tweets (≥4,000 likes, past 48h) from Apify, renders branded quote-card videos\nPath 2: picks 1 tweet from TweetMasterBank (≥6,500 likes), renders branded quote-card video\nPath 3: manual upload — pick an mp4, fans out to Buffer's TikTok + YouTube Shorts queues (user-triggered from /tiktok)",
  facebook:
    "Re-uses TikTok's selected tweets from the past 48h, renders them as 1080×1080 PNG quote cards",
  linkedin:
    "Re-queues Facebook's already-rendered quote cards (same 1080×1080 PNGs) on the LinkedIn channel — no re-render",
  instagram:
    "Mirrors TikTok Path 1 reels to Instagram — same 1080×1920 MP4s, Buffer queue on the Hormozi IG account",
  "youtube-second":
    "Studio-first — bulk-upload drafts manually, daily cron (10 UTC) schedules the 10 earliest into fixed publish slots.",
  youtube:
    "Queued via the TikTok Manual Upload dialog on /tiktok — the same mp4 fans out to Buffer's YouTube Shorts channel, Buffer picks the slot.",
  "leila-threads":
    "Pulls @LeilaHormozi tweets from the past 24h via Apify (max 5/day, no engagement filter), schedules verbatim to Buffer's Leila Threads channel.",
  "leila-linkedin":
    "Pulls @LeilaHormozi tweets from the past 24h via Apify (72h fallback if quiet), renders each into a 1080×1080 quote card using Alex's template, and queues to Buffer's Leila LinkedIn channel with caption \"Agree?\".",
};

/* Computes the footer "Buffer" count + label for one platform.
   sent_recent → counts posts in one of `statuses` (default sent_to_buffer)
   created within the last `hours` window. hidden → returns null so the card
   suppresses the pill. */
async function getBufferQueue(
  entry: PlatformEntry,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<{ count: number | null; label: string | undefined }> {
  const metric = entry.bufferMetric;

  if (metric.kind === "hidden") {
    return { count: null, label: undefined };
  }

  const statuses = metric.statuses ?? ["sent_to_buffer"];
  const since = new Date(Date.now() - metric.hours * 3600_000).toISOString();
  const { count } = await supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("platform", entry.platform)
    .in("status", statuses)
    .gte("created_at", since);
  return { count: count ?? 0, label: `Sent to Buffer (${metric.hours}h)` };
}

/* Gathers per-platform overview data from Supabase: last cron status for
   health, and a pipeline-shape-aware count for the Buffer queue pill.
   Placeholder entries skip every query and return a synthetic "pending"
   summary so unwired creators (e.g., Leila's LinkedIn) don't fail on
   missing platform_enum values. */
async function getPlatformSummary(entry: PlatformEntry): Promise<PlatformSummary> {
  if (entry.placeholder) {
    // Treat unwired creator cards as "paused" — semantically distinct from
    // "pending" (which means "waiting on first cron run"). Reuses the
    // existing paused styling so the card shows "Paused" in the pill and
    // skips the countdown; the description carries the "coming soon" copy.
    return {
      key: entry.key,
      creator: entry.creator,
      label: entry.label,
      description: PLATFORM_SUMMARIES[entry.key] ?? "",
      status: "paused",
      scheduleDescription: null,
      cronExpression: null,
      paused: true,
      bufferQueue: null,
      bufferQueueLabel: undefined,
      href: entry.href,
    };
  }

  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const [cronResult, bufferQueue] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status,started_at")
      .eq("platform", entry.platform)
      .in("job_type", ["buffer_send", "bank_send", "post"])
      .gte("started_at", cutoff)
      .order("started_at", { ascending: false })
      .limit(1),
    getBufferQueue(entry, supabase),
  ]);

  const lastRun = cronResult.data?.[0];
  const cronHealthy = !lastRun || lastRun.status !== "failed";
  const schedule = CRON_SCHEDULES[entry.platform] ?? null;
  const paused = schedule?.paused === true;

  let status: OverviewStatus;
  if (paused) {
    // Paused trumps health derived from cron_runs — the cron isn't firing,
    // so an old success/failure row would be misleading.
    status = "paused";
  } else if (PAUSED_PLATFORMS.has(entry.platform)) {
    status = "pending";
  } else if (cronHealthy) {
    status = "healthy";
  } else {
    status = "failing";
  }

  return {
    key: entry.key,
    creator: entry.creator,
    label: entry.label,
    description: PLATFORM_SUMMARIES[entry.key] ?? "",
    status,
    scheduleDescription: schedule?.description ?? null,
    // Hide the live countdown when paused — the cron isn't actually due
    // at that time, and the card's "Paused" pill already conveys why.
    cronExpression: paused ? null : (schedule?.schedule ?? null),
    paused,
    bufferQueue: bufferQueue.count,
    bufferQueueLabel: bufferQueue.label,
    href: entry.href,
  };
}

export default async function DashboardHome() {
  const summaries = await Promise.all(ACTIVE_PLATFORMS.map(getPlatformSummary));

  return (
    <div
      className="relative min-h-screen"
      style={{ color: "var(--overview-fg)" }}
    >
      {/* Ambient terracotta radial gradient — kills the flat-black look
          without reading as explicit decoration. Fixed so it doesn't
          scroll with content. */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          backgroundColor: "var(--overview-bg)",
          backgroundImage:
            "radial-gradient(ellipse 1400px 700px at 50% -10%, rgba(174,86,48,0.08), transparent 60%), radial-gradient(ellipse 800px 500px at 90% 10%, rgba(174,86,48,0.03), transparent 55%)",
        }}
      />

      <div className="max-w-[1100px] mx-auto px-6 py-10">
        <CreatorTabs summaries={summaries} />

        {INACTIVE_PLATFORMS.length > 0 && (
          <div className="mt-12">
            <SectionLabel tone="muted">Coming soon</SectionLabel>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6 opacity-55">
              {INACTIVE_PLATFORMS.map((p) => {
                const Icon = p.icon;
                return (
                  <div
                    key={p.key}
                    className="rounded-xl px-5 py-4 border"
                    style={{
                      backgroundColor: "rgba(255,255,255,0.015)",
                      borderColor: "rgba(255,255,255,0.06)",
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon
                        className="h-[15px] w-[15px]"
                        style={{ color: "rgba(237,234,224,0.55)" }}
                      />
                      <span className="text-[14px] font-medium text-[var(--overview-fg)]/70">
                        {p.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "primary" | "muted";
}) {
  const primary = tone === "primary";
  return (
    <div className="flex items-center gap-3">
      <span
        className="h-5 w-[3px] rounded-full"
        style={{
          backgroundColor: "var(--terracotta)",
          opacity: primary ? 1 : 0.35,
        }}
      />
      <span
        className={`text-[11px] font-medium tracking-[0.18em] uppercase ${
          primary
            ? "text-[var(--overview-fg)]/75"
            : "text-[var(--overview-fg)]/40"
        }`}
      >
        {children}
      </span>
    </div>
  );
}
