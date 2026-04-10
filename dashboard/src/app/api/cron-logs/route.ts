/**
 * Cron Logs API Route — handles reading and writing cron job run records.
 *
 * GET is used by the dashboard to display cron run history.
 * POST is called by cron jobs at the start/end of each run to log their status,
 * duration, number of posts processed, and any error messages.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * GET /api/cron-logs — List recent cron job runs.
 *
 * Optional filter:
 *   ?platform=youtube — only show runs for a specific platform
 */
export async function GET(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");

  const supabase = getSupabaseClient();
  let query = supabase
    .from("cron_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(100);

  // Optionally filter to a single platform's logs
  if (platform) query = query.eq("platform", platform);

  const { data, error } = await query;
  if (error) {
    console.error("Cron logs GET error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  return NextResponse.json(data);
}

/**
 * POST /api/cron-logs — Record a cron job run.
 *
 * Called by each cron job to log its execution. Expects a JSON body with:
 * platform, job_type, status, started_at, finished_at, posts_processed,
 * and optionally error_message.
 */
export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("cron_runs").insert(body).select().single();
  if (error) {
    console.error("Cron logs POST error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
