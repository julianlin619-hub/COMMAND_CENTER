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
//   - "publish":    cron just publishes due posts (youtube/linkedin/instagram/tiktok_cron)
//   - "source_publish": content sourcing + publish (threads_cron)
//   - "pipeline":   scrape → generate → send to Buffer (tiktok_pipeline, facebook_pipeline)
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
    label: "TikTok Pipeline",
    cronName: "tiktok-pipeline",
    schedule: "0 12 * * *",
    kind: "pipeline",
  },
  {
    platform: "tiktok",
    dbPlatform: "tiktok",
    label: "TikTok Bank",
    cronName: "tiktok-bank-pipeline",
    schedule: "0 14 * * *",
    kind: "pipeline",
  },
  {
    platform: "facebook",
    dbPlatform: "facebook",
    label: "Facebook Pipeline",
    cronName: "facebook-pipeline",
    schedule: "0 13 * * *",
    kind: "pipeline",
  },
  {
    platform: "instagram",
    dbPlatform: "instagram",
    label: "Instagram Pipeline",
    cronName: "instagram-pipeline",
    schedule: "30 13 * * *",
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
  {
    platform: "linkedin",
    dbPlatform: "linkedin",
    label: "LinkedIn Pipeline",
    cronName: "linkedin-pipeline",
    schedule: "0 12 * * *",
    kind: "pipeline",
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
  // 48-hour window matches facebook_pipeline.py's recent-TikTok lookback
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

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
      // youtube/instagram/linkedin/tiktok_cron flow:
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
      // pipeline (tiktok_pipeline, facebook_pipeline)
      if (job.platform === "tiktok") {
        // Phase 1: fetch_apify_tweets (skipped)
        // Phase 2: dedup against existing tiktok posts
        // Phase 3: POST /api/content-gen/generate → PNG + MP4 (skipped)
        // Phase 4: send_to_buffer (skipped)
        steps.push({
          name: "Phase 1 — Fetch outlier tweets (Apify)",
          description: "Scrape viral tweets above the like threshold.",
          detail: "Skipped (dry run) — would call Apify with TIKTOK_MIN_LIKES filter.",
        });
        steps.push({
          name: "Phase 2 — Dedup",
          description: "Filter out tweets already present as TikTok posts.",
          detail: "Skipped (dry run) — runs in-memory against the scraped batch.",
        });
        steps.push({
          name: "Phase 3 — Generate videos",
          description: "Render PNG + MP4 via the dashboard's /api/content-gen/generate route.",
          detail: "Skipped (dry run) — would write files to exports/ and Supabase Storage.",
        });
        steps.push({
          name: "Phase 4 — Send to Buffer",
          description: "Queue each video on the TikTok channel.",
          detail: "Skipped (dry run) — would call Buffer and insert posts with status=sent_to_buffer.",
        });
      } else if (job.platform === "linkedin") {
        // linkedin_pipeline: read recent Facebook posts (last 48h,
        // status=sent_to_buffer), dedup against LinkedIn, requeue same
        // media on Buffer's LinkedIn channel. No content-gen call.
        const { data: recentFb } = await supabase
          .from("posts")
          .select("id, caption")
          .eq("platform", "facebook")
          .eq("status", "sent_to_buffer")
          .gte("created_at", cutoff48h);

        let candidateCount = 0;
        if (recentFb && recentFb.length > 0) {
          const captions = recentFb
            .map((p) => p.caption)
            .filter((c): c is string => !!c);
          if (captions.length > 0) {
            const { data: existingLi } = await supabase
              .from("posts")
              .select("caption")
              .eq("platform", "linkedin")
              .in("caption", captions);
            const existing = new Set(
              (existingLi ?? [])
                .map((p) => p.caption)
                .filter((c): c is string => !!c),
            );
            candidateCount = captions.filter((c) => !existing.has(c)).length;
          }
        }

        steps.push({
          name: "Phase 1 — Read recent Facebook posts",
          description: "Pull posts.platform=facebook from the last 48h, dedup against LinkedIn.",
          detail: `${recentFb?.length ?? 0} recent Facebook post(s) found; ${candidateCount} would become LinkedIn candidates after dedup.`,
        });
        steps.push({
          name: "Phase 2 — Send to Buffer",
          description: "Queue each image on the LinkedIn channel with caption='Agree?' — reuses the Facebook storage path, no re-render.",
          detail: "Skipped (dry run) — would call Buffer and insert posts with status=sent_to_buffer.",
        });
        wouldPublish = candidateCount;
      } else {
        // facebook_pipeline
        // Phase 1: read recent TikTok posts from DB (last 48h, status=sent_to_buffer),
        //          then filter out any caption already on facebook
        const { data: recentTiktok } = await supabase
          .from("posts")
          .select("id, caption")
          .eq("platform", "tiktok")
          .eq("status", "sent_to_buffer")
          .gte("created_at", cutoff48h);

        let candidateCount = 0;
        if (recentTiktok && recentTiktok.length > 0) {
          // Mirror post_caption_exists dedup: skip anything already on facebook
          const captions = recentTiktok
            .map((p) => p.caption)
            .filter((c): c is string => !!c);
          if (captions.length > 0) {
            const { data: existingFb } = await supabase
              .from("posts")
              .select("caption")
              .eq("platform", "facebook")
              .in("caption", captions);
            const existing = new Set(
              (existingFb ?? [])
                .map((p) => p.caption)
                .filter((c): c is string => !!c),
            );
            candidateCount = captions.filter((c) => !existing.has(c)).length;
          }
        }

        steps.push({
          name: "Phase 1 — Read recent TikTok posts",
          description: "Pull posts.platform=tiktok posted in the last 48h, dedup against Facebook.",
          detail: `${recentTiktok?.length ?? 0} recent TikTok post(s) found; ${candidateCount} would become Facebook candidates after dedup.`,
        });
        steps.push({
          name: "Phase 2 — Generate square images",
          description: "POST to /api/content-gen/generate with platform=facebook for 1080x1080 PNGs.",
          detail: "Skipped (dry run) — would CPU-render PNGs and upload to Supabase Storage.",
        });
        steps.push({
          name: "Phase 3 — Send to Buffer",
          description: "Queue each image on the Facebook channel with caption='Agree?'.",
          detail: "Skipped (dry run) — would call Buffer and insert posts with status=sent_to_buffer.",
        });
        wouldPublish = candidateCount;
      }
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
