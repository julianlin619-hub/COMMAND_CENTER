import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: postId } = await params;
  const supabase = getSupabaseClient();

  // Look up the post to get its media_urls
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

  // Generate signed URLs for all media files
  const signedUrls = await Promise.all(
    mediaUrls.map(async (path: string) => {
      const { data } = await supabase.storage
        .from("media")
        .createSignedUrl(path, 3600); // 1 hour expiry
      return { path, signedUrl: data?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ postId, media: signedUrls });
}
