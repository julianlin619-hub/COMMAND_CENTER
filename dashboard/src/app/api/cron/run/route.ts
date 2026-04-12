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
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

// One-time bootstrap: install Python deps so `python3 -m cron.*` can import
// httpx, supabase, pydantic, etc. Runs once per process lifetime (i.e. once
// per container/dyno start on Render, or once per `next dev` locally).
let depsInstalled: Promise<void> | null = null;

function ensurePythonDeps(projectRoot: string): Promise<void> {
  if (!depsInstalled) {
    depsInstalled = (async () => {
      try {
        // Install third-party deps + the local packages (core/, platforms/, cron/)
        await execAsync("pip3 install -r requirements.txt && pip3 install -e .", {
          cwd: projectRoot,
          timeout: 120_000,
        });
      } catch {
        // Reset so next invocation retries
        depsInstalled = null;
        throw new Error("Failed to install Python dependencies");
      }
    })();
  }
  return depsInstalled;
}

// Maps cron job names (from render.yaml) to their Python module paths.
// The startCommand in render.yaml is `python -m cron.<module>`.
const CRON_MODULES: Record<string, string> = {
  "threads-cron": "cron.threads_cron",
  "tiktok-pipeline": "cron.tiktok_pipeline",
  "facebook-pipeline": "cron.facebook_pipeline",
  "instagram-cron": "cron.instagram_cron",
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

  // Ensure Python deps are installed (runs once per process lifetime)
  try {
    await ensurePythonDeps(projectRoot);
  } catch {
    return NextResponse.json(
      { error: "Failed to install Python dependencies. Check server logs." },
      { status: 500 },
    );
  }

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await execAsync(
      `python3 -m ${modulePath}`,
      {
        cwd: projectRoot,
        // 5-minute timeout — pipelines with Apify + video generation can be slow
        timeout: 300_000,
        // 5 MB buffer — cron output is usually small but be safe
        maxBuffer: 5 * 1024 * 1024,
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
