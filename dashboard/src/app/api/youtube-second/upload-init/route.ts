/**
 * POST /api/youtube-second/upload-init
 *
 * Step 1 of the browser-direct YouTube upload flow. Does NOT accept the
 * video bytes — only metadata. Returns a resumable upload URL the browser
 * then PUTs the file to directly.
 *
 * Responsibilities:
 *   1. Auth + input validation.
 *   2. Atomically claim the next publish slot (Postgres advisory lock +
 *      partial unique index safety net).
 *   3. Insert a `posts` row in status='uploading_to_youtube'.
 *   4. Refresh a YouTube OAuth access token.
 *   5. Initialize a YouTube resumable upload session; return its URL.
 *
 * Anything that fails between steps 3 and 5 flips the row to 'failed' and
 * clears metadata.publish_at so the slot returns to the pool.
 */

import { NextResponse } from "next/server";
import postgres from "postgres";
import { verifyApiAuth } from "@/lib/auth";
import { refreshOauthToken, OAuthRefreshError } from "@/lib/google-oauth";
import {
  assignNextSlot,
  SlotExhaustedError,
} from "@/lib/youtube-second-scheduler";
import {
  DESCRIPTION,
  CATEGORY_ID,
  PRIVACY_STATUS,
  MADE_FOR_KIDS,
  LICENSE,
  EMBEDDABLE,
  PUBLIC_STATS_VIEWABLE,
  DEFAULT_LANGUAGE,
  DEFAULT_AUDIO_LANGUAGE,
} from "@/lib/youtube-second-defaults";

export const runtime = "nodejs";

const MAX_TITLE_LENGTH = 100;
const MAX_FILE_SIZE_BYTES = 256 * 1024 * 1024 * 1024; // 256 GB (YouTube cap)
const SLOT_CLAIM_MAX_ATTEMPTS = 3;

// Browser origins we're willing to forward to Google as the CORS origin
// on the resumable upload URL. Anything else is ignored with a warn and
// we fall back to YOUTUBE_SECOND_BROWSER_ORIGIN.
//
// Why allowlist at all? Without it, an authenticated attacker from a
// different origin could call this route and get an upload URL scoped to
// *their* origin. Limited blast radius (they're burning their own slot on
// our channel), but trivial to prevent.
//
// Configurable via YOUTUBE_SECOND_ALLOWED_ORIGINS (comma-separated) so a
// staging domain can be added without a code change.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.media-command.com",
  "http://localhost:3000",
];
const ALLOWED_BROWSER_ORIGINS: ReadonlySet<string> = new Set(
  (process.env.YOUTUBE_SECOND_ALLOWED_ORIGINS
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)) ?? DEFAULT_ALLOWED_ORIGINS,
);
const FALLBACK_BROWSER_ORIGIN =
  process.env.YOUTUBE_SECOND_BROWSER_ORIGIN ?? "https://app.media-command.com";

// Hardcoded lock key for pg_advisory_xact_lock. We pick a fixed value
// rather than hashtext('youtube_second_scheduler') because hashtext()
// returns int4, and pg_advisory_xact_lock(int8) / (int4, int4) have
// different signatures — easy to get wrong and serialize against the
// wrong lock. Passed as a regular number and cast to bigint in SQL so
// TypeScript + the postgres driver stay happy (bigint literals would
// require ES2020+).
const SLOT_LOCK_KEY = 918273645;

// Module-level connection handle — reuse across invocations to avoid
// per-request TCP handshakes. Instantiated lazily on first use.
let sqlHandle: ReturnType<typeof postgres> | null = null;
function getSql() {
  if (sqlHandle) return sqlHandle;
  const url = process.env.SUPABASE_SESSION_POOLER_URL;
  if (!url) {
    throw new Error(
      "SUPABASE_SESSION_POOLER_URL not set — required for youtube_second slot-claim tx.",
    );
  }
  sqlHandle = postgres(url, {
    // prepare: false works with both transaction and session poolers.
    prepare: false,
    // Keep the pool small — this route is low-traffic. One connection is
    // enough; allowing more just burns Supabase slots.
    max: 2,
    idle_timeout: 20,
  });
  return sqlHandle;
}

