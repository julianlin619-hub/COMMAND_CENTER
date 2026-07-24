import { auth } from "@clerk/nextjs/server";
import { timingSafeEqual } from "./timing-safe";

/**
 * Is this request a trusted cron caller (valid `Bearer <CRON_SECRET>`)?
 *
 * Cron jobs running on Render don't have a browser session, so they can't use
 * Clerk. Instead they send a shared secret in the Authorization header:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * We compare the FULL header against the full expected value, including the
 * "Bearer " prefix. This intentionally mirrors the comparison in
 * `dashboard/src/middleware.ts:isBearerAuthorized` — having both call sites do
 * the exact same thing means a malformed header (lowercase "bearer", missing
 * space, leading whitespace) is rejected by both layers instead of only one.
 * Constant-time compare avoids the timing side-channel that `===` exposes when
 * two strings are compared character-by-character.
 *
 * Exported so routes can also EXEMPT cron from per-user rate limits (cron runs
 * controlled batches; throttling it would stall the pipeline).
 */
export function isCronRequest(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!authHeader || !secret) return false;
  return timingSafeEqual(authHeader, `Bearer ${secret}`);
}

/**
 * Dual auth for API routes:
 * 1. Clerk session (dashboard browsing)
 * 2. CRON_SECRET bearer token (cron job writes)
 *
 * Returns true if authenticated, false otherwise.
 */
export async function verifyApiAuth(request: Request): Promise<boolean> {
  // --- Auth path 1: Bearer token (for cron jobs) ---
  // If it matches, the request is authorized immediately — no Clerk needed.
  if (isCronRequest(request)) {
    return true;
  }

  // --- Auth path 2: Clerk session (for dashboard users) ---
  // When a user is browsing the dashboard, Clerk automatically attaches a
  // session cookie to every request. `auth()` reads that cookie and returns
  // the user's ID if the session is valid. The `!!` converts the userId
  // to a boolean: truthy string -> true, null/undefined -> false.
  const { userId } = await auth();
  return !!userId;
}
