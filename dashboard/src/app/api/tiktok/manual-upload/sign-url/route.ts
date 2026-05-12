/**
 * POST /api/tiktok/manual-upload/sign-url
 *
 * Step 1 of the two-step TikTok manual upload flow (Pathway 3).
 *
 * Why this endpoint exists: the previous single-endpoint design tried to
 * receive the entire mp4 as multipart/form-data and re-upload it to
 * Supabase Storage server-side. Render's proxy + Next.js's streaming body
 * parser couldn't sustain bodies above ~90 MB, so undici's multipart
 * parser would throw "Failed to parse body as FormData" before the route
 * ever ran. For a target of 1–2 GB videos, the file has to bypass our
 * Next.js server entirely.
 *
 * This endpoint mints a Supabase Storage signed upload URL scoped to a
 * single object path. The browser PUTs the mp4 directly to that URL —
 * a single HTTP request, with progress tracked via XHR. Once the upload
 * completes, the browser calls POST /api/tiktok/manual-upload to
 * finalize (sign a 7-day read URL + run Buffer fan-out).
 *
 * Why single-PUT and not TUS resumable: we initially tried TUS
 * (`/storage/v1/upload/resumable`) using the createSignedUploadUrl token
 * in `x-signature` (failed with "Invalid Compact JWS") and then in
 * `Authorization: Bearer` (failed with RLS on storage.objects — the
 * token's role claim doesn't bypass RLS). The signed-URL flow is what
 * createSignedUploadUrl is actually designed for, and it just works
 * without RLS or JWT minting. Tradeoff: a network drop restarts the
 * upload from byte zero. For 1–2 GB on a stable home connection this
 * is acceptable; the signed URL TTL is plenty for retries.
 *
 * Auth: Clerk session only. We don't use `verifyApiAuth` here because it
 * only returns a boolean and we need the userId for the storage path
 * prefix. Bearer/CRON_SECRET is rejected — manual upload is user-triggered,
 * cron jobs shouldn't be calling this.
 *
 * PREREQUISITE (deploy-time, not enforced in code):
 *   - Supabase Dashboard → Storage → Settings → Upload file size limit
 *     must be raised from the default 50 MB to at least 2 GB (or whatever
 *     ceiling MAX_UPLOAD_BYTES below enforces). Otherwise the PUT will
 *     succeed for the first 50 MB and then 413 from Supabase.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard ceiling for a single upload. 2 GB matches what the user wants to
// support today; raise here AND in the Supabase project setting if you
// ever need bigger. Enforcing this server-side stops a malicious or
// buggy client from claiming an arbitrarily huge sizeBytes (the value
// itself isn't trusted by Supabase, but flagging it now gives a clean
// 413 instead of letting TUS run for hours before Supabase rejects).
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const BUCKET = "media";

// Whitelist of accepted video content types and the file extension we'll
// persist them under in Storage. The map serves two purposes:
//   1. Gate the upload — anything not in the map is rejected with 415,
//      so we never sign URLs for formats Buffer can't ingest.
//   2. Derive a known-safe extension from the content type instead of
//      trusting the client's filename (which could carry traversal
//      segments, weird unicode, or a misleading extension).
// All four formats listed are accepted by Buffer's TikTok / YouTube Shorts
// / LinkedIn video endpoints. Add more entries here if Buffer gains
// support for additional formats — no other code needs to change.
const ACCEPTED_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov", // .mov from macOS / iOS exports
  "video/webm": ".webm",
  "video/x-m4v": ".m4v",
};

type SignUrlBody = {
  filename?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
};

export async function POST(req: NextRequest) {
  // --- Auth: require a Clerk session, no Bearer fallback ---
  // verifyApiAuth would accept CRON_SECRET here, but we need the Clerk
  // userId to scope the storage path. Call auth() directly. If there's
  // no userId, the caller is either unauthenticated or is hitting us
  // with a Bearer token (cron) — both get 401.
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SignUrlBody;
  try {
    body = (await req.json()) as SignUrlBody;
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body" },
      { status: 400 },
    );
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType : "";
  const sizeBytes =
    typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes)
      ? body.sizeBytes
      : NaN;

  if (!filename) {
    return NextResponse.json(
      { error: "Missing `filename` field" },
      { status: 400 },
    );
  }
  // Strict whitelist — the content type must be one we know Buffer can
  // ingest and that we have a canonical extension for. The form's
  // <input accept="..."> filters most of these at the OS level; this is
  // the authoritative gate. Anything outside the map gets 415 here so
  // we don't sign upload URLs for formats Buffer would later reject.
  const fileExt = ACCEPTED_VIDEO_TYPES[contentType];
  if (!fileExt) {
    return NextResponse.json(
      {
        error: `Unsupported video format "${contentType}". Accepted: ${Object.keys(
          ACCEPTED_VIDEO_TYPES,
        ).join(", ")}`,
      },
      { status: 415 },
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: "Missing or invalid `sizeBytes` field" },
      { status: 400 },
    );
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024 * 1024)} GB)`,
      },
      { status: 413 },
    );
  }

  // Storage path: tiktok/manual/<userId>/<uuid><ext>
  // We deliberately do NOT trust the client's filename — using a uuid as
  // the basename prevents path-traversal tricks and collisions. The
  // extension is derived from the validated content type (not the
  // filename) so we never let a client-controlled string into the path.
  // The userId prefix lets the finalize endpoint verify ownership by
  // checking startsWith(`tiktok/manual/${userId}/`) before signing a
  // read URL.
  const storagePath = `tiktok/manual/${userId}/${randomUUID()}${fileExt}`;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data) {
    console.error(
      "manual-upload/sign-url: createSignedUploadUrl failed:",
      error?.message,
    );
    return NextResponse.json(
      { error: `Failed to mint upload token: ${error?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Return the signed upload URL (the complete URL the browser PUTs to)
  // and the storage path (round-tripped back to the finalize endpoint
  // so the server can sign a 7-day read URL and confirm the object
  // exists). data.signedUrl is fully-formed including the bound token —
  // the browser doesn't need to know the bucket name or assemble
  // anything; it just XHR-PUTs the file to signedUrl.
  return NextResponse.json({
    storagePath,
    signedUrl: data.signedUrl,
  });
}
