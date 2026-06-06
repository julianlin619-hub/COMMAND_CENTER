/**
 * POST /api/tiktok/manual-upload/batch
 *
 * Batch manual-upload pathway (auto title + caption). The browser has already
 * uploaded one mp4 directly to Supabase Storage via the signed URL from
 * /api/tiktok/manual-upload/sign-url. This endpoint, per file:
 *   1. Verifies the storagePath belongs to the calling user.
 *   2. Confirms the upload actually completed (the object exists).
 *   3. Inserts a `video_batch_jobs` row (status='pending').
 *   4. Spawns `python3 -m core.video_batch --job-id <id>` — the processor
 *      extracts audio (ffmpeg), transcribes (Deepgram), generates a title
 *      (Claude), picks a caption (RAG over the tweet bank), and fans the video
 *      out to Buffer for TikTok + YouTube Shorts + X, writing `posts` rows in
 *      the same shape as the single-file upload.
 *   5. Returns the processor's JSON result (generated title/caption + buffer
 *      ids, or an error) for the browser to display.
 *
 * Unlike the single-file finalize route, the title/caption are NOT supplied by
 * the user — they're generated. All the heavy lifting runs in the spawned
 * Python (which has ffmpeg + the LLM/RAG code), consistent with how
 * /api/cron/run spawns the existing pipelines. One spawn per file keeps each
 * run inside the 5-minute execFile budget.
 *
 * Auth: Clerk session only (we need the userId for the ownership check), same
 * rationale as sign-url/route.ts and the finalize route.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase";
import { runPythonModule } from "@/lib/python-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "media";

type BatchBody = { storagePath?: unknown };

/** Parse the processor's JSON result — the last non-empty stdout line. */
function parseResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      // Not JSON (a stray log line on stdout) — keep scanning upward.
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: BatchBody;
  try {
    body = (await req.json()) as BatchBody;
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const storagePath =
    typeof body.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json(
      { error: "Missing `storagePath` field" },
      { status: 400 },
    );
  }

  // Path-ownership check — sign-url always issues paths under
  // tiktok/manual/<userId>/, so any other prefix is a bug or an attempt to
  // claim someone else's upload. Reject traversal segments defensively too.
  const expectedPrefix = `tiktok/manual/${userId}/`;
  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    return NextResponse.json(
      { error: "storagePath does not belong to the authenticated user" },
      { status: 403 },
    );
  }

  const supabase = getSupabaseClient();

  // Confirm the upload actually finished — list() scoped to this user's dir.
  const basename = storagePath.slice(expectedPrefix.length);
  const { data: listed, error: listError } = await supabase.storage
    .from(BUCKET)
    .list(expectedPrefix.replace(/\/$/, ""), { search: basename });
  if (listError) {
    console.error("batch: storage list failed:", listError.message);
    return NextResponse.json(
      { error: `Storage check failed: ${listError.message}` },
      { status: 500 },
    );
  }
  if (!(listed ?? []).some((entry) => entry.name === basename)) {
    return NextResponse.json(
      { error: "Upload did not complete — object not found in Storage" },
      { status: 404 },
    );
  }

  // Enqueue the job. The row is the processor's idempotency guard (it only
  // processes a 'pending' row) and the UI's progress record.
  const { data: job, error: insertError } = await supabase
    .from("video_batch_jobs")
    .insert({ user_id: userId, storage_path: storagePath })
    .select("id")
    .single();
  if (insertError || !job) {
    console.error("batch: job insert failed:", insertError?.message);
    return NextResponse.json(
      { error: `Job insert failed: ${insertError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Spawn the processor for this one job. The module is hard-coded and the
  // job id is a server-generated UUID, so nothing user-controlled reaches the
  // argv. 5-minute timeout matches the execFile budget for one short clip.
  const run = await runPythonModule("core.video_batch", ["--job-id", job.id]);
  const result = parseResult(run.stdout);

  if (run.status === "failed" || !result || result.status === "failed") {
    const error =
      (result?.error as string | undefined) ||
      run.stderr.trim().split("\n").slice(-3).join("\n") ||
      "Processing failed";
    return NextResponse.json(
      { ok: false, jobId: job.id, error },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, jobId: job.id, ...result });
}
