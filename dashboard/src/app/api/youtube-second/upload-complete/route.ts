/**
 * POST /api/youtube-second/upload-complete
 *
 * Step 2 of the browser-direct YouTube upload flow. Called by the browser
 * after it finishes PUT-ing all chunks to YouTube's resumable endpoint.
 *
 * Why we re-verify via videos.list rather than trust the client:
 *   The browser could submit any video_id. Without a check, a caller
 *   could bind this post row to a video they don't own. We call
 *   videos.list to confirm:
 *     (a) the video exists,
 *     (b) uploadStatus is 'uploaded' or 'processed',
 *     (c) the channel id matches the authenticated second channel.
 */

import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { refreshOauthToken } from "@/lib/google-oauth";

export const runtime = "nodejs";

// Hormozi Highlights — the 2nd channel this feature uploads to. Pulled
// from env so the fallback works out of the box but can be overridden
// without a redeploy if we ever repoint the flow at a different channel.
const EXPECTED_CHANNEL_ID =
  process.env.YOUTUBE_SECOND_CHANNEL_ID || "UCrvch01h6lWZAuGaa1LqX9Q";

interface CompleteBody {
  post_id?: unknown;
  video_id?: unknown;
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as CompleteBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const postId = typeof body.post_id === "string" ? body.post_id : "";
  const videoId = typeof body.video_id === "string" ? body.video_id : "";
  if (!postId || !videoId) {
    return NextResponse.json(
      { error: "post_id and video_id are required" },
      { status: 400 },
    );
  }
  // Sanity bounds — YouTube IDs are ~11 chars, UUIDs ~36. No user content
  // goes into these IDs, so strict bounds prevent accidental injection into
  // URL construction below.
  if (videoId.length > 64 || !/^[A-Za-z0-9_\-]+$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video_id" }, { status: 400 });
  }

  const clientId = process.env.YOUTUBE_SECOND_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_SECOND_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_SECOND_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      "youtube_second upload-complete: missing YOUTUBE_SECOND_* env vars",
    );
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 },
    );
  }

  // ── Verify the video with YouTube ─────────────────────────────────
  let snippet: { channelId?: string } = {};
  try {
    const { accessToken } = await refreshOauthToken({
      clientId,
      clientSecret,
      refreshToken,
    });

    const vidRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(
        videoId,
      )}&part=status,snippet`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!vidRes.ok) {
      throw new Error(`videos.list failed: ${vidRes.status}`);
    }
    const vidData = (await vidRes.json()) as {
      items?: Array<{
        status?: { uploadStatus?: string };
        snippet?: { channelId?: string };
      }>;
    };
    const video = vidData.items?.[0];
    if (!video) {
      return NextResponse.json(
        { error: "Video not found on YouTube" },
        { status: 404 },
      );
    }

    const uploadStatus = video.status?.uploadStatus;
    if (uploadStatus !== "uploaded" && uploadStatus !== "processed") {
      return NextResponse.json(
        { error: `Unexpected uploadStatus: ${uploadStatus}` },
        { status: 409 },
      );
    }

    // Pin to the expected channel ID. A wrong refresh token (pointed at a
    // different channel) or a spoofed video_id from a malicious client
    // would otherwise slip through — this catches both.
    if (video.snippet?.channelId !== EXPECTED_CHANNEL_ID) {
      console.warn(
        "youtube_second channel mismatch: expected %s, got %s",
        EXPECTED_CHANNEL_ID,
        video.snippet?.channelId,
      );
      return NextResponse.json(
        { error: "Video does not belong to the expected channel" },
        { status: 403 },
      );
    }

    snippet = video.snippet ?? {};
  } catch (err) {
    console.error("youtube_second upload-complete verify error:", sanitize(err));
    return NextResponse.json(
      { error: "Failed to verify video with YouTube" },
      { status: 502 },
    );
  }

  // ── Transition the post row ───────────────────────────────────────
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("posts")
    .update({
      status: "scheduled",
      platform_post_id: videoId,
      permalink: `https://youtu.be/${videoId}`,
    })
    .eq("id", postId)
    .eq("status", "uploading_to_youtube")
    .select("metadata")
    .single();

  if (error) {
    console.error("youtube_second upload-complete update failed:", error.message);
    return NextResponse.json(
      { error: "Failed to finalize post" },
      { status: 500 },
    );
  }

  const publishAt =
    (data?.metadata as { publish_at?: string } | null)?.publish_at ?? null;

  return NextResponse.json({
    permalink: `https://youtu.be/${videoId}`,
    publish_at: publishAt,
    channel_id: snippet.channelId ?? null,
  });
}

function sanitize(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[REDACTED]");
}