interface InitBody {
  title?: unknown;
  filename?: unknown;
  size?: unknown;
  content_type?: unknown;
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as InitBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Input validation — fail fast before touching the DB or YouTube.
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `title must be 1–${MAX_TITLE_LENGTH} chars` },
      { status: 400 },
    );
  }

  const size = typeof body.size === "number" ? body.size : NaN;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `size must be 1..${MAX_FILE_SIZE_BYTES} bytes` },
      { status: 400 },
    );
  }

  const contentType =
    typeof body.content_type === "string" ? body.content_type : "";
  if (!contentType.startsWith("video/")) {
    return NextResponse.json(
      { error: "content_type must start with 'video/'" },
      { status: 400 },
    );
  }

  // Env checks — pulled up front so we don't claim a slot just to fail
  // minting a token 200ms later.
  const clientId = process.env.YOUTUBE_SECOND_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_SECOND_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_SECOND_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      "youtube_second upload-init: missing YOUTUBE_SECOND_* env vars",
    );
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 },
    );
  }

  // Google mirrors the Origin header we send on the init POST back onto
  // the resumable upload URL's CORS responses. Without this, the browser
  // blocks the subsequent PUT with "no Access-Control-Allow-Origin header."
  //
  // We only forward origins in ALLOWED_BROWSER_ORIGINS. An unknown origin
  // is logged (for abuse spotting in Render logs) and falls back to the
  // canonical production origin — this means a malicious caller can't
  // cause us to mint an upload URL scoped to their origin.
  const incomingOrigin = request.headers.get("origin");
  let browserOrigin: string;
  if (incomingOrigin && ALLOWED_BROWSER_ORIGINS.has(incomingOrigin)) {
    browserOrigin = incomingOrigin;
  } else {
    if (incomingOrigin) {
      console.warn(
        "youtube_second upload-init: rejected origin %s (not in allowlist)",
        incomingOrigin,
      );
    }
    browserOrigin = FALLBACK_BROWSER_ORIGIN;
  }

  // ── Step 1: claim slot + insert row ─────────────────────────────────
  let claim: { postId: string; publishAt: string };
  try {
    claim = await claimSlotAndInsert(title);
  } catch (err) {
    if (err instanceof SlotExhaustedError) {
      return NextResponse.json(
        { error: "No free publish slot in next 30 days" },
        { status: 503 },
      );
    }
    // Dump every field the postgres driver exposes — `code` alone often
    // isn't enough to diagnose type-inference issues (you need `position`
    // pointing at the parameter, `hint`, etc.). The raw `err` is still
    // sanitized so we don't leak Bearer tokens into Render logs even if
    // an error message accidentally includes one.
    logPgError("youtube_second slot claim failed", err);
    return NextResponse.json(
      { error: "Could not claim publish slot" },
      { status: 500 },
    );
  }

  // ── Step 2: refresh token + init YouTube resumable upload ───────────
  try {
    const { accessToken } = await refreshOauthToken({
      clientId,
      clientSecret,
      refreshToken,
    });

    const uploadUrl = await initYouTubeResumableUpload({
      accessToken,
      title,
      publishAt: claim.publishAt,
      sizeBytes: size,
      contentType,
      browserOrigin,
    });

    return NextResponse.json({
      post_id: claim.postId,
      upload_url: uploadUrl,
      publish_at: claim.publishAt,
    });
  } catch (err) {
    // Release the slot so the user can retry without waiting 144 minutes.
    await markFailedAndReleaseSlot(claim.postId, err).catch((e) => {
      console.error("youtube_second failure cleanup also failed:", sanitize(e));
    });

    const status = err instanceof OAuthRefreshError ? 502 : 500;
    return NextResponse.json(
      { error: "Failed to initialize YouTube upload" },
      { status },
    );
  }
}

// ── Slot-claim transaction ────────────────────────────────────────────

async function claimSlotAndInsert(
  title: string,
): Promise<{ postId: string; publishAt: string }> {
  const sql = getSql();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < SLOT_CLAIM_MAX_ATTEMPTS; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        // Serialize all concurrent claim transactions against a single
        // hardcoded bigint key. Advisory locks are tx-scoped — released
        // on COMMIT / ROLLBACK automatically.
        await tx`SELECT pg_advisory_xact_lock(${SLOT_LOCK_KEY}::bigint)`;

        // Snapshot the currently taken future slots. Exclude 'failed' rows
        // so their slots return to the pool; exclude slots already in the
        // past so rolling-forward to tomorrow works correctly.
        //
        // Literal enum comparison ('youtube_second') is fine here — Postgres
        // casts the string literal to platform_enum at plan time. No parameter.
        const taken = await tx<
          { publish_at: string }[]
        >`
          SELECT metadata->>'publish_at' AS publish_at
          FROM posts
          WHERE platform = 'youtube_second'
            AND metadata ? 'publish_at'
            AND status <> 'failed'
            AND (metadata->>'publish_at')::timestamptz > now()
        `;

        const takenIso = taken.map((r) =>
          new Date(r.publish_at).toISOString(),
        );
        const publishAt = assignNextSlot(new Date(), takenIso);

        // Build the JSONB value in JS and cast it on the wire. Previously
        // we used jsonb_build_object('publish_at', $2), but that function
        // is VARIADIC "any" so Postgres can't infer $2's type and the
        // query fails with "could not determine data type of parameter $2".
        // Serializing once + a single ::jsonb cast sidesteps the problem.
        //
        // platform and status are cast to their enum types explicitly so
        // parameter inference on parameterized queries never surprises us
        // in the future (the driver sends them as text otherwise).
        const metadataJson = JSON.stringify({ publish_at: publishAt });

        const inserted = await tx<{ id: string }[]>`
          INSERT INTO posts (platform, status, title, metadata)
          VALUES (
            ${"youtube_second"}::platform_enum,
            ${"uploading_to_youtube"}::post_status,
            ${title},
            ${metadataJson}::jsonb
          )
          RETURNING id
        `;

        return { postId: inserted[0].id, publishAt };
      });
    } catch (err: unknown) {
      lastError = err;
      // 23505 = unique_violation — partial index tripped because another
      // tx raced past the advisory lock (shouldn't happen, but the index
      // is belt+braces). Retry with a fresh snapshot.
      const code = (err as { code?: string } | null)?.code;
      if (code === "23505") continue;
      // SlotExhausted and other errors bubble up — not retry-worthy.
      throw err;
    }
  }

  throw lastError ?? new Error("slot claim retries exhausted");
}

