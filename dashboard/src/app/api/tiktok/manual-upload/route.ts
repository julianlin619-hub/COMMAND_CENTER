/**
 * POST /api/tiktok/manual-upload (finalize step)
 *
 * Step 3 of the two-step TikTok manual upload flow (Pathway 3). The browser
 * has already uploaded the mp4 directly to Supabase Storage via TUS using a
 * token issued by /api/tiktok/manual-upload/sign-url. This endpoint just:
 *   1. Verifies the storagePath belongs to the calling user.
 *   2. Confirms the upload actually completed (the object exists).
 *   3. Signs a 7-day read URL for Buffer to pull from.
 *   4. Queues the video on Buffer for TikTok, then fans it out to YouTube
 *      Shorts and (if enabled) LinkedIn.
 *   5. Writes one `posts` row per successful platform, all referencing the
 *      same storage path so the cleanup cron can group them.
 *
 * Body: JSON { storagePath, title, caption }.
 * Title is mandatory because YouTube requires a non-empty video title;
 * LinkedIn ignores it but it's stored on the LinkedIn posts row anyway.
 *
 * Partial success: if YouTube and/or LinkedIn fail after TikTok is already
 * queued, the response still returns 200 with `youtubeError` / `linkedinError`
 * set. Buffer can't cleanly un-queue the TikTok post so we don't pretend
 * the whole request failed.
 *
 * The source mp4 is deleted from Storage 3 days after Buffer publishes
 * every recorded post (via `cron/tiktok_storage_cleanup.py`, which groups
 * by storage path). `metadata.source='manual_upload'` is the flag the
 * cleanup cron scans for — DO NOT change that key without updating the
 * cron and the partial index in
 * supabase/migrations/20260424120000_tiktok_manual_upload_cleanup.sql.
 *
 * Auth: Clerk session only. See sign-url/route.ts for the same rationale.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getChannelId, sendToBuffer, type YouTubeMetadata } from "@/lib/buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LinkedIn allows up to 3000 chars in a post body. sendToBuffer defaults to
// TikTok's 150-char truncation, so we override per-call for LinkedIn.
const LINKEDIN_CAPTION_LIMIT = 3000;

// TEMPORARY KILL-SWITCH for the LinkedIn fan-out. When false, uploads still
// go to TikTok + YouTube Shorts, but the LinkedIn Buffer send + posts-row
// insert are skipped and the response returns linkedinBufferId=undefined,
// linkedinError=undefined (i.e. silent skip — not a failure). Flip back to
// true to resume LinkedIn fan-out; no other changes needed.
const LINKEDIN_FANOUT_ENABLED = false;

const PG_UNIQUE_VIOLATION = "23505";

const BUCKET = "media";

// 7 days. Buffer may not pull the file for hours or days after we queue it,
// so short-lived URLs risk expiring before Buffer fetches the video.
const READ_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

// Defaults applied to every YouTube Shorts upload. Pulled out so they're
// easy to scan and tweak. `title` is supplied per-upload from the form.
const YOUTUBE_DEFAULTS: Omit<YouTubeMetadata, "title"> = {
  categoryId: "27", // Education
  privacy: "public",
  madeForKids: false,
  notifySubscribers: true,
  embeddable: true,
  license: "youtube",
};

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

type FinalizeBody = {
  storagePath?: unknown;
  title?: unknown;
  caption?: unknown;
};

export async function POST(req: NextRequest) {
  // Same auth rationale as sign-url: we need the Clerk userId to verify
  // the storagePath actually belongs to this user, so verifyApiAuth (which
  // returns only a boolean and accepts CRON_SECRET) is the wrong tool.
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: FinalizeBody;
  try {
    body = (await req.json()) as FinalizeBody;
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const storagePath =
    typeof body.storagePath === "string" ? body.storagePath : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";

  if (!storagePath) {
    return NextResponse.json(
      { error: "Missing `storagePath` field" },
      { status: 400 },
    );
  }
  if (!title) {
    return NextResponse.json(
      { error: "Missing `title` field — required for YouTube Shorts" },
      { status: 400 },
    );
  }
  if (!caption) {
    return NextResponse.json(
      { error: "Missing `caption` field" },
      { status: 400 },
    );
  }

  // Path-ownership check. The sign-url endpoint always issues paths under
  // `tiktok/manual/<userId>/`, so any finalize call with a different
  // prefix is either a bug or an attempt to claim someone else's upload.
  // Also reject path-traversal segments defensively — Supabase normalises
  // these but cheap to belt-and-brace here.
  const expectedPrefix = `tiktok/manual/${userId}/`;
  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    return NextResponse.json(
      { error: "storagePath does not belong to the authenticated user" },
      { status: 403 },
    );
  }

  const supabase = getSupabaseClient();

  // Confirm the upload actually finished. If the user submitted the
  // finalize form before TUS completed (or the browser tab died mid-
  // upload), the object won't be there and we'd silently sign a URL
  // to nothing. Cheaper than re-issuing a HEAD request — list() scopes
  // the query to this user's directory.
  const basename = storagePath.slice(expectedPrefix.length);
  const { data: listed, error: listError } = await supabase.storage
    .from(BUCKET)
    .list(expectedPrefix.replace(/\/$/, ""), { search: basename });
  if (listError) {
    console.error(
      "manual-upload: storage list failed:",
      listError.message,
    );
    return NextResponse.json(
      { error: `Storage check failed: ${listError.message}` },
      { status: 500 },
    );
  }
  const exists = (listed ?? []).some((entry) => entry.name === basename);
  if (!exists) {
    return NextResponse.json(
      { error: "Upload did not complete — object not found in Storage" },
      { status: 404 },
    );
  }

  // Sign a 7-day read URL for Buffer.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, READ_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    console.error("manual-upload: createSignedUrl failed:", signError?.message);
    return NextResponse.json(
      { error: `Failed to sign URL: ${signError?.message}` },
      { status: 500 },
    );
  }

  // Queue the video on Buffer's TikTok channel. sendToBuffer truncates the
  // caption to TikTok's 150-char limit on its own.
  let tiktokChannelId: string;
  let tiktokBufferId: string;
  try {
    tiktokChannelId = await getChannelId(undefined, "tiktok");
    tiktokBufferId = await sendToBuffer(
      tiktokChannelId,
      caption,
      signed.signedUrl,
      "video",
    );
  } catch (err) {
    console.error("Buffer TikTok send failed:", (err as Error).message);
    // Nothing to roll back — we haven't written a posts row and the
    // file already lives in Storage (uploaded by the browser, not by
    // us). The cleanup cron won't pick it up because no posts row
    // references it, so we'd leak the bytes. Surface a clear error so
    // a future TTL job can sweep unclaimed manual/<userId>/* objects.
    return NextResponse.json(
      { error: `Buffer send failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // Record the TikTok post. platform_post_id holds the Buffer ID so the
  // cleanup cron can query Buffer for sentAt later.
  const { data: tiktokPost, error: tiktokInsertError } = await supabase
    .from("posts")
    .insert({
      platform: "tiktok",
      status: "sent_to_buffer",
      title,
      caption,
      media_type: "video",
      media_urls: [storagePath],
      platform_post_id: tiktokBufferId,
      metadata: {
        source: "manual_upload",
        buffer_post_id: tiktokBufferId,
        storage_cleanup_status: "pending",
      },
    })
    .select("id")
    .single();

  if (tiktokInsertError || !tiktokPost) {
    // Buffer has already accepted the post — rolling back its queue is
    // fiddly and risky. Better to leave the video queued and surface
    // the Buffer ID so the user can reconcile manually.
    if (isUniqueViolation(tiktokInsertError)) {
      return NextResponse.json(
        {
          error: "A TikTok post with this exact caption already exists.",
          tiktokBufferId,
        },
        { status: 409 },
      );
    }
    console.error(
      "TikTok post insert failed (Buffer id=%s): %s",
      tiktokBufferId,
      tiktokInsertError?.message,
    );
    return NextResponse.json(
      {
        error: `Post insert failed: ${tiktokInsertError?.message}`,
        tiktokBufferId,
      },
      { status: 500 },
    );
  }

  // Fan out to Buffer's YouTube channel. Failures here are reported as
  // partial success — TikTok is already queued and we can't un-queue it,
  // so surface the YouTube error without rolling anything back.
  let youtubeBufferId: string | undefined;
  let youtubeError: string | undefined;
  try {
    const ytChannelId = await getChannelId(undefined, "youtube");
    youtubeBufferId = await sendToBuffer(
      ytChannelId,
      caption,
      signed.signedUrl,
      "video",
      {
        youtube: { title, ...YOUTUBE_DEFAULTS },
        captionLimit: 5000,
      },
    );
  } catch (err) {
    youtubeError = (err as Error).message;
    console.error("Buffer YouTube send failed:", youtubeError);
  }

  // If YouTube succeeded, record its posts row too. Same storage path so
  // the cleanup cron groups all rows and only deletes the file after
  // every Buffer sentAt window passes.
  if (youtubeBufferId) {
    const { error: ytInsertError } = await supabase.from("posts").insert({
      platform: "youtube",
      status: "sent_to_buffer",
      title,
      caption,
      media_type: "video",
      media_urls: [storagePath],
      platform_post_id: youtubeBufferId,
      metadata: {
        source: "manual_upload",
        buffer_post_id: youtubeBufferId,
        storage_cleanup_status: "pending",
      },
    });
    if (ytInsertError) {
      if (isUniqueViolation(ytInsertError)) {
        youtubeError =
          "A YouTube post with this exact caption already exists.";
      } else {
        youtubeError = `YouTube post insert failed: ${ytInsertError.message}`;
      }
      console.error(
        "YouTube post insert failed (Buffer id=%s): %s",
        youtubeBufferId,
        ytInsertError.message,
      );
      youtubeBufferId = undefined;
    }
  }

  // Fan out to Buffer's LinkedIn channel. Same partial-success contract
  // as YouTube. Gated behind LINKEDIN_FANOUT_ENABLED so the entire
  // LinkedIn leg can be paused without ripping out the code.
  let linkedinBufferId: string | undefined;
  let linkedinError: string | undefined;
  if (LINKEDIN_FANOUT_ENABLED) {
    try {
      const liChannelId = await getChannelId(undefined, "linkedin");
      linkedinBufferId = await sendToBuffer(
        liChannelId,
        caption,
        signed.signedUrl,
        "video",
        { captionLimit: LINKEDIN_CAPTION_LIMIT },
      );
    } catch (err) {
      linkedinError = (err as Error).message;
      console.error("Buffer LinkedIn send failed:", linkedinError);
    }
  }

  if (linkedinBufferId) {
    const { error: liInsertError } = await supabase.from("posts").insert({
      platform: "linkedin",
      status: "sent_to_buffer",
      title,
      caption,
      media_type: "video",
      media_urls: [storagePath],
      platform_post_id: linkedinBufferId,
      metadata: {
        source: "manual_upload",
        buffer_post_id: linkedinBufferId,
        storage_cleanup_status: "pending",
      },
    });
    if (liInsertError) {
      if (isUniqueViolation(liInsertError)) {
        linkedinError =
          "A LinkedIn post with this exact caption already exists.";
      } else {
        linkedinError = `LinkedIn post insert failed: ${liInsertError.message}`;
      }
      console.error(
        "LinkedIn post insert failed (Buffer id=%s): %s",
        linkedinBufferId,
        liInsertError.message,
      );
      linkedinBufferId = undefined;
    }
  }

  return NextResponse.json({
    ok: true,
    postId: tiktokPost.id,
    tiktokBufferId,
    youtubeBufferId,
    youtubeError,
    linkedinBufferId,
    linkedinError,
  });
}
