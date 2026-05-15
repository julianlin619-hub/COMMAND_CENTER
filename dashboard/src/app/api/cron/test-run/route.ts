/**
 * Cron Test Run API — simulate all cron jobs without side effects.
 *
 * POST /api/cron/test-run
 *
 * This endpoint walks through what each Render cron job would do if it ran
 * right now, but it never actually publishes a post, never calls external
 * APIs that cost money (Apify, Buffer), and never writes to the database
 * (no cron_runs rows, no posts rows, no schedule pickup locks).
 *
 * It's a read-only health/preview tool: it looks at what's in the DB,
 * reports "this is what each cron would pick up", and returns the summary.
 * The actual Render-scheduled cron jobs are completely untouched and will
 * run on their normal schedule.
 *
 * Auth: same dual auth as other dashboard API routes (Clerk session or
 * CRON_SECRET bearer token — see lib/auth.ts).
 */
import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

// One entry per cron job defined in render.yaml. The `kind` drives which
// read-only checks we run in the simulation:
//   - "publish":         cron just publishes due posts (youtube/instagram/tiktok_cron)
//   - "source_publish":  content sourcing + publish (threads_cron)
//   - "pipeline":        scrape/pick → render → multi-channel fan-out
//
// tiktok-pipeline and tiktok-bank-pipeline are the unified Tweet Card
// pathways: each one renders TikTok MP4 + Facebook PNG + LinkedIn PNG
// in-process and queues four Buffer channels (TikTok, Facebook,
// LinkedIn, and Instagram — Instagram reuses the Facebook PNG and
// queues as instagram_post_type='post'). There are no separate
// facebook-* or linkedin-* pipeline entries.
interface CronJob {
  platform: string;     // display key used on the home page
  dbPlatform: string;   // value stored in posts.platform / cron_runs.platform
  label: string;
  cronName: string;     // name in render.yaml
  schedule: string;     // cron expression
  kind: "publish" | "source_publish" | "pipeline";
}

const CRON_JOBS: CronJob[] = [
  {
    platform: "threads",
    dbPlatform: "threads",
    label: "Threads",
    cronName: "threads-cron",
    schedule: "0 11 * * *",
    kind: "source_publish",
  },
  {
    platform: "tiktok",
    dbPlatform: "tiktok",
    label: "Tweet Card Outlier",
    cronName: "tiktok-pipeline",
    schedule: "0 11 * * *",
    kind: "pipeline",
  },
  {
    platform: "tiktok",
    dbPlatform: "tiktok",
    label: "Tweet Card Bank",
    cronName: "tiktok-bank-pipeline",
    schedule: "15 11 * * *",
    kind: "pipeline",
  },
  {
    platform: "youtube",
    dbPlatform: "youtube",
    label: "YouTube",
    cronName: "youtube-cron",
    schedule: "0 */4 * * *",
    kind: "publish",
  },
];

// Each simulated cron returns this shape. `steps` is an ordered list of
// what would happen, and `wouldPublish` is a roll-up count for the UI.
interface SimulatedStep {
  name: string;
  description: string;
  // Non-destructive measurements of "what would this step see right now"
  detail: string;
}

interface SimulatedCron {
  platform: string;
  label: string;
  cronName: string;
  schedule: string;
  kind: CronJob["kind"];
  steps: SimulatedStep[];
  wouldPublish: number; // how many posts/items would actually go out
  note?: string;
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  const results: SimulatedCron[] = [];

