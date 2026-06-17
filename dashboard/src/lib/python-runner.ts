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

import { execFile, spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
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

export type RunPythonOptions = {
  /** Hard kill the process after this many ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /**
   * Text to pipe to the module's stdin (then close it). Use this instead of an
   * argv entry for large inputs — a long string (e.g. a pasted transcript) can
   * exceed the OS argument-length limit when passed as a CLI arg, but stdin has
   * no such cap. Omit it and the child gets no stdin, exactly as before.
   */
  stdin?: string;
};

/**
 * Run `python3 -m <module> [...args]` from the project root.
 *
 * `moduleName` and `args` must be caller-controlled / validated — never raw
 * request input assembled into a module path. (Callers here pass a hard-coded
 * module and a server-generated UUID.) Large *data* inputs should go through
 * `opts.stdin`, not `args` — see RunPythonOptions.stdin.
 *
 * Returns status + captured output rather than throwing on a non-zero exit:
 * Python scripts call sys.exit(1) on failure (which makes execFile throw), but
 * we still want stdout/stderr so the caller can parse the JSON result line.
 */
export async function runPythonModule(
  moduleName: string,
  args: string[] = [],
  opts: RunPythonOptions = {},
): Promise<PythonRunResult> {
  await ensurePythonDeps();
  const startTime = Date.now();
  const execOptions = {
    cwd: projectRoot,
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 5 * 1024 * 1024, // 5 MB — output is usually small
    env: pythonEnv(),
  };
  try {
    // When the caller supplies stdin we can't use the promisified execFile
    // (it doesn't expose the child process to write to), so we run execFile
    // directly and pipe stdin ourselves. The no-stdin path keeps using
    // execFileAsync so its behavior/error shape is unchanged for existing
    // callers (api/cron/run, manual-upload batch).
    const { stdout, stderr } =
      opts.stdin !== undefined
        ? await execFileWithStdin(
            "python3",
            ["-m", moduleName, ...args],
            execOptions,
            opts.stdin,
          )
        : await execFileAsync("python3", ["-m", moduleName, ...args], execOptions);
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

/**
 * Run execFile and pipe `stdin` to the child's stdin, then close it.
 *
 * promisify(execFile) hides the ChildProcess, so we can't write to its stdin —
 * here we call execFile directly, resolve/reject in its callback (mirroring how
 * promisify would), and write stdin to the live child. On a non-zero exit the
 * Error already carries `.code`; we attach the captured `stdout`/`stderr` so the
 * caller's catch block can still read them, exactly like execFileAsync does.
 */
function execFileWithStdin(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
  stdin: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        // Match execFileAsync's rejection shape: stdout/stderr hang off the err.
        Object.assign(err, { stdout, stderr });
        reject(err);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
    // The child may have failed to spawn (no stdin stream); guard before use.
    if (child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE if the child exits before reading all input — the exit itself
        // surfaces via the execFile callback, so swallow this to avoid an
        // unhandled 'error' on the stdin stream.
      });
      child.stdin.end(stdin);
    }
  });
}

/**
 * Spawn `python3 -m <module> [...args]` and return the live child process so the
 * caller can STREAM its stdout (e.g. an SSE/NDJSON route). Unlike runPythonModule
 * (which buffers and returns once the process exits), this hands back the process
 * immediately. Same module/arg trust rules apply — never assemble the module path
 * from raw request input.
 */
export async function spawnPythonModule(
  moduleName: string,
  args: string[] = [],
  opts: { stdin?: string } = {},
): Promise<ChildProcessWithoutNullStreams> {
  await ensurePythonDeps();
  const child = spawn("python3", ["-m", moduleName, ...args], {
    cwd: projectRoot,
    env: pythonEnv(),
  });
  if (opts.stdin !== undefined) {
    // EPIPE if the child exits before reading all input — its exit surfaces via
    // the 'close' event, so swallow the stdin error to avoid an unhandled throw.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
  }
  return child;
}

/** Merge stdout + stderr into a single string, trimming whitespace. */
export function combineOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}
