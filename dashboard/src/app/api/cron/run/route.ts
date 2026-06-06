/**
 * Cron Run API — actually execute a cron job and return its output.
 *
 * POST /api/cron/run
 * Body: { job: string }  — one of the cron job names from render.yaml
 *
 * Unlike /api/cron/test-run (which is read-only), this endpoint spawns the
 * real Python cron script as a child process — it WILL publish posts, call
 * Apify/Buffer, and write to the database. Use with care.
 *
 * The cron scripts live at the project root (one level above dashboard/)
 * and are run via `python3 -m cron.<module>`, matching the startCommand
 * values in render.yaml. The spawn mechanics live in lib/python-runner.ts
 * (shared with the batch-video manual-upload pathway).
 *
 * Auth: same dual auth as other dashboard API routes (Clerk session or
 * CRON_SECRET bearer token — see lib/auth.ts).
 */
import { NextResponse } from "next/server";
import { verifyApiAuth } from "@/lib/auth";
import { runPythonModule, combineOutput } from "@/lib/python-runner";

// Maps cron job names (from render.yaml) to their Python module paths.
// The startCommand in render.yaml is `python -m cron.<module>`.
//
// tiktok-pipeline + tiktok-bank-pipeline are the two unified Tweet Card
// crons — each fans out to TikTok + Facebook + LinkedIn in-process, so
// there are no separate facebook-*/linkedin-* entries anymore.
const CRON_MODULES: Record<string, string> = {
  "threads-cron": "cron.threads_cron",
  "threads-leila-cron": "cron.threads_leila_cron",
  "tiktok-pipeline": "cron.tiktok_pipeline",
  "tiktok-bank-pipeline": "cron.tiktok_bank_pipeline",
  "youtube-cron": "cron.youtube_cron",
  "linkedin-leila-cron": "cron.linkedin_leila_cron",
};

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const jobName = body.job as string | undefined;

  if (!jobName || !CRON_MODULES[jobName]) {
    return NextResponse.json(
      {
        error: `Invalid job name. Valid names: ${Object.keys(CRON_MODULES).join(", ")}`,
      },
      { status: 400 },
    );
  }

  // modulePath comes from the hard-coded CRON_MODULES map, so it's never
  // user-controlled. 5-minute timeout — pipelines with Apify + video
  // generation can be slow.
  const result = await runPythonModule(CRON_MODULES[jobName]);

  return NextResponse.json({
    job: jobName,
    status: result.status,
    output:
      combineOutput(result.stdout, result.stderr) ||
      (result.status === "failed" ? "Unknown error" : ""),
    durationMs: result.durationMs,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  });
}
