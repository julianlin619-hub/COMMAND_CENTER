/**
 * Upload API Route — handles media file uploads.
 *
 * This is the server-side handler for the upload form. The flow is:
 *   1. Receive the file via FormData (multipart upload from the browser)
 *   2. Validate file size (different limits for video vs. image)
 *   3. Upload the file to Supabase Storage (our file hosting)
 *   4. Create a "draft" post record in the database with a reference to the file
 *   5. Return the new post ID to the client
 *
 * Later, the user can schedule this draft post, and a cron job will pick it up,
 * read the file from Supabase Storage, and publish it to the target platform.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse the multipart form data. Unlike JSON, FormData can carry binary file
  // data. The browser's `new FormData()` + `fetch()` sends it in this format.
  // Each `.get()` call retrieves a field by the name used in `formData.append()`.
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const platform = formData.get("platform") as string;
  const title = formData.get("title") as string | null;
  const caption = formData.get("caption") as string | null;

  if (!file || !platform) {
    return NextResponse.json(
      { error: "file and platform are required" },
      { status: 400 }
    );
  }

  // Validate file size before uploading. Videos are much larger than images,
  // so they get a higher limit (500MB vs 10MB). The `file.type` property
  // contains the MIME type (e.g., "video/mp4", "image/jpeg").
  const isVideo = file.type.startsWith("video/");
  const maxBytes = isVideo ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    const maxMB = maxBytes / (1024 * 1024);
    // 413 = "Payload Too Large" — the standard HTTP status for oversized uploads
    return NextResponse.json(
      { error: `File too large. Max ${maxMB}MB for ${isVideo ? "video" : "images"}.` },
      { status: 413 }
    );
  }

  const supabase = getSupabaseClient();

  // Upload the file to Supabase Storage. Files are organized by platform
  // and timestamped to avoid name collisions (e.g., "youtube/1710000000000-video.mp4").
  const ext = file.name.split(".").pop();
  const storagePath = `${platform}/${Date.now()}-${file.name}`;
  // Convert the Web API File object to a Node.js Buffer, which Supabase's
  // upload method expects on the server side.
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from("media") // "media" is the Supabase Storage bucket name
    .upload(storagePath, buffer, {
      contentType: file.type, // Preserve the MIME type so browsers can display it
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Determine media type from file MIME type for the database record
  const mediaType = file.type.startsWith("video/") ? "video" : "image";

  // Create a post record in "draft" status. The `media_urls` array stores the
  // Supabase Storage path(s). When a cron job later publishes this post, it will
  // use these paths to fetch the file via the /api/media/[id] endpoint.
  const { data: post, error: postError } = await supabase
    .from("posts")
    .insert({
      platform,
      title: title || null,
      caption: caption || null,
      media_type: mediaType,
      media_urls: [storagePath], // Array because a post could have multiple media files
      status: "draft",
    })
    .select()
    .single();

  if (postError) {
    return NextResponse.json({ error: postError.message }, { status: 500 });
  }

  return NextResponse.json({ postId: post.id, storagePath }, { status: 201 });
}