async function markFailedAndReleaseSlot(
  postId: string,
  err: unknown,
): Promise<void> {
  const sql = getSql();
  const message = sanitize(err).slice(0, 500);
  await sql`
    UPDATE posts
    SET status = 'failed',
        error_message = ${message},
        metadata = metadata - 'publish_at'
    WHERE id = ${postId}
  `;
}

// ── YouTube resumable upload init ─────────────────────────────────────

interface InitYtArgs {
  accessToken: string;
  title: string;
  publishAt: string;
  sizeBytes: number;
  contentType: string;
  /** Passed to Google as Origin; echoed onto the upload URL's CORS response. */
  browserOrigin: string;
}

async function initYouTubeResumableUpload(args: InitYtArgs): Promise<string> {
  // Request body is the video resource: snippet + status.
  const payload = {
    snippet: {
      title: args.title,
      description: DESCRIPTION,
      categoryId: CATEGORY_ID,
      defaultLanguage: DEFAULT_LANGUAGE,
      defaultAudioLanguage: DEFAULT_AUDIO_LANGUAGE,
    },
    status: {
      privacyStatus: PRIVACY_STATUS,
      publishAt: args.publishAt,
      selfDeclaredMadeForKids: MADE_FOR_KIDS,
      license: LICENSE,
      embeddable: EMBEDDABLE,
      publicStatsViewable: PUBLIC_STATS_VIEWABLE,
    },
  };

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(args.sizeBytes),
        "X-Upload-Content-Type": args.contentType,
        // See comment where browserOrigin is derived — this is what makes
        // the eventual browser PUTs pass CORS.
        Origin: args.browserOrigin,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!res.ok) {
    // Surface the response body so we can see the real reason (quota, auth,
    // bad payload). Sanitized + length-capped. Authorization/access token
    // never appear in the body; still run sanitize() as belt+braces.
    const bodyText = await res.text().catch(() => "");
    console.error("youtube_second upload-init resumable-init failed", {
      status: res.status,
      body: sanitize(bodyText).slice(0, 1000),
      sizeBytes: args.sizeBytes,
      contentType: args.contentType,
      browserOrigin: args.browserOrigin,
    });
    throw new Error(
      `YouTube resumable init failed: ${res.status}`,
    );
  }

  const uploadUrl = res.headers.get("Location");
  if (!uploadUrl) {
    throw new Error(
      "YouTube resumable init returned no Location header.",
    );
  }

  // Intentionally NOT logged — this URL is a one-time bearer credential.
  return uploadUrl;
}

// ── Error sanitization ───────────────────────────────────────────────

function sanitize(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[REDACTED]");
}

/**
 * Log a Postgres error with every field the `postgres` driver populates.
 * `code`/`detail`/`hint`/`position`/`constraint` are the ones that
 * actually make type-inference and constraint-violation bugs debuggable.
 * Values are passed through sanitize() for belt-and-braces protection.
 */
function logPgError(prefix: string, err: unknown): void {
  if (!err || typeof err !== "object") {
    console.error(`${prefix}:`, sanitize(err));
    return;
  }
  const e = err as {
    message?: string;
    code?: string;
    detail?: string;
    hint?: string;
    position?: string;
    severity?: string;
    schema_name?: string;
    table_name?: string;
    column_name?: string;
    constraint_name?: string;
    where?: string;
    routine?: string;
  };
  console.error(prefix, {
    message: e.message ? sanitize(e.message) : undefined,
    code: e.code,
    detail: e.detail ? sanitize(e.detail) : undefined,
    hint: e.hint,
    position: e.position,
    severity: e.severity,
    schema: e.schema_name,
    table: e.table_name,
    column: e.column_name,
    constraint: e.constraint_name,
    where: e.where ? sanitize(e.where) : undefined,
    routine: e.routine,
  });
}
