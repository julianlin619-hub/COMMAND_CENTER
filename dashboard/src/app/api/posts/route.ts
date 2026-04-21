/**
 * Posts API Route — handles reading and creating posts.
 *
 * In Next.js App Router, a `route.ts` file inside an `api/` folder defines
 * a **route handler** — the equivalent of an API endpoint. Each exported
 * function name corresponds to an HTTP method:
 *   - `export async function GET(...)` handles GET requests
 *   - `export async function POST(...)` handles POST requests
 *   - You can also export PUT, PATCH, DELETE, etc.
 *
 * These run on the server only and are never bundled into client-side code.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * GET /api/posts — List posts with optional filters.
 *
 * Query params:
 *   ?platform=youtube  — filter by platform
 *   ?status=published  — filter by status
 *   ?limit=20          — max rows to return (default 50)
 */
export async function GET(request: Request) {
  // Auth check: every API route starts by verifying the caller is authorized.
  // This supports two auth methods (Clerk session for dashboard, CRON_SECRET
  // bearer token for cron jobs). See lib/auth.ts for details.
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse URL query parameters from the request
  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform");
  const status = searchParams.get("status");
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  // Whitelist validation — only allow known platform and status values
  const VALID_PLATFORMS = new Set([
    "youtube", "instagram", "instagram_2nd", "tiktok",
    "linkedin", "facebook", "threads",
  ]);
  const VALID_STATUSES = new Set([
    "draft", "scheduled", "publishing", "published",
    "failed", "sent_to_buffer", "buffer_error",
  ]);
  if (platform && !VALID_PLATFORMS.has(platform)) {
    return NextResponse.json({ error: `Invalid platform: ${platform}` }, { status: 400 });
  }
  if (status && !VALID_STATUSES.has(status)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  // Build the query with optional filters (same pattern as the posts page)
  let query = supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (platform) query = query.eq("platform", platform);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    console.error("Posts GET error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  // NextResponse.json() serializes the data as JSON and sets the correct headers
  return NextResponse.json(data);
}

/**
 * POST /api/posts — Create a new post record.
 *
 * Expects a JSON body matching the `posts` table columns (platform, title,
 * caption, media_type, etc.). Used by the cron jobs to record published posts
 * and by the upload flow to create draft posts.
 */
export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Guard against malformed bodies — a bad client shouldn't crash the
  // handler with a 500. Return 400 with a clear error instead.
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  // `.insert(body)` creates a new row, `.select()` returns the created row,
  // and `.single()` unwraps it from an array to a single object.
  const { data, error } = await supabase.from("posts").insert(body).select().single();
  if (error) {
    console.error("Posts POST error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  // 201 = "Created" — the standard HTTP status code for successful resource creation
  return NextResponse.json(data, { status: 201 });
}
