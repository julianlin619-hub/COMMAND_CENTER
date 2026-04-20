/**
 * Posts [id] API Route — handles per-post operations.
 *
 * In Next.js App Router, a folder wrapped in brackets (e.g. `[id]`) makes
 * that path segment a dynamic parameter. `/api/posts/abc123` is routed here
 * with `params.id === "abc123"`. In Next.js 15+, `params` is a Promise and
 * must be awaited before use.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * DELETE /api/posts/:id — Permanently remove a post row.
 *
 * Called by the Delete confirmation dialog on the posts page. Cascades to
 * the `schedules` table via `ON DELETE CASCADE` (see migration 001).
 *
 * Returns:
 *   200 — deleted, body is `{ deleted: "<id>" }`
 *   401 — unauthorized
 *   404 — no post with that id
 *   500 — database error
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseClient();

  // `.select()` after `.delete()` returns the rows that were removed, so we
  // can distinguish "nothing matched" (404) from a real DB failure (500).
  // Without this, a bogus id would return 200 with no rows touched.
  const { data, error } = await supabase
    .from("posts")
    .delete()
    .eq("id", id)
    .select();

  if (error) {
    console.error("Posts DELETE error:", error.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: data[0].id });
}
