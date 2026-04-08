/**
 * Schedule API Route — handles reading and creating scheduled posts.
 *
 * GET returns only pending schedules (not yet picked up by a cron job).
 * POST creates a new schedule entry linking a post to a future publish time.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * GET /api/schedule — List pending (not yet published) schedules.
 *
 * Returns schedules joined with their associated post data, ordered by
 * soonest first. Only shows schedules where `picked_up_at` is null,
 * meaning a cron job hasn't claimed them yet.
 */
export async function GET(request: Request) {
  // Verify the caller is authenticated (Clerk session or CRON_SECRET token)
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("schedules")
    // Join with the posts table to include post details (platform, title, etc.)
    .select("*, posts(*)")
    // Only return schedules not yet claimed by a cron job
    .is("picked_up_at", null)
    .order("scheduled_for", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}

/**
 * POST /api/schedule — Create a new schedule entry.
 *
 * Expects a JSON body with at least `post_id` and `scheduled_for` (ISO timestamp).
 * The cron job will later pick this up and publish the post at the scheduled time.
 */
export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("schedules").insert(body).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data, { status: 201 });
}
