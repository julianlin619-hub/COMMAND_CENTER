/**
 * Media Proxy Endpoint — GET /api/media/[id]
 *
 * This endpoint solves a specific publishing problem: Buffer downloads media
 * lazily from its queue, and posts can sit there for 1-2 weeks before their
 * scheduled slot. Pre-signed Supabase URLs expire (7-30 days), so a post that
 * backs up too long ends up with a dead URL — Buffer then fails with "unknown
 * error" when it tries to fetch the file.
 *
 * This endpoint is "permanent" from Buffer's perspective: it never expires.
 * When Buffer fetches it, we look up the post's storage path, generate a
 * fresh 1-hour signed URL on the spot, and issue a 302 redirect. Buffer
 * follows the redirect and downloads the file successfully every time.
 *
 * No authentication is required — Buffer fetches this URL directly, without
 * our session cookies or CRON_SECRET. The post ID is a UUID (hard to guess),
 * so this is safe to expose publicly in the same way a 30-day signed URL is.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";

const BUCKET = "media";

// 1-hour TTL for the signed URL we redirect to. Buffer follows the redirect
// immediately after fetching this endpoint, so a short window is fine — it
// only needs to survive the round-trip time between our redirect response and
// Buffer's follow-up GET to Supabase Storage.
const REDIRECT_TTL_SECONDS = 3600;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "Missing post id" }, { status: 400 });
  }

  // Carousel posts store several storage paths on one row; ?index=N selects
  // which one to serve (each Buffer asset gets its own indexed proxy URL —
  // see core/media.py build_proxy_url). No index param means index 0, which
  // keeps every pre-carousel URL working unchanged. The index adds nothing
  // guessable, so the endpoint's unauthenticated posture is unaffected.
  const rawIndex = req.nextUrl.searchParams.get("index");
  const index = rawIndex === null ? 0 : Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json(
      { error: `Invalid media index: ${rawIndex}` },
      { status: 400 },
    );
  }

  const supabase = getSupabaseClient();

  // Look up the post's media storage path. We only need media_urls — no
  // other fields — so we scope the select to keep the query minimal.
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("media_urls")
    .eq("id", id)
    .single();

  if (postError || !post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const mediaUrls = post.media_urls as string[] | null;
  const storagePath = mediaUrls?.[index];
  if (!storagePath) {
    return NextResponse.json(
      { error: "No media attached to this post" },
      { status: 404 },
    );
  }

  // Re-sign the storage path. The signed URL is short-lived (1 hour) because
  // Buffer will follow this redirect immediately — no need for a long window.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, REDIRECT_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    console.error(
      "media proxy: createSignedUrl failed for post %s path %s: %s",
      id,
      storagePath,
      signError?.message,
    );
    return NextResponse.json(
      { error: `Failed to sign media URL: ${signError?.message}` },
      { status: 500 },
    );
  }

  // 302 (temporary redirect) so Buffer re-fetches this endpoint each time
  // rather than caching the signed URL. Using 301 would let Buffer cache
  // the signed URL indefinitely, defeating the purpose.
  return NextResponse.redirect(signed.signedUrl, { status: 302 });
}
