import { auth } from "@clerk/nextjs/server";
import { timingSafeEqual } from "./timing-safe";

/**
 * Dual auth for API routes:
 * 1. Clerk session (dashboard browsing)
 * 2. CRON_SECRET bearer token (cron job writes)
 *
 * Returns true if authenticated, false otherwise.
 */
export async function verifyApiAuth(request: Request): Promise<boolean> {
  // --- Auth path 1: Bearer token (for cron jobs) ---
  // Cron jobs running on Render don't have a browser session, so they can't
  // use Clerk. Instead, they send a shared secret in the Authorization header:
  //   Authorization: Bearer <CRON_SECRET>
  // We compare this token against the CRON_SECRET environment variable.
  // If it matches, the request is authorized immediately — no Clerk needed.
  const authHeader = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (authHeader && secret) {
    const token = authHeader.replace("Bearer ", "");
    // Constant-time compare — avoids the timing side-channel that `===`
    // exposes when two strings are compared character-by-character.
    if (timingSafeEqual(token, secret)) {
      return true;
    }
  }

  // --- Auth path 2: Clerk session (for dashboard users) ---
  // When a user is browsing the dashboard, Clerk automatically attaches a
  // session cookie to every request. `auth()` reads that cookie and returns
  // the user's ID if the session is valid. The `!!` converts the userId
  // to a boolean: truthy string -> true, null/undefined -> false.
  const { userId } = await auth();
  return !!userId;
}
