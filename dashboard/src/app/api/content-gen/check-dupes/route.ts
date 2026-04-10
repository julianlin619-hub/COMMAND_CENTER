/**
 * POST /api/content-gen/check-dupes
 *
 * Checks which tweet captions already exist as TikTok posts in Supabase.
 * This replaces TWEEL_REEL's file-based tweet-history.json dedup with a
 * proper database query.
 *
 * Body: { captions: string[] }
 * Returns: { existing: string[] } — the subset of captions that already have TikTok posts
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { captions } = (await req.json()) as { captions: string[] };

    if (!captions?.length) {
      return NextResponse.json({ existing: [] });
    }

    const supabase = getSupabaseClient();

    // Query posts table for any TikTok posts whose caption matches one of the
    // provided captions. Supabase's `.in()` filter maps to SQL `IN (...)`.
    const { data, error } = await supabase
      .from("posts")
      .select("caption")
      .eq("platform", "tiktok")
      .in("caption", captions);

    if (error) {
      console.error("check-dupes query error:", error.message);
      return NextResponse.json(
        { error: "Database query failed" },
        { status: 500 }
      );
    }

    const existing = (data || []).map((row) => row.caption as string);
    return NextResponse.json({ existing });
  } catch (err) {
    console.error("check-dupes error:", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
