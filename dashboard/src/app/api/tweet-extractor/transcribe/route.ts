/**
 * POST /api/tweet-extractor/transcribe
 *
 * Step ① of the Tweet Extractor: transcribe a LOCAL media file. There is no
 * upload — the dashboard runs on the same machine as the file, so the browser
 * sends an absolute file path and the spawned Python worker
 * (`python -m core.transcribe_media --file-path <path>`) reads it directly with
 * ffmpeg, transcribes it via Deepgram (chunking hours-long audio), and prints
 * the transcript. The transcript flows back to the UI for step ② (extraction).
 *
 * ⚠️ SECURITY: reading an arbitrary local path is fine on the user's own machine
 * but would be an arbitrary-file-read vulnerability if exposed on a server, so
 * this route is DISABLED in production (NODE_ENV=production). It's a local-dev
 * convenience, deliberately not a deployed feature.
 *
 * Auth: verifyApiAuth (Clerk session OR CRON_SECRET), the house rule for every
 * dashboard API route.
 */

import { NextRequest, NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { verifyApiAuth } from "@/lib/auth";
import { runPythonModule } from "@/lib/python-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TranscribeBody = { filePath?: unknown };

/** Parse the worker's JSON result — the last non-empty stdout line. */
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
  // Local-file reading is a dev-only convenience — never expose it on a server.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Local-file transcription is disabled in production." },
      { status: 403 },
    );
  }

  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TranscribeBody;
  try {
    body = (await req.json()) as TranscribeBody;
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
  if (!filePath) {
    return NextResponse.json(
      { error: "Missing `filePath` field" },
      { status: 400 },
    );
  }
  // Must be an absolute path to a real file — give a clean error before we
  // bother spawning Python.
  if (!filePath.startsWith("/")) {
    return NextResponse.json(
      { error: "Provide an absolute path (starting with /)." },
      { status: 400 },
    );
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return NextResponse.json(
      { error: `No file found at: ${filePath}` },
      { status: 404 },
    );
  }

  // Spawn the transcription worker. A long recording (e.g. a 4-hour clip) means
  // a single audio-only ffmpeg pass + several chunked Deepgram calls, so we give
  // it a 25-minute budget instead of the default 5 — comfortably above the
  // worker's own ffmpeg cap so the whole job (extract + transcribe) can finish.
  const run = await runPythonModule(
    "core.transcribe_media",
    ["--file-path", filePath],
    { timeoutMs: 25 * 60 * 1000 },
  );
  const result = parseResult(run.stdout);

  if (run.status === "failed" || !result || result.error || !result.transcript) {
    const error =
      (result?.error as string | undefined) ||
      run.stderr.trim().split("\n").slice(-3).join("\n") ||
      "Transcription failed";
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }

  // sentences = whole-recording [{text,start,end}] for the timestamp view +
  // per-tweet timestamp mapping (may be absent for an odd Deepgram response).
  return NextResponse.json({
    ok: true,
    transcript: result.transcript,
    sentences: Array.isArray(result.sentences) ? result.sentences : [],
  });
}
