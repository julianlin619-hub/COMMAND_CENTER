import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // File size limits: 500MB for video, 10MB for images
  const isVideo = file.type.startsWith("video/");
  const maxBytes = isVideo ? 500 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxBytes) {
    const maxMB = maxBytes / (1024 * 1024);
    return NextResponse.json(
      { error: `File too large. Max ${maxMB}MB for ${isVideo ? "video" : "images"}.` },
      { status: 413 }
    );
  }

  const supabase = getSupabaseClient();

  // Upload to Supabase Storage
  const ext = file.name.split(".").pop();
  const storagePath = `${platform}/${Date.now()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(storagePath, buffer, {
      contentType: file.type,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  // Determine media type from file MIME
  const mediaType = file.type.startsWith("video/") ? "video" : "image";

  // Create post record
  const { data: post, error: postError } = await supabase
    .from("posts")
    .insert({
      platform,
      title: title || null,
      caption: caption || null,
      media_type: mediaType,
      media_urls: [storagePath],
      status: "draft",
    })
    .select()
    .single();

  if (postError) {
    return NextResponse.json({ error: postError.message }, { status: 500 });
  }

  return NextResponse.json({ postId: post.id, storagePath }, { status: 201 });
}
