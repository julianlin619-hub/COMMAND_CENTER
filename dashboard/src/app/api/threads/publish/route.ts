/**
 * POST /api/threads/publish — Manually trigger publishing for Threads.
 *
 * Reads due schedules from Supabase, posts each to Threads via Buffer's
 * GraphQL API, and updates post status. Same logic as the Python cron's
 * Phase 1, ported to TypeScript for dashboard-triggered runs.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

const CREATE_POST_MUTATION = `
  mutation CreatePost($channelId: ChannelId!, $text: String!) {
    createPost(input: {
      channelId: $channelId
      text: $text
      schedulingType: automatic
      mode: addToQueue
    }) {
      ... on PostActionSuccess {
        post { id status }
      }
      ... on InvalidInputError { message }
      ... on UnexpectedError { message }
      ... on LimitReachedError { message }
    }
  }
`;

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bufferToken = process.env.BUFFER_ACCESS_TOKEN;
  const channelId = process.env.BUFFER_THREADS_CHANNEL_ID;

  if (!bufferToken || !channelId) {
    return NextResponse.json(
      { error: "BUFFER_ACCESS_TOKEN and BUFFER_THREADS_CHANNEL_ID required" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  // Log cron run start
  const { data: cronRun } = await supabase
    .from("cron_runs")
    .insert({ platform: "threads", job_type: "post", status: "running" })
    .select("id")
    .single();
  const runId = cronRun?.id;

  // Get due schedules for threads
  const { data: schedules } = await supabase
    .from("schedules")
    .select("*, posts!inner(*)")
    .is("picked_up_at", null)
    .lte("scheduled_for", now)
    .eq("posts.platform", "threads");

  let published = 0;
  let failed = 0;
  const errors: { postId: string; error: string }[] = [];

  for (const schedule of schedules || []) {
    const post = schedule.posts;

    // Claim the schedule to prevent double-processing
    await supabase
      .from("schedules")
      .update({ picked_up_at: now })
      .eq("id", schedule.id);

    await supabase
      .from("posts")
      .update({ status: "publishing", updated_at: now })
      .eq("id", post.id);

    // Build text content
    let text = post.caption || post.title || "";
    if (post.hashtags?.length) {
      text += "\n\n" + post.hashtags.map((t: string) => `#${t}`).join(" ");
    }

    if (!text.trim()) {
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: "Empty content", updated_at: now })
        .eq("id", post.id);
      failed++;
      continue;
    }

    try {
      // Post to Buffer (ported from lib/buffer.ts in original THREADS repo)
      const res = await fetch(BUFFER_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bufferToken}`,
        },
        body: JSON.stringify({
          query: CREATE_POST_MUTATION,
          variables: { channelId, text },
        }),
        // 10s timeout so a slow Buffer GraphQL call can't leave the row
        // stuck in "publishing" between the earlier publishing/published
        // state writes — on abort, the catch below flips it to "failed".
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new Error(`Buffer API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();

      if (data.errors?.length) {
        throw new Error(
          data.errors.map((e: { message: string }) => e.message).join(", ")
        );
      }

      const result = data.data?.createPost;
      if (result?.message) {
        throw new Error(result.message);
      }

      const bufferId = result?.post?.id || "unknown";

      await supabase
        .from("posts")
        .update({
          status: "published",
          platform_post_id: bufferId,
          published_at: now,
          updated_at: now,
        })
        .eq("id", post.id);

      published++;
    } catch (err) {
      const msg = (err as Error).message;
      await supabase
        .from("posts")
        .update({ status: "failed", error_message: msg, updated_at: now })
        .eq("id", post.id);
      errors.push({ postId: post.id, error: msg });
      failed++;
    }
  }

  // Log cron run result
  if (runId) {
    await supabase
      .from("cron_runs")
      .update({
        status: failed > 0 && published === 0 ? "failed" : "success",
        finished_at: new Date().toISOString(),
        posts_processed: published,
        error_message: errors.length ? JSON.stringify(errors) : null,
      })
      .eq("id", runId);
  }

  return NextResponse.json({ published, failed, errors });
}
