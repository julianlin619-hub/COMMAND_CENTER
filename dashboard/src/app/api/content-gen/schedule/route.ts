/**
 * POST /api/content-gen/schedule
 *
 * Final step of the Outlier Tweet Reel pipeline: sends generated TikTok
 * videos to Buffer's posting queue and records the result in Supabase.
 *
 * Buffer handles timing — it queues videos and publishes them at the next
 * available time slot. We don't create `schedules` rows because Buffer
 * replaces our cron-based scheduling for TikTok.
 *
 * Body: { items: [{ text: string, storagePath: string }] }
 *   - text:        normalized tweet text (becomes the TikTok caption)
 *   - storagePath: Supabase Storage path (e.g. "tiktok/tweet-123.mp4")
 *
 * Returns: { sent: [{ postId: string, bufferId: string }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { getTikTokChannelId, sendToBuffer } from "@/lib/buffer";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { items } = (await req.json()) as {
      items: { text: string; storagePath: string }[];
    };

    if (!items?.length) {
      return NextResponse.json({ error: "No items provided" }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    // Look up the TikTok channel ID in Buffer (cached per request)
    const channelId = await getTikTokChannelId();

    const sent: { postId: string; bufferId: string }[] = [];

    for (const item of items) {
      // 1. Get a signed URL for the video with 7-day expiry.
      //    Buffer queues videos and may not download them for hours or days,
      //    so a short expiry risks the URL dying before Buffer fetches it.
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

      // 2. Send to Buffer's TikTok queue. Buffer will download the video
      //    from the signed URL and publish it at the next available slot.
      // Hardcoded TikTok caption — short engagement hook for quote-card videos
      const tiktokCaption = "Agree?";

      const bufferId = await sendToBuffer(
        channelId,
        tiktokCaption,
        signedData.signedUrl
      );

      // 3. Record the post in Supabase with sent_to_buffer status.
      //    This tracks the handoff — Buffer handles actual TikTok publishing.
      const { data: post, error: postError } = await supabase
        .from("posts")
        .insert({
          platform: "tiktok",
          status: "sent_to_buffer",
          media_type: "video",
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
