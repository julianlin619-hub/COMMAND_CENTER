/**
 * POST /api/threads/bank — Manually trigger content bank sourcing for Threads.
 *
 * Reads the tweet_bank table (the master bank — the threads cron adds newly
 * scraped tweets to it daily, so it grows past the original CSV seed),
 * deduplicates against existing posts, selects random entries, and creates
 * scheduled posts in Supabase.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * Read every bank text from the tweet_bank table. Paginated because
 * PostgREST caps each select at 1000 rows and the bank is ~5K and growing.
 */
async function fetchBankTexts(
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<string[]> {
  const texts: string[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("tweet_bank")
      .select("text")
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`tweet_bank read failed: ${error.message}`);
    const batch = (data ?? [])
      .map((r) => r.text?.trim())
      .filter((t): t is string => Boolean(t));
    texts.push(...batch);
    if ((data ?? []).length < 1000) return texts;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const count = parseInt(process.env.CONTENT_BANK_COUNT || "24", 10);
  const supabase = getSupabaseClient();

  // Log cron run start
  const { data: cronRun } = await supabase
    .from("cron_runs")
    .insert({ platform: "threads", job_type: "content_bank", status: "running" })
    .select("id")
    .single();
  const runId = cronRun?.id;

  try {
    const allEntries = await fetchBankTexts(supabase);

    // Get existing captions to deduplicate
    const { data: existingPosts } = await supabase
      .from("posts")
      .select("caption")
      .eq("platform", "threads");

    const existingCaptions = new Set(
      (existingPosts || []).map((p) => p.caption)
    );

    // Filter out already-posted entries
    const available = allEntries.filter((e) => !existingCaptions.has(e));

    if (available.length === 0) {
      if (runId) {
        await supabase
          .from("cron_runs")
          .update({
            status: "success",
            finished_at: new Date().toISOString(),
            posts_processed: 0,
          })
          .eq("id", runId);
      }
      return NextResponse.json({
        sourced: 0,
        total: allEntries.length,
        remaining: 0,
        message: "Content bank exhausted — all entries have been posted.",
      });
    }

    // Shuffle and pick
    const selected = shuffle(available).slice(0, count);
    const now = new Date().toISOString();
    let sourced = 0;

    for (const text of selected) {
      const { data: post } = await supabase
        .from("posts")
        .insert({
          platform: "threads",
          caption: text,
          status: "scheduled",
        })
        .select("id")
        .single();

      if (post) {
        await supabase
          .from("schedules")
          .insert({ post_id: post.id, scheduled_for: now });
        sourced++;
      }
    }

    if (runId) {
      await supabase
        .from("cron_runs")
        .update({
          status: "success",
          finished_at: new Date().toISOString(),
          posts_processed: sourced,
        })
        .eq("id", runId);
    }

    return NextResponse.json({
      sourced,
      total: allEntries.length,
      remaining: available.length - sourced,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("Threads bank error:", err);
    if (runId) {
      await supabase
        .from("cron_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: message,
        })
        .eq("id", runId);
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
