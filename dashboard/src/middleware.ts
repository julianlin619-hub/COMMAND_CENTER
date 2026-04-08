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

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Define which routes should be accessible WITHOUT authentication.
// `createRouteMatcher` takes an array of route patterns (using regex syntax)
// and returns a function that checks if a given request URL matches any of them.
//
// Public routes:
//   - "/sign-in(.*)" — the sign-in page and its sub-routes (MFA steps, etc.)
//   - "/api(.*)" — all API routes (they handle their own auth via verifyApiAuth)
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/api(.*)"]);

// `clerkMiddleware` wraps our auth logic. For every request:
//   1. Clerk attaches auth state (session info) to the request
//   2. Our callback runs to decide if the request should proceed
export default clerkMiddleware(async (auth, request) => {
  // If the route is NOT public, require authentication.
  // `auth.protect()` checks for a valid Clerk session. If the user isn't
  // signed in, they're automatically redirected to the sign-in page.
  // Public routes skip this check entirely.
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
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
