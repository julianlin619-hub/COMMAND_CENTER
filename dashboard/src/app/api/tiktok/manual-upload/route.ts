/**
 * POST /api/tiktok/manual-upload
 *
 * User-triggered manual upload path for TikTok. Accepts an mp4, stores it in
 * Supabase Storage, signs a 7-day URL, queues it on Buffer's TikTok channel
 * (schedulingType=automatic + mode=addToQueue → next open slot), and records
 * the post in Supabase.
 *
 * Body: multipart/form-data with `file` (video/mp4), `title`, `caption`.
 *
 * The source mp4 is deleted from Storage 3 days after Buffer publishes it
 * (via `cron/tiktok_storage_cleanup.py`). `metadata.source='manual_upload'`
 * is the flag the cleanup cron scans for.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { getChannelId, sendToBuffer } from "@/lib/buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 250 MB guard — Render doesn't hard-cap this, but a reasonable ceiling
// protects against accidental multi-gigabyte uploads that would blow the
// serverless runtime's memory.
const MAX_FILE_BYTES = 250 * 1024 * 1024;

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const code = e.code ?? "";
  const message = (e.message ?? "").toLowerCase();
  return (
    code === PG_UNIQUE_VIOLATION ||
    message.includes(PG_UNIQUE_VIOLATION) ||
    message.includes("duplicate key")
  );
}

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const title = String(form.get("title") ?? "").trim();
  const caption = String(form.get("caption") ?? "").trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing `file` field" }, { status: 400 });
  }
  if (!caption) {
    return NextResponse.json({ error: "Missing `caption` field" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB)` },
      { status: 413 },
    );
  }
  const isMp4 =
    file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");
  if (!isMp4) {
    return NextResponse.json(
      { error: "Only video/mp4 files are supported" },
      { status: 415 },
    );
  }

  const supabase = getSupabaseClient();
  const storagePath = `tiktok/manual/${randomUUID()}.mp4`;

  // 1. Upload to Supabase Storage. Kept on the "tiktok/manual/" prefix so it
  //    never collides with the automated "tiktok/tweet-<id>.mp4" path used
  //    by cron/tiktok_pipeline.py.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(storagePath, bytes, { contentType: "video/mp4" });
  if (uploadError) {
    console.error("Storage upload failed:", uploadError.message);
    return NextResponse.json(
      { error: `Storage upload failed: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // 2. Sign a 7-day URL. Buffer may not pull the file for hours/days, so
  //    short-lived URLs risk expiring before Buffer fetches the video.
  const { data: signed, error: signError } = await supabase.storage
    .from("media")
    .createSignedUrl(storagePath, 604800);
  if (signError || !signed?.signedUrl) {
    console.error("Signed URL failed:", signError?.message);
    // Clean up the orphan file so retries aren't blocked by the unique path.
    await supabase.storage.from("media").remove([storagePath]);
    return NextResponse.json(
      { error: `Failed to sign URL: ${signError?.message}` },
      { status: 500 },
    );
  }

  // 3. Queue the video on Buffer's TikTok channel. sendToBuffer already
  //    truncates the caption to TikTok's 150-char limit.
  let channelId: string;
  let bufferId: string;
  try {
    channelId = await getChannelId(undefined, "tiktok");
    bufferId = await sendToBuffer(channelId, caption, signed.signedUrl, "video");
  } catch (err) {
    console.error("Buffer send failed:", (err as Error).message);
    // Orphan file cleanup: we haven't written a posts row yet, so no DB state
    // to roll back. Removing the Storage file avoids paying for dead bytes.
    await supabase.storage.from("media").remove([storagePath]);
    return NextResponse.json(
      { error: `Buffer send failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // 4. Record the post. platform_post_id holds the Buffer ID so the cleanup
  //    cron can query Buffer for sentAt later.
  const { data: post, error: insertError } = await supabase
    .from("posts")
    .insert({
      platform: "tiktok",
      status: "sent_to_buffer",
      title: title || null,
      caption,
      media_type: "video",
      media_urls: [storagePath],
      platform_post_id: bufferId,
      metadata: {
        source: "manual_upload",
        buffer_post_id: bufferId,
        storage_cleanup_status: "pending",
      },
    })
    .select("id")
    .single();

  if (insertError || !post) {
    // Buffer has already accepted the post — rolling back its queue is fiddly
    // and risky. Better to leave the video queued and surface the Buffer ID
    // so the user can reconcile manually.
    if (isUniqueViolation(insertError)) {
      return NextResponse.json(
        {
          error: "A TikTok post with this exact caption already exists.",
          bufferId,
        },
        { status: 409 },
      );
    }
    console.error("Post insert failed (Buffer id=%s): %s", bufferId, insertError?.message);
    return NextResponse.json(
      {
        error: `Post insert failed: ${insertError?.message}`,
        bufferId,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, postId: post.id, bufferId });
}
