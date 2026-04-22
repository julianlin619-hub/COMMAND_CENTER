/**
 * Browser-side helper that streams a File directly to a YouTube resumable
 * upload URL obtained from /api/youtube-second/upload-init.
 *
 * Why XMLHttpRequest and not fetch?
 *   fetch() has no upload-progress event. It can only report *download*
 *   progress via a response-body ReadableStream. Since we're PUT-ing
 *   multi-GB files and need a progress bar, XHR is non-negotiable.
 *
 * Protocol summary (Google's resumable upload spec):
 *   - Chunks must be a multiple of 256 KB (except the final chunk).
 *   - Each chunk is a PUT to the same upload URL with Content-Range:
 *       bytes <start>-<end>/<total>
 *   - Intermediate chunk responses return 308 with a Range header
 *       Range: bytes=0-<lastReceivedByte>
 *     telling you where to resume from.
 *   - The final chunk returns 200/201 with the video resource JSON.
 *   - Upload URLs are valid for 7 days.
 *
 * We deliberately do NOT set Content-Length — it's a browser-forbidden
 * header; the browser computes it from the Blob/ArrayBuffer body.
 */

// 64 MB — a multiple of 256 KB as required. Small enough that a single
// chunk retry at 95% upload only re-sends ~25 seconds of bandwidth; large
// enough that RTT overhead is negligible even over slow links.
export const CHUNK_SIZE = 64 * 1024 * 1024;

const MAX_CHUNK_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

export interface UploadResult {
  /** YouTube video ID returned in the final chunk's response body. */
  videoId: string;
}

export interface UploadOptions {
  /** Called after each progress tick with bytes uploaded / total bytes. */
  onProgress?: (loaded: number, total: number) => void;
  /** AbortSignal for user-cancel support (e.g., navigating away). */
  signal?: AbortSignal;
}

/**
 * PUT `file` to `uploadUrl` using YouTube's resumable chunked protocol.
 *
 * Returns the video ID parsed from the final chunk's response.
 * Throws Error on terminal failure (non-retryable HTTP status, max retries
 * exceeded, or abort).
 */
export async function uploadToYouTube(
  uploadUrl: string,
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { onProgress, signal } = options;
  const total = file.size;

  // Single-shot path for small files — a ≤64MB PUT is simpler and avoids
  // the 308-resume round-trip. Content-Range still required by YouTube.
  if (total <= CHUNK_SIZE) {
    const response = await putChunk({
      uploadUrl,
      blob: file,
      start: 0,
      end: total - 1,
      total,
      onProgress: (loaded) => onProgress?.(loaded, total),
      signal,
    });
    return parseFinalResponse(response);
  }

  // Chunked path for large files.
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total) - 1;
    const blob = file.slice(offset, end + 1);
    const chunkStart = offset;

    const response = await putChunk({
      uploadUrl,
      blob,
      start: chunkStart,
      end,
      total,
      onProgress: (chunkLoaded) => onProgress?.(chunkStart + chunkLoaded, total),
      signal,
    });

    // Final chunk → 200/201 with video resource JSON.
    if (response.status === 200 || response.status === 201) {
      return parseFinalResponse(response);
    }

    // Intermediate chunk → 308 with Range: bytes=0-<lastByte>.
    // We trust the server's lastByte rather than our own `end` in case a
    // partial chunk was accepted (rare but defined by the spec).
    if (response.status === 308) {
      const range = response.headers["range"];
      const parsed = parseRangeHeader(range);
      offset = parsed !== null ? parsed + 1 : end + 1;
      continue;
    }

    // Any other status is unexpected; bail.
    throw new Error(
      `Unexpected status ${response.status} from YouTube mid-upload: ${response.body.slice(0, 200)}`,
    );
  }

  // If we exit the loop without a terminal 200/201, that's a protocol bug.
  throw new Error("Upload loop ended without a final response from YouTube.");
}

// ── Helpers ────────────────────────────────────────────────────────────

interface ChunkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface PutChunkArgs {
  uploadUrl: string;
  blob: Blob;
  start: number;
  end: number;
  total: number;
  onProgress: (loadedInChunk: number) => void;
  signal?: AbortSignal;
}

/**
 * Send one chunk via XHR with retry on 5xx / network errors. Returns the
 * final response (which may be 308, 200, 201, or — after exhausted retries
 * — throws).
 */
async function putChunk(args: PutChunkArgs): Promise<ChunkResponse> {
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt < MAX_CHUNK_ATTEMPTS) {
    try {
      return await sendChunkOnce(args);
    } catch (err) {
      lastError = err;
      // Abort is terminal — never retry a user-cancel.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Treat RetryableHttpError and network errors as retryable.
      if (!(err instanceof RetryableHttpError) && !(err instanceof NetworkError)) {
        throw err;
      }
      attempt++;
      if (attempt >= MAX_CHUNK_ATTEMPTS) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw new Error(
    `Chunk upload failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

class RetryableHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Retryable HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

class NetworkError extends Error {
  constructor() {
    super("Network error");
  }
}

function sendChunkOnce(args: PutChunkArgs): Promise<ChunkResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", args.uploadUrl, true);

    // Content-Range is required on every chunk.
    xhr.setRequestHeader(
      "Content-Range",
      `bytes ${args.start}-${args.end}/${args.total}`,
    );

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable) args.onProgress(event.loaded);
    };

    xhr.onload = () => {
      const headers = parseAllHeaders(xhr.getAllResponseHeaders());
      const status = xhr.status;
      const body = xhr.responseText ?? "";

      // 5xx is transient — retry.
      if (status >= 500 && status < 600) {
        reject(new RetryableHttpError(status, body));
        return;
      }

      resolve({ status, headers, body });
    };

    xhr.onerror = () => reject(new NetworkError());
    xhr.ontimeout = () => reject(new NetworkError());
    xhr.onabort = () =>
      reject(new DOMException("Upload aborted by user", "AbortError"));

    if (args.signal) {
      if (args.signal.aborted) {
        xhr.abort();
        return;
      }
      args.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(args.blob);
  });
}

function parseFinalResponse(response: ChunkResponse): UploadResult {
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed?.id !== "string" || !parsed.id) {
      throw new Error("missing id");
    }
    return { videoId: parsed.id };
  } catch {
    throw new Error(
      `Could not parse video id from YouTube final response: ${response.body.slice(0, 200)}`,
    );
  }
}

/** Parse `Range: bytes=0-<n>` → n, or null if missing/malformed. */
function parseRangeHeader(header: string | undefined): number | null {
  if (!header) return null;
  const m = header.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Flatten XHR's multi-line header string into a lowercase-keyed record. */
function parseAllHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
