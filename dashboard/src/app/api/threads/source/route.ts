/**
 * POST /api/threads/source — Manually trigger content sourcing for Threads.
 *
 * Fetches recent tweets via Apify, deduplicates against existing posts, and
 * creates scheduled posts in Supabase so the publish phase can pick them up.
 * Ported from the original THREADS repo's /api/fetch-tweets route.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.APIFY_API_KEY;
  const handle = process.env.APIFY_TWITTER_HANDLE || "AlexHormozi";

  if (!apiKey) {
    return NextResponse.json(
      { error: "APIFY_API_KEY not configured" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();

  // Log cron run start
  const { data: cronRun } = await supabase
    .from("cron_runs")
    .insert({ platform: "threads", job_type: "content_apify", status: "running" })
    .select("id")
    .single();
  const runId = cronRun?.id;

  try {
    // Step 1: Call Apify to scrape tweets
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs?token=${apiKey}&waitForFinish=300`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          twitterHandles: [handle],
          maxItems: 50,
          sort: "Latest",
        }),
      }
    );

    if (!runRes.ok) {
      throw new Error(`Apify run failed: ${runRes.status}`);
    }

    const runData = await runRes.json();
    const datasetId = runData.data.defaultDatasetId;

    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apiKey}`
    );
    const items = (await itemsRes.json()) as Record<string, unknown>[];

    // Step 2: Filter to last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const tweets = items
      .map((t) => ({
        text: decodeHtml(String(t.text ?? "")),
        createdAt: String(t.createdAt ?? ""),
      }))
      .filter(
        (t) => t.text.trim() && new Date(t.createdAt).getTime() >= cutoff
      );

    // Step 3: Get existing captions to deduplicate
    const { data: existingPosts } = await supabase
      .from("posts")
      .select("caption")
      .eq("platform", "threads");

    const existingCaptions = new Set(
      (existingPosts || []).map((p) => p.caption)
    );

    // Step 4: Create posts + schedules for new tweets
    const now = new Date().toISOString();
    let sourced = 0;

    for (const tweet of tweets) {
      if (existingCaptions.has(tweet.text)) continue;

      const { data: post } = await supabase
        .from("posts")
        .insert({
          platform: "threads",
          caption: tweet.text,
          status: "scheduled",
        })
        .select("id")
        .single();

      if (post) {
        await supabase
          .from("schedules")
          .insert({ post_id: post.id, scheduled_for: now });
        sourced++;
        existingCaptions.add(tweet.text);
      }
    }

    // Log success
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
      fetched: tweets.length,
      handle,
    });
  } catch (err) {
    const message = (err as Error).message;
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
