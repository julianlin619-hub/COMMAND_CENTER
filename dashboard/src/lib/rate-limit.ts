/**
 * In-memory rate limiter — dashboard/src/lib/rate-limit.ts
 *
 * Why in-memory (and not Redis/Upstash)?
 * The dashboard runs as a SINGLE persistent Node service on Render (see
 * render.yaml: one `type: web` instance). App Router route handlers run in the
 * Node runtime, so a module-level Map persists across requests for the life of
 * the process. That makes a tiny in-process counter sufficient for abuse/cost
 * protection without adding an external service. If the dashboard ever scales to
 * multiple instances, this is the seam to swap for a shared store (Upstash Redis
 * `@upstash/ratelimit`) — every caller goes through `rateLimit()`.
 *
 * IMPORTANT — this lives in ROUTE HANDLERS, not middleware. `middleware.ts` runs
 * on the Edge runtime, where per-instance in-memory state is unreliable (isolates
 * can be recycled/duplicated). Route handlers run in Node, where this Map is
 * stable. So we call `rateLimit()` from the handlers directly.
 */

import { NextResponse } from "next/server";

export interface RateLimitResult {
  allowed: boolean;
  /** The configured ceiling for this window. */
  limit: number;
  /** Requests still allowed in the current window (never negative). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset; 0 when the request was allowed. */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  /** Epoch ms when this window ends and the count resets. */
  resetAt: number;
}

// The single source of truth for all counters, keyed by e.g. `media:<ip>` or
// `content-gen:<userId>`. Module-level so it survives across requests.
const buckets = new Map<string, Bucket>();

// Two-tier memory guard. Without a cap, a flood of DISTINCT keys (e.g. rotated
// spoofed IPs) would grow the Map without bound.
//   SOFT_CAP — once crossed, sweep entries whose window already expired (cheap,
//              frees the common case where old keys simply aged out).
//   HARD_CAP — absolute ceiling. If distinct, STILL-ACTIVE keys push us past
//              this even after the sweep, evict the oldest (soonest to reset) as
//              a last-resort backstop so memory stays bounded under attack.
const SOFT_CAP = 10_000;
const HARD_CAP = 20_000;

function evictIfNeeded(now: number): void {
  if (buckets.size <= SOFT_CAP) return;

  // Tier 1: drop expired windows.
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  if (buckets.size <= HARD_CAP) return;

  // Tier 2: hard backstop. Sort by resetAt ascending (oldest windows first) and
  // drop enough to get back under the ceiling. This only bites under a
  // distinct-key flood — normal traffic never reaches HARD_CAP.
  const oldestFirst = [...buckets.entries()].sort(
    (a, b) => a[1].resetAt - b[1].resetAt,
  );
  const excess = buckets.size - HARD_CAP;
  for (let i = 0; i < excess; i++) buckets.delete(oldestFirst[i][0]);
}

/**
 * Fixed-window rate limit. First hit in a window seeds a fresh counter; each
 * subsequent hit increments it until `limit` is exceeded, then denies until the
 * window rolls over.
 *
 * Tradeoff (intentional): the fixed-window algorithm allows up to ~2x `limit`
 * across a window boundary — a client can spend its full budget at the end of
 * window N and again at the start of N+1. That's fine for cost/abuse protection
 * (it still bounds sustained throughput); it is NOT a precise per-interval
 * guarantee. If we ever need that, switch to a sliding window.
 */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  const { limit, windowMs } = opts;

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    // Start (or restart) the window.
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
    evictIfNeeded(now);
  }

  bucket.count += 1;

  const allowed = bucket.count <= limit;
  const remaining = Math.max(0, limit - bucket.count);
  const retryAfterSec = allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000);

  return { allowed, limit, remaining, resetAt: bucket.resetAt, retryAfterSec };
}

/**
 * Extract the client IP to rate-limit on. This is security-sensitive on public,
 * unauthenticated routes (e.g. /api/media/[id]) where the IP is the ONLY
 * identity — a spoofable source there defeats the limiter entirely.
 *
 * We deliberately do NOT trust the leftmost X-Forwarded-For token: that value is
 * supplied by the client and trivially forged. An attacker sends
 * `X-Forwarded-For: 9.9.9.9`; the trusted proxy APPENDS the real IP to the
 * right, so reading the leftmost returns the attacker-controlled value. Rotating
 * it per request would bypass the limit completely.
 *
 * Precedence, most-trustworthy first:
 *   1. CF-Connecting-IP — Cloudflare (which fronts this deployment) OVERWRITES
 *      any client-supplied copy with the real connecting IP, so it can't be
 *      spoofed by the caller. This is the authoritative source in normal traffic.
 *   2. True-Client-IP — Cloudflare's equivalent header; same guarantee.
 *   3. X-Forwarded-For, RIGHTMOST entry — the address our closest trusted proxy
 *      actually observed, never the client-claimed leftmost token.
 *   4. X-Real-IP, then "unknown".
 *
 * NOTE: the exact trustworthy X-Forwarded-For index depends on the real proxy
 * chain (Cloudflare → Render), which is not documented precisely. Before relying
 * on the XFF fallback in production, verify empirically per the rollout plan:
 * send a request with a forged X-Forwarded-For and confirm the forged value does
 * NOT become the returned IP. In normal Cloudflare-fronted traffic (1) is present
 * and the XFF fallback should not be reached.
 */
export function getClientIp(req: Request): string {
  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();

  const trueClientIp = req.headers.get("true-client-ip");
  if (trueClientIp) return trueClientIp.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    // Rightmost = closest trusted proxy's observation, NOT the client's claim.
    if (hops.length) return hops[hops.length - 1];
  }

  const xRealIp = req.headers.get("x-real-ip");
  if (xRealIp) return xRealIp.trim();

  return "unknown";
}

/**
 * Standard `RateLimit-*` response headers. Emitted on BOTH successful and
 * throttled responses so well-behaved clients can self-throttle before they hit
 * a 429. (Uses the draft IETF `RateLimit-*` names.)
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000))),
  };
}

/**
 * Build a consistent 429 response for a denied request, including `Retry-After`
 * (seconds) and the `RateLimit-*` headers.
 */
export function tooManyRequests(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: "Rate limit exceeded. Please slow down and try again shortly." },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSec),
        ...rateLimitHeaders(result),
      },
    },
  );
}
