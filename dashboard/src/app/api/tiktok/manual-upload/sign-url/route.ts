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
 * This endpoint mints a short-lived Supabase Storage signed upload token
 * scoped to a single object path. The browser then uses that token with
 * `tus-js-client` to upload the file directly to Supabase via the TUS
 * resumable protocol (POST to /storage/v1/upload/resumable). Once the
 * upload completes, the browser calls POST /api/tiktok/manual-upload to
 * finalize (sign a read URL + run Buffer fan-out).
 *
 * Auth: Clerk session only. We don't use `verifyApiAuth` here because it
 * only returns a boolean and we need the userId for the storage path
 * prefix. Bearer/CRON_SECRET is rejected — manual upload is user-triggered,
 * cron jobs shouldn't be calling this.
 *
 * PREREQUISITES (deploy-time, not enforced in code):
 *   - Supabase Dashboard → Storage → Settings → Upload file size limit
 *     must be raised from the default 50 MB to at least 2 GB (or whatever
 *     ceiling MAX_UPLOAD_BYTES below enforces). Otherwise the TUS upload
 *     will succeed for the first 50 MB and then 413 from Supabase.
 *   - NEXT_PUBLIC_SUPABASE_URL must be set on Render and in .env.local.
 *     The browser needs it to build the TUS endpoint URL; the server-side
 *     SUPABASE_URL is invisible to client code.
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
  // Loose video check — we want to allow video/mp4, video/quicktime
  // (some browsers report .mov as that), etc. The form's <input
  // accept="video/mp4"> already filters at the OS level; this is a
  // backstop, not a strict gate.
  if (!contentType.startsWith("video/")) {
    return NextResponse.json(
      { error: "Only video/* uploads are supported" },
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

  // Storage path: tiktok/manual/<userId>/<uuid>.mp4
  // We deliberately do NOT trust the client's filename — using a uuid as
  // the basename prevents path-traversal tricks and collisions. The
  // userId prefix lets the finalize endpoint verify ownership by
  // checking startsWith(`tiktok/manual/${userId}/`) before signing a
  // read URL.
  const storagePath = `tiktok/manual/${userId}/${randomUUID()}.mp4`;

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

  // Return only what the browser needs: the storage path (to round-trip
  // back to the finalize endpoint) and the signed upload token (passed
  // to TUS in the x-signature header). We intentionally do NOT return
  // data.signedUrl — that's for the single-PUT uploadToSignedUrl flow,
  // which we don't use because it's not resumable.
  return NextResponse.json({
    storagePath,
    token: data.token,
    bucket: BUCKET,
  });
}
