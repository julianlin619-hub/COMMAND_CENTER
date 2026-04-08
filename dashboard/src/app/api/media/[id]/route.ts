/**
 * Media API Route — generates temporary download URLs for a post's media files.
 *
 * The `[id]` folder name makes this a **dynamic route** in Next.js. The `id`
 * segment of the URL becomes a route parameter. For example:
 *   GET /api/media/abc-123  ->  params.id = "abc-123"
 *   GET /api/media/xyz-456  ->  params.id = "xyz-456"
 *
 * This endpoint is used by cron jobs when they need to download media files
 * from Supabase Storage to publish them to a platform. The flow is:
 *   1. Cron job calls GET /api/media/{postId}
 *   2. This route looks up the post's `media_urls` (Storage paths)
 *   3. Generates signed URLs (temporary, time-limited download links)
 *   4. Returns the signed URLs so the cron job can download the files
 *
 * Why signed URLs? Supabase Storage files are private by default. A signed URL
 * is a temporary link (expires in 1 hour) that grants access to a specific file
 * without exposing the service key. This is more secure than making files public.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function GET(
  request: Request,
  // Dynamic route params in Next.js 15+ are delivered as a Promise.
  // The `id` property matches the `[id]` folder name in the file path.
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Extract the post ID from the URL path (e.g., /api/media/abc-123 -> "abc-123")
  const { id: postId } = await params;
  const supabase = getSupabaseClient();

  // Step 1: Look up the post to find its media file paths in Supabase Storage
  const { data: post, error } = await supabase
    .from("posts")
    .select("media_urls")
    .eq("id", postId)
    .single();

  if (error || !post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const mediaUrls = post.media_urls;
  if (!mediaUrls || mediaUrls.length === 0) {
    return NextResponse.json({ error: "No media for this post" }, { status: 404 });
  }

  // Step 2: Generate signed (temporary) download URLs for each media file.
  // A post can have multiple media files, so we generate a URL for each one
  // in parallel using Promise.all.
  const signedUrls = await Promise.all(
    mediaUrls.map(async (path: string) => {
      const { data } = await supabase.storage
        .from("media")
        .createSignedUrl(path, 3600); // 3600 seconds = 1 hour expiry
      return { path, signedUrl: data?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ postId, media: signedUrls });
}
