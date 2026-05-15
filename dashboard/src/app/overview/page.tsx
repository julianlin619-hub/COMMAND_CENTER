/**
 * Overview — legacy platform-centric home.
 *
 * Preserved here while the new format-centric Command Center (at `/`) is
 * being trialed. Same page that previously lived at `/`: a grid of
 * per-platform queue/health cards backed by Supabase. Remove this route
 * (and the toggle link on the Command Center) once the new UI is fully
 * adopted.
 */
import { FaYoutube } from "react-icons/fa6";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSupabaseClient } from "@/lib/supabase";
import { CRON_SCHEDULES } from "@/lib/cron-schedule";
import { CreatorTabs, type PlatformSummary } from "@/components/creator-tabs";
import type { OverviewStatus } from "@/components/overview/status-pill";

export const dynamic = "force-dynamic";

interface PlatformEntry {
  key: string;
  creator: "alex" | "leila";
  platform: string;
  label: string;
  href?: string;
  placeholder?: boolean;
}

// TikTok / Facebook / LinkedIn / Instagram (main) used to be standalone
// platforms here, each with its own detail page and cron. They were
// consolidated into the Tweet Cards fan-out (`/tweet-cards`) and their
// detail pages + crons were removed — listing them here would render
// dead links (no `href` override → falls back to `/${key}` → 404) and
// phantom countdowns (CRON_SCHEDULES still has stale facebook/instagram
// entries). They're omitted on purpose; users find them via the
// `Tweet Cards` card on the new Command Center home.
const ACTIVE_PLATFORMS: PlatformEntry[] = [
  { key: "threads", creator: "alex", platform: "threads", label: "Threads" },
  { key: "instagram-2nd", creator: "alex", platform: "instagram_2nd", label: "Instagram (2nd)" },
  { key: "youtube", creator: "alex", platform: "youtube", label: "YouTube" },
  {
    key: "youtube-second",
    creator: "alex",
    platform: "youtube_second",
    label: "YouTube (2nd)",
    href: "/youtube-second",
  },
  {
    key: "leila-threads",
    creator: "leila",
    platform: "threads_leila",
    label: "Threads",
    href: "/leila/threads",
  },
  {
    key: "leila-linkedin",
    creator: "leila",
    platform: "linkedin_leila",
    label: "LinkedIn",
    href: "/leila/linkedin",
  },
];

const PAUSED_PLATFORMS = new Set<string>([]);
const INACTIVE_PLATFORMS: { key: string; label: string; icon: typeof FaYoutube }[] = [];

const PLATFORM_SUMMARIES: Record<string, string> = {
  threads: "",
  "instagram-2nd": "",
  "youtube-second": "",
  youtube: "",
  "leila-threads": "",
  "leila-linkedin": "",
};

// See the original home page commit history for the rationale behind
// counting `sent_to_buffer` + `published` posts in the last 24h as a
// queue-depth proxy — it covers both pipeline shapes (Threads publishes
// directly, everything else dwells in Buffer).
async function getPlatformSummary(entry: PlatformEntry): Promise<PlatformSummary> {
  if (entry.placeholder) {
    return {
      key: entry.key,
      creator: entry.creator,
      label: entry.label,
      description: PLATFORM_SUMMARIES[entry.key] ?? "",
      status: "paused",
      scheduleDescription: null,
      cronExpression: null,
      paused: true,
      queueCount: 0,
      href: entry.href,
    };
  }

  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const queueSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [cronResult, queueResult] = await Promise.all([
    supabase
      .from("cron_runs")
      .select("status,started_at")
      .eq("platform", entry.platform)
      .in("job_type", ["buffer_send", "bank_send", "post"])
      .gte("started_at", cutoff)
      .order("started_at", { ascending: false })
      .limit(1),
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("platform", entry.platform)
      .in("status", ["sent_to_buffer", "published"])
      .gte("created_at", queueSince),
  ]);

  const lastRun = cronResult.data?.[0];
  const cronHealthy = !lastRun || lastRun.status !== "failed";
  const schedule = CRON_SCHEDULES[entry.platform] ?? null;
  const paused = schedule?.paused === true;

  let status: OverviewStatus;
  if (paused) {
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
    cronExpression: paused ? null : (schedule?.schedule ?? null),
    paused,
    queueCount: queueResult.count ?? 0,
    href: entry.href,
  };
}

export default async function OverviewPage() {
  const summaries = await Promise.all(ACTIVE_PLATFORMS.map(getPlatformSummary));

  return (
    <div
      className="relative min-h-screen"
      style={{
        color: "var(--foreground)",
        backgroundColor: "var(--background)",
      }}
    >
      <div className="mx-auto max-w-[1100px] px-6 py-10">
        {/* Back to the new UI. Temporary affordance while the new
            Command Center is being trialed. */}
        <div className="mb-6">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-[12px] text-white/55 transition-colors hover:text-white/90"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Back to Command Center
          </Link>
        </div>

        <CreatorTabs summaries={summaries} />

        {INACTIVE_PLATFORMS.length > 0 && (
          <div className="mt-12">
            <SectionLabel tone="muted">Coming soon</SectionLabel>
            <div className="mt-6 grid grid-cols-1 gap-5 opacity-55 md:grid-cols-2">
              {INACTIVE_PLATFORMS.map((p) => {
                const Icon = p.icon;
                return (
                  <div
                    key={p.key}
                    className="rounded-xl border px-5 py-4"
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
        className={`text-[11px] font-medium uppercase tracking-[0.18em] ${
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