  for (const job of CRON_JOBS) {
    const steps: SimulatedStep[] = [];
    let wouldPublish = 0;

    // Step common to every cron: count schedules that are due right now.
    // Mirrors core/database.py get_due_schedules() — picked_up_at IS NULL
    // AND scheduled_for <= now() — but we DO NOT call mark_schedule_picked_up
    // so real crons are unaffected.
    const { count: dueCount, error: dueErr } = await supabase
      .from("schedules")
      .select("id, posts!inner(platform)", { count: "exact", head: true })
      .eq("posts.platform", job.dbPlatform)
      .is("picked_up_at", null)
      .lte("scheduled_for", nowIso);

    if (dueErr) {
      console.error(`test-run: due schedules query failed for ${job.platform}`, dueErr.message);
    }

    if (job.kind === "publish") {
      // youtube/instagram flow:
      //   refresh_credentials() → process_due_posts() publishes each due schedule.
      steps.push({
        name: "Refresh credentials",
        description: "Ensure OAuth/API tokens are valid before posting.",
        detail: "Skipped (dry run) — would refresh if tokens were near expiry.",
      });
      steps.push({
        name: "Publish due posts",
        description: "Pick up schedules where scheduled_for <= now().",
        detail:
          (dueCount ?? 0) === 0
            ? "No posts are currently due — cron would exit with 0 processed."
            : `${dueCount} schedule(s) would be picked up and published.`,
      });
      wouldPublish = dueCount ?? 0;
    } else if (job.kind === "source_publish") {
      // threads_cron flow:
      //   Phase 0a: fetch_apify_tweets → insert_post + insert_schedule
      //   Phase 0b: select_bank_content → insert_post + insert_schedule
      //   Phase 1:  refresh_credentials → process_due_posts

      // Count existing threads posts so we can show how much of the bank
      // has already been used (proxy — exact bank size depends on the CSV).
      const { count: threadsPosts } = await supabase
        .from("posts")
        .select("id", { count: "exact", head: true })
        .eq("platform", "threads");

      steps.push({
        name: "Source from Apify (Phase 0a)",
        description: "Scrape recent tweets and create scheduled posts.",
        detail:
          "Skipped (dry run) — would call Apify, which consumes API credits.",
      });
      steps.push({
        name: "Source from content bank (Phase 0b)",
        description: "Pick random unused entries from TweetMasterBank.csv.",
        detail: `${threadsPosts ?? 0} Threads post(s) already recorded — bank entries matching these would be filtered out.`,
      });
      steps.push({
        name: "Publish due posts (Phase 1)",
        description: "Process schedules whose time has arrived.",
        detail:
          (dueCount ?? 0) === 0
            ? "No posts are currently due."
            : `${dueCount} schedule(s) would be picked up and sent to Buffer.`,
      });
      wouldPublish = dueCount ?? 0;
    } else {
      // pipeline (tiktok-pipeline, tiktok-bank-pipeline) — unified Tweet
      // Card fan-out. Both pathways now render three variants and queue
      // three Buffer channels in one process; only the source step
      // differs (Apify scrape vs. CSV bank pick).
      const sourceStep =
        job.cronName === "tiktok-bank-pipeline"
          ? {
              name: "Phase 1 — Pick bank tweet",
              description: "Select 1 random unposted tweet from data/TweetMasterBank.csv (≥ TIKTOK_BANK_MIN_LIKES).",
              detail: "Skipped (dry run) — would read the CSV in-process; no external API calls.",
            }
          : {
              name: "Phase 1 — Fetch outlier tweets (Apify)",
              description: "Scrape latest TIKTOK_MAX_ITEMS @AlexHormozi tweets above TIKTOK_MIN_LIKES.",
              detail: "Skipped (dry run) — would call Apify, which consumes API credits.",
            };
      steps.push(sourceStep);
      steps.push({
        name: "Phase 2 — Per-platform dedup",
        description: "Filter out captions already present as TikTok posts.",
        detail: "Skipped (dry run) — runs in-memory against the scraped/picked batch.",
      });
      steps.push({
        name: "Phase 3a — Render TikTok MP4",
        description: "POST /api/content-gen/generate with platform=tiktok for 1080×1920 MP4 videos.",
        detail: "Skipped (dry run) — would CPU-render and upload to Supabase Storage.",
      });
      steps.push({
        name: "Phase 3b — Render Facebook PNG",
        description: "POST /api/content-gen/generate with platform=facebook for 1080×1080 PNG quote cards.",
        detail: "Skipped (dry run) — non-fatal: empty result skips the FB leg per tweet.",
      });
      steps.push({
        name: "Phase 3c — Render LinkedIn PNG",
        description: "POST /api/content-gen/generate with platform=linkedin (LinkedIn color overrides).",
        detail: "Skipped (dry run) — non-fatal: empty result skips the LI leg per tweet.",
      });
      steps.push({
        name: "Phase 4 — Fan out to Buffer",
        description: "Per tweet: send TikTok video, then Facebook PNG, then LinkedIn PNG, then Instagram feed post (reuses the FB PNG). Caption: 'Agree?'.",
        detail: "Skipped (dry run) — would call Buffer up to 4× per tweet and insert posts with status=sent_to_buffer.",
      });
    }

    results.push({
      platform: job.platform,
      label: job.label,
      cronName: job.cronName,
      schedule: job.schedule,
      kind: job.kind,
      steps,
      wouldPublish,
    });
  }

  return NextResponse.json({
    dryRun: true,
    simulatedAt: nowIso,
    note:
      "Read-only simulation. No posts were published, no Apify/Buffer calls were made, " +
      "and no rows were inserted or updated in posts, schedules, or cron_runs. " +
      "The real Render cron jobs are unaffected and will run on their normal schedule.",
    results,
  });
}
