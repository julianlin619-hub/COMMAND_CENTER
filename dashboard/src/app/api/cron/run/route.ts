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
 * values in render.yaml.
 *
 * Auth: same dual auth as other dashboard API routes (Clerk session or
 * CRON_SECRET bearer token — see lib/auth.ts).
 */
import { NextResponse } from "next/server";
import { verifyApiAuth } from "@/lib/auth";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";

// execFile runs a binary with an explicit argv array instead of a shell string.
// This is safer than exec() — which would spawn a shell and interpolate our
// path variables into the command line — because there's no shell to parse
// metacharacters, so paths with spaces or special characters can't be
// re-interpreted as shell syntax. Even though our paths come from trusted
// sources today (process.cwd + path.resolve), this eliminates a whole class
// of landmines for future edits.
const execFileAsync = promisify(execFile);

// python_deps/ holds third-party packages (httpx, supabase, pydantic, etc.).
// On Render it's created during the build phase; locally it's created on
// first cron invocation (pip IS available locally).
const depsDir = path.join(process.cwd(), "python_deps");

let depsReady: Promise<void> | null = null;

function ensurePythonDeps(): Promise<void> {
  if (!depsReady) {
    depsReady = (async () => {
      if (existsSync(depsDir)) return; // already exists (Render build or prior local run)

      // Locally, pip is available — install on first use
      const reqFile = path.resolve(process.cwd(), "..", "requirements.txt");
      try {
        await execFileAsync(
          "python3",
          ["-m", "pip", "install", `--target=${depsDir}`, "-r", reqFile],
          { timeout: 120_000 },
        );
      } catch {
        // pip unavailable (Render Node runtime) — if python_deps/ wasn't
        // created by the build phase, the cron will fail with a clear
        // ModuleNotFoundError rather than a cryptic pip error.
        depsReady = null;
      }
    })();
  }
  return depsReady;
}

// Build the env for Python subprocesses.
function pythonEnv(projectRoot: string) {
  return {
    ...process.env,
    PYTHONPATH: [
      depsDir,       // third-party deps (inside dashboard/)
      projectRoot,   // local packages (core/, platforms/, cron/)
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(":"),
  };
}

// Maps cron job names (from render.yaml) to their Python module paths.
// The startCommand in render.yaml is `python -m cron.<module>`.
const CRON_MODULES: Record<string, string> = {
  "threads-cron": "cron.threads_cron",
  "tiktok-pipeline": "cron.tiktok_pipeline",
  "tiktok-bank-pipeline": "cron.tiktok_bank_pipeline",
  "facebook-pipeline": "cron.facebook_pipeline",
  "instagram-pipeline": "cron.instagram_pipeline",
  "youtube-cron": "cron.youtube_cron",
  "linkedin-cron": "cron.linkedin_cron",
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

  const modulePath = CRON_MODULES[jobName];
  // Cron scripts live at the project root, one level above the dashboard/ dir.
  const projectRoot = path.resolve(process.cwd(), "..");

  // Create python_deps/ if it doesn't exist (locally, pip is available)
  await ensurePythonDeps();

  const startTime = Date.now();

  try {
    // modulePath comes from the hard-coded CRON_MODULES map above, so it
    // can never be user-controlled — but we still use execFile so the
    // shell can't misinterpret anything future edits introduce.
    const { stdout, stderr } = await execFileAsync(
      "python3",
      ["-m", modulePath],
      {
        cwd: projectRoot,
        // 5-minute timeout — pipelines with Apify + video generation can be slow
        timeout: 300_000,
        // 5 MB buffer — cron output is usually small but be safe
        maxBuffer: 5 * 1024 * 1024,
        env: pythonEnv(projectRoot),
      },
    );

    return NextResponse.json({
      job: jobName,
      status: "success",
      output: combineOutput(stdout, stderr),
      durationMs: Date.now() - startTime,
    });
  } catch (err: unknown) {
    // Python scripts call sys.exit(1) on failure, which causes exec to throw.
    // We still want to return stdout/stderr so the user can see what happened.
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    return NextResponse.json({
      job: jobName,
      status: "failed",
      output:
        combineOutput(e.stdout || "", e.stderr || "") || e.message || "Unknown error",
      durationMs: Date.now() - startTime,
      exitCode: e.code,
    });
  }
}

/** Merge stdout + stderr into a single string, trimming whitespace. */
function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}
