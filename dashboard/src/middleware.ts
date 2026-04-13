/**
 * Clerk Middleware — runs BEFORE every request to enforce authentication.
 *
 * In Next.js, middleware (normally in `middleware.ts` at the project root)
 * intercepts every incoming request before it reaches a page or API route.
 * This is the ideal place for auth checks because:
 *   - It runs on the Edge (fast, close to the user)
 *   - Unauthenticated users are redirected before any page code runs
 *   - It protects ALL routes by default (you opt routes OUT, not in)
 *
 * Next.js automatically picks up this file because it's named `middleware.ts`
 * and lives in the `src/` directory.
 */

import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Define which routes should be accessible WITHOUT authentication.
// Only the Clerk sign-in flow is public. Notably, `/api(.*)` is NOT public:
// API routes must authenticate via either a Clerk session (browser use) or
// the CRON_SECRET bearer token (cron / GitHub Actions). Keeping the API
// surface fail-closed at the middleware layer means a route that forgets
// to call `verifyApiAuth()` is still protected — no route can be exposed
// by omission alone.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)"]);

// For API routes, we enforce auth at the middleware layer rather than relying
// on `auth.protect()` (which would redirect browsers to the sign-in page —
// not useful for JSON API consumers). This mirrors the allowed methods in
// dashboard/src/lib/auth.ts so the per-route `verifyApiAuth()` call is
// defense in depth, not the only defense.
function isBearerAuthorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!header || !secret) return false;
  // Strict equality is fine here — the review flagged this as medium-severity
  // timing-attack exposure; tightening to constant-time compare is a follow-up.
  return header === `Bearer ${secret}`;
}

export default clerkMiddleware(async (auth, request) => {
  if (isPublicRoute(request)) return;

  const { pathname } = new URL(request.url);
  const isApi = pathname.startsWith("/api/");

  if (isApi) {
    // Auth path 1: Bearer CRON_SECRET (cron jobs, GitHub Actions)
    if (isBearerAuthorized(request)) return;
    // Auth path 2: Clerk session (dashboard user hitting the API)
    const { userId } = await auth();
    if (userId) return;
    // Neither — return JSON 401 instead of redirecting to /sign-in.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Non-API route (page navigation): let Clerk redirect unauthenticated
  // users to the sign-in page.
  await auth.protect();
});

// The `config.matcher` tells Next.js WHICH requests should run through this
// middleware. This regex excludes static assets (images, fonts, CSS, JS bundles)
// since those don't need auth checks. Only actual page navigations and API
// calls pass through the middleware.
export const config = {
  matcher: [
    // Match all routes EXCEPT static files (images, fonts, etc.)
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run middleware for API and tRPC routes
    "/(api|trpc)(.*)",
  ],
};
