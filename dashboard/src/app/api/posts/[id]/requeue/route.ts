/**
 * POST /api/posts/:id/requeue
 *
 * Re-queues a `buffer_error` post back into Buffer by:
 *   1. Loading the post row (must have status='buffer_error').
 *   2. Reading the persisted `metadata.buffer_replay` payload (channel id,
 *      caption, media type, optional youtube metadata).
 *   3. Minting a fresh 30-day signed URL from Supabase Storage so the media
 *      URL is never stale when Buffer fetches it.
 *   4. Sending the post to Buffer via sendToBuffer.
 *   5. Flipping status back to 'sent_to_buffer' with the new Buffer post id
 *      and a reset retry counter so buffer_reconcile watches it normally.
 *
 * Only works for media posts that have a persisted buffer_replay. Text-only
 * posts (Threads) are not supported here — they go through their own adapter.
 *
 * Auth: Clerk session or CRON_SECRET Bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { sendToBuffer, type SendToBufferOptions } from "@/lib/buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "media";
// 30 days — matches the send paths so the re-queued post survives a long
// stint in Buffer's queue before it publishes.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseClient();

  // Load the full post row — we need metadata, media_urls, and status.
  const { data: post, error: fetchError } = await supabase
    .from("posts")
    .select("id, status, platform, media_urls, metadata")
    .eq("id", id)
    .single();

  if (fetchError || !post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  if (post.status !== "buffer_error") {
    return NextResponse.json(
      { error: `Post is '${post.status}', not 'buffer_error' — nothing to requeue` },
      { status: 409 },
    );
  }

  const replay = (post.metadata as Record<string, unknown> | null)
    ?.buffer_replay as Record<string, unknown> | undefined;

  const mediaUrls: string[] = (post.media_urls as string[] | null) ?? [];
  const storagePath = mediaUrls[0];

  // We can only requeue media posts that have a persisted replay payload.
  // Text-only posts (Threads) created before replay tracking was added also
  // land here — surface a clear error rather than silently doing nothing.
  if (!replay || !replay.channel_id || !replay.media_type || !storagePath) {
    return NextResponse.json(
      {
        error:
          "Post has no replayable payload (no buffer_replay, media_type, or media_urls). " +
          "This post cannot be automatically requeued — re-upload the media manually.",
      },
      { status: 422 },
    );
  }

  // Verify the file still exists before signing — createSignedUrl succeeds
  // even for deleted paths, so Buffer would get a 404 when it tries to fetch
  // the video and surface another "unknown error". Check existence first so
  // we can return a clear message instead of silently re-queuing a dead URL.
  const pathParts = storagePath.split("/");
  const fileName = pathParts.pop()!;
  const dirPath = pathParts.join("/");
  const { data: listed } = await supabase.storage.from(BUCKET).list(dirPath, {
    search: fileName,
  });
  if (!listed || listed.length === 0) {
    return NextResponse.json(
      {
        error:
          "The source file has been deleted from storage and can no longer be re-uploaded. " +
          "Please re-upload the video manually via the Manual Upload page.",
      },
      { status: 422 },
    );
  }

  // Re-mint a fresh signed URL so Buffer can fetch the asset even if the
  // original URL has expired.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) {
    console.error("requeue: createSignedUrl failed:", signError?.message);
    return NextResponse.json(
      { error: "Failed to create signed URL for media." },
      { status: 500 },
    );
  }

  // Rebuild the sendToBuffer options from the replay payload.
  const options: SendToBufferOptions = {};
  if (replay.facebook_post_type) {
    options.facebookPostType = replay.facebook_post_type as SendToBufferOptions["facebookPostType"];
  }
  if (replay.instagram_post_type) {
    options.instagramPostType = replay.instagram_post_type as SendToBufferOptions["instagramPostType"];
  }
  if (replay.youtube) {
    options.youtube = replay.youtube as SendToBufferOptions["youtube"];
  }
  if (typeof replay.caption_limit === "number") {
    options.captionLimit = replay.caption_limit;
  }

  let newBufferId: string;
  try {
    newBufferId = await sendToBuffer(
      replay.channel_id as string,
      replay.body as string,
      signed.signedUrl,
      replay.media_type as "video" | "image",
      options,
    );
  } catch (err) {
    console.error("requeue: Buffer send failed:", (err as Error).message);
    return NextResponse.json(
      { error: `Buffer rejected the post: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // Reset the row so buffer_reconcile monitors it like a fresh send.
  const existingMeta = (post.metadata as Record<string, unknown> | null) ?? {};
  const updatedMeta = {
    ...existingMeta,
    buffer_retry_count: 0,
    requeued_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabase
    .from("posts")
    .update({
      status: "sent_to_buffer",
      platform_post_id: newBufferId,
      metadata: updatedMeta,
      // Clear any previous error so it doesn't show in the dashboard.
      error_message: null,
    })
    .eq("id", id);

  if (updateError) {
    // Post is already queued in Buffer — log but don't fail the response.
    console.error("requeue: DB update failed after successful Buffer send:", updateError.message);
  }

  return NextResponse.json({ ok: true, bufferId: newBufferId });
}
