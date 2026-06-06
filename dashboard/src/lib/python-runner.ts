/**
 * Spawn project Python modules from the dashboard.
 *
 * The dashboard occasionally needs to run the repo's Python code as a child
 * process — the "Run cron now" button (api/cron/run) and the batch-video
 * manual-upload pathway (api/tiktok/manual-upload/batch) both do this. The
 * mechanics are identical, so they live here once:
 *   - locate / lazily install python_deps (third-party packages),
 *   - build PYTHONPATH so the spawned process can import core/ + python_deps,
 *   - run `python3 -m <module>` with execFile (no shell — no metacharacter
 *     interpretation, see note below).
 *
 * On Render, python_deps/ is created during the web service's build phase
 * (see render.yaml buildCommand). Locally it's created on first use (pip is
 * available there).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";

// execFile runs a binary with an explicit argv array instead of a shell string.
// This is safer than exec() — there's no shell to parse metacharacters, so
// paths/args with spaces or special characters can't be reinterpreted as shell
// syntax. Args still must come from trusted sources (never raw user input).
const execFileAsync = promisify(execFile);

// python_deps/ holds third-party packages (httpx, supabase, pydantic, etc.).
// On Render it's created during the build phase; locally on first invocation.
const depsDir = path.join(process.cwd(), "python_deps");

// Cron/processor scripts live at the project root, one level above dashboard/.
const projectRoot = path.resolve(process.cwd(), "..");

let depsReady: Promise<void> | null = null;

/** Ensure python_deps/ exists, installing locally if pip is available. */
export function ensurePythonDeps(): Promise<void> {
  if (!depsReady) {
    depsReady = (async () => {
      if (existsSync(depsDir)) return; // already present (Render build or prior run)

      // Locally, pip is available — install on first use.
      const reqFile = path.resolve(process.cwd(), "..", "requirements.txt");
      try {
        await execFileAsync(
          "python3",
          ["-m", "pip", "install", `--target=${depsDir}`, "-r", reqFile],
          { timeout: 120_000 },
        );
      } catch {
        // pip unavailable (Render Node runtime) — if python_deps/ wasn't
        // created by the build phase, the spawn will fail with a clear
        // ModuleNotFoundError rather than a cryptic pip error.
        depsReady = null;
      }
    })();
  }
  return depsReady;
}

/** Build the env for Python subprocesses (PYTHONPATH = deps + project root). */
function pythonEnv() {
  return {
    ...process.env,
    PYTHONPATH: [depsDir, projectRoot, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(":"),
  };
}

export type PythonRunResult = {
  status: "success" | "failed";
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode?: number | string;
};

/**
 * Run `python3 -m <module> [...args]` from the project root.
 *
 * `moduleName` and `args` must be caller-controlled / validated — never raw
 * request input assembled into a module path. (Callers here pass a hard-coded
 * module and a server-generated UUID.)
 *
 * Returns status + captured output rather than throwing on a non-zero exit:
 * Python scripts call sys.exit(1) on failure (which makes execFile throw), but
 * we still want stdout/stderr so the caller can parse the JSON result line.
 */
export async function runPythonModule(
  moduleName: string,
  args: string[] = [],
  timeoutMs = 300_000,
): Promise<PythonRunResult> {
  await ensurePythonDeps();
  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      ["-m", moduleName, ...args],
      {
        cwd: projectRoot,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024, // 5 MB — output is usually small
        env: pythonEnv(),
      },
    );
    return {
      status: "success",
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    return {
      status: "failed",
      stdout: e.stdout ?? "",
      stderr: e.stderr || e.message || "",
      durationMs: Date.now() - startTime,
      exitCode: e.code,
    };
  }
}

/** Merge stdout + stderr into a single string, trimming whitespace. */
export function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}
