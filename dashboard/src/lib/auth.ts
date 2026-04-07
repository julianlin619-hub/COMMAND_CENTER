import { auth } from "@clerk/nextjs/server";

/**
 * Dual auth for API routes:
 * 1. Clerk session (dashboard browsing)
 * 2. CRON_SECRET bearer token (cron job writes)
 *
 * Returns true if authenticated, false otherwise.
 */
export async function verifyApiAuth(request: Request): Promise<boolean> {
  // Check for CRON_SECRET in Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    if (token === process.env.CRON_SECRET) {
      return true;
    }
  }

  // Fall back to Clerk session auth
  const { userId } = await auth();
  return !!userId;
}
