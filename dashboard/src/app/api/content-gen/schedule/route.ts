/**
 * POST /api/content-gen/schedule
 *
 * Final step of the content pipeline: sends generated media to Buffer's
 * posting queue and records the result in Supabase.
 *
 * Supports multiple platforms:
 *   - TikTok: sends videos (media_type='video')
 *   - Facebook: sends square PNG images (media_type='image')
 *
 * Body: { platform?: 'tiktok' | 'facebook', items: [{ text, storagePath }] }
 * Returns: { sent: [{ postId: string, bufferId: string }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { getChannelId, sendToBuffer } from "@/lib/buffer";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      platform?: "tiktok" | "facebook";
      items: { text: string; storagePath: string }[];
    };
    const { platform = "tiktok", items } = body;

    if (!items?.length) {
      return NextResponse.json({ error: "No items provided" }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    // Determine media type based on platform
    const mediaType = platform === "facebook" ? "image" : "video";

    // Look up the correct Buffer channel for this platform
    const channelId = await getChannelId(undefined, platform);

    const sent: { postId: string; bufferId: string }[] = [];

    for (const item of items) {
      // 1. Get a signed URL with 7-day expiry.
      //    Buffer queues content and may not download it for hours or days.
      const { data: signedData, error: signError } = await supabase.storage
        .from("media")
        .createSignedUrl(item.storagePath, 604800); // 7 days in seconds

      if (signError || !signedData?.signedUrl) {
        console.error("Failed to create signed URL:", signError?.message);
        return NextResponse.json(
          { error: `Failed to create signed URL: ${signError?.message}` },
          { status: 500 }
        );
      }

      // 2. Send to Buffer's queue with the correct media type.
      //    Caption is "Agree?" for both platforms — short engagement hook.
      const caption = "Agree?";
      const bufferId = await sendToBuffer(
        channelId,
        caption,
        signedData.signedUrl,
        mediaType,
        platform === "facebook" ? "post" : undefined
      );

      // 3. Record the post in Supabase with sent_to_buffer status.
      const { data: post, error: postError } = await supabase
        .from("posts")
        .insert({
          platform,
          status: "sent_to_buffer",
          media_type: mediaType,
          media_urls: [item.storagePath],
          caption: item.text,
          platform_post_id: bufferId,
        })
        .select("id")
        .single();

      if (postError || !post) {
        console.error("Failed to insert post:", postError?.message);
        return NextResponse.json(
          { error: `Failed to create post: ${postError?.message}` },
          { status: 500 }
        );
      }

      sent.push({ postId: post.id, bufferId });
    }

    return NextResponse.json({ sent });
  } catch (err) {
    console.error("Content-gen schedule error:", (err as Error).message);
    return NextResponse.json(
      { error: (err as Error).message || "Internal server error" },
      { status: 500 }
    );
  }
}
