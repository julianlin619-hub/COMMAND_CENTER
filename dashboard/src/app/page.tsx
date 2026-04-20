/**
 * Dashboard Home — platform overview.
 *
 * Visual language: warm near-black surface with terracotta accents,
 * DM Sans + JetBrains Mono typography, animated accent strip on each
 * card. Data (health, schedules, queue counts) is real — drawn from
 * Supabase and the cron schedule config, not hardcoded.
 */

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { FaLinkedinIn, FaYoutube } from "react-icons/fa6";
import { getSupabaseClient } from "@/lib/supabase";
import { CRON_SCHEDULES } from "@/lib/cron-schedule";
import { CronTestRunButton } from "@/components/cron-test-run-button";
import { PlatformOverviewCard } from "@/components/overview/platform-overview-card";
import type { OverviewStatus } from "@/components/overview/status-pill";

export const dynamic = "force-dynamic";

interface PlatformEntry {
  key: string;       // unique ID, also the route slug (/threads, /tiktok, …)
  platform: string;  // DB column value used to query posts/schedules/cron_runs
  label: string;
}

const ACTIVE_PLATFORMS: PlatformEntry[] = [
  { key: "threads", platform: "threads", label: "Threads" },
  { key: "instagram-2nd", platform: "instagram_2nd", label: "Instagram (2nd)" },
  { key: "tiktok", platform: "tiktok", label: "TikTok" },
  { key: "facebook", platform: "facebook", label: "Facebook" },
  { key: "instagram", platform: "instagram", label: "Instagram (main)" },
];

// Paused platforms show "Pending" instead of deriving from cron_runs.
const PAUSED_PLATFORMS = new Set(["instagram_2nd"]);

const INACTIVE_PLATFORMS = [
  { key: "youtube", label: "YouTube", icon: FaYoutube },
  { key: "linkedin", label: "LinkedIn", icon: FaLinkedinIn },
];

/* One-line plain-English summary of what each active platform's cron does.
   Kept in sync with cron/ + render.yaml behavior. */
const PLATFORM_SUMMARIES: Record<string, string> = {
  threads:
    "Path 1: scrapes new @AlexHormozi tweets from the past 24h via Apify\nPath 2: picks 5 random tweets from TweetMasterBank CSV",
  "instagram-2nd":
    "Paused — waiting for the new Instagram account before automation resumes.",
  tiktok:
    "Path 1: pulls @AlexHormozi outlier tweets (≥4,000 likes, past 48h) from Apify, renders branded quote-card videos\nPath 2: picks 1 tweet from TweetMasterBank (≥6,500 likes), renders branded quote-card video",
  facebook:
    "Re-uses TikTok's selected tweets from the past 48h, renders them as 1080×1080 PNG quote cards",
  instagram:
    "Mirrors TikTok Path 1 reels to Instagram — same 1080×1920 MP4s, Buffer queue on the Hormozi IG account",
};

/* Gathers per-platform overview data from Supabase: last cron status for
   health, and the count of un-picked-up scheduled posts for the Buffer
   queue pill. One row per active platform. */
async function getPlatformSummary(entry: PlatformEntry) {
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const [cronResult, bufferQueueResult] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status,started_at")
      .eq("platform", entry.platform)
      .in("job_type", ["buffer_send", "bank_send", "post"])
      .gte("started_at", cutoff)
      .order("started_at", { ascending: false })
      .limit(1),
    // Count of scheduled posts that haven't been picked up by a cron yet —
    // this is the "Scheduled to Buffer: N" pill in the card footer.
    supabase
      .from("schedules")
      .select("scheduled_for, posts!inner(platform)", {
        count: "exact",
        head: true,
      })
      .eq("posts.platform", entry.platform)
      .is("picked_up_at", null),
  ]);

  const lastRun = cronResult.data?.[0];
  const cronHealthy = !lastRun || lastRun.status !== "failed";

  let status: OverviewStatus;
  if (PAUSED_PLATFORMS.has(entry.platform)) {
    status = "pending";
  } else if (cronHealthy) {
    status = "healthy";
  } else {
    status = "failing";
  }

  const schedule = CRON_SCHEDULES[entry.platform] ?? null;

  return {
    ...entry,
    status,
    scheduleDescription: schedule?.description ?? null,
    cronExpression: schedule?.schedule ?? null,
    bufferQueue: bufferQueueResult.count ?? null,
  };
}

export default async function DashboardHome() {
  const summaries = await Promise.all(ACTIVE_PLATFORMS.map(getPlatformSummary));

  const liveCount = summaries.filter((s) => s.status === "healthy").length;
  const pausedCount = summaries.filter((s) => s.status === "pending").length;
  const failingCount = summaries.filter((s) => s.status === "failing").length;

  const statusLine = [
    `${liveCount} live`,
    pausedCount > 0 ? `${pausedCount} paused` : null,
    failingCount > 0 ? `${failingCount} failing` : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
        <header className="flex items-start justify-between mb-12">
          <div>
            <Link href="/" className="flex items-center gap-2 w-fit">
              <span className="text-[12px] font-semibold tracking-[0.22em] uppercase text-[var(--overview-fg)]/90">
                Command Center
              </span>
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{ backgroundColor: "var(--terracotta)" }}
              />
            </Link>
            <div className="flex items-center gap-2 mt-2 text-[11px] text-[var(--overview-fg)]/45 font-mono">
              <span className="inline-block h-[7px] w-[7px] rounded-full relative bg-[var(--overview-fg)]/70">
                <span
                  className="anim-heartbeat absolute inset-0 rounded-full bg-[var(--overview-fg)]/70"
                  style={{ animation: "heartbeat 4.5s ease-out infinite" }}
                />
              </span>
              <span>{statusLine}</span>
            </div>
          </div>

          <UserButton />
        </header>

        <div className="flex items-end justify-between mb-6">
          <SectionLabel tone="primary">Platforms</SectionLabel>
          <CronTestRunButton
            triggerLabel="Run all crons"
            triggerClassName="gap-1.5 text-white border-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-transform duration-100 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
            triggerStyle={{
              backgroundImage:
                "linear-gradient(180deg, var(--terracotta-hover), var(--terracotta))",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.15), 0 6px 16px -8px rgba(174,86,48,0.55), 0 2px 4px -2px rgba(0,0,0,0.3)",
            }}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {summaries.map((s, i) => (
            <Link key={s.key} href={`/${s.key}`} className="block">
              <PlatformOverviewCard
                platformKey={s.key}
                label={s.label}
                description={PLATFORM_SUMMARIES[s.key] ?? ""}
                status={s.status}
                scheduleDescription={s.scheduleDescription}
                cronExpression={s.cronExpression}
                bufferQueue={s.bufferQueue}
                index={i}
              />
            </Link>
          ))}
        </div>

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
