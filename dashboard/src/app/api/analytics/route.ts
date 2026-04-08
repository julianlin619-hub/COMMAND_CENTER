/**
 * Analytics API Route — handles reading and writing engagement metrics.
 *
 * GET supports several filter options for flexible querying.
 * POST is used by cron jobs to write new metric snapshots after pulling
 * data from platform APIs (views, likes, comments, shares).
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * GET /api/analytics — Retrieve engagement metric snapshots.
 *
 * Filter options (all optional, combine as needed):
 *   ?platform=youtube     — only metrics for this platform
 *   ?post_id=abc-123      — only metrics for a specific post
 *   ?since=2024-01-01     — only metrics after this ISO date (inclusive)
 *   ?limit=50             — max rows to return (default 100)
 *
 * Examples:
 *   /api/analytics?platform=tiktok&since=2024-03-01
 *   /api/analytics?post_id=some-uuid
 */
export async function GET(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");
  const postId = searchParams.get("post_id");
  const since = searchParams.get("since");
  const limit = parseInt(searchParams.get("limit") || "100", 10);

  const supabase = getSupabaseClient();
  let query = supabase
    .from("engagement_metrics")
    .select("*")
    .order("snapshot_at", { ascending: false })
    .limit(limit);

  // Each filter is only applied if the corresponding query param is present,
  // so callers can mix and match any combination of filters.
  if (platform) query = query.eq("platform", platform);
  if (postId) query = query.eq("post_id", postId);
  // `.gte()` means "greater than or equal" — filters to metrics at or after the given date
  if (since) query = query.gte("snapshot_at", since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

/**
 * POST /api/analytics — Record a new engagement metric snapshot.
 *
 * Called by cron jobs after they pull metrics from platform APIs.
 * Expects a JSON body with: post_id, platform, views, likes, comments,
 * shares, snapshot_at, etc.
 */
export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("engagement_metrics")
    .insert(body)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}
