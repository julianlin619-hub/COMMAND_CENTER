---
name: Clerk for auth, Supabase for DB only
description: Auth is Clerk only — never add Supabase Auth, @supabase/ssr, or Supabase auth middleware
type: feedback
---

Clerk handles all authentication. Supabase is database-only, accessed server-side via SUPABASE_SERVICE_KEY. Do NOT install @supabase/ssr, do NOT add Supabase auth middleware, do NOT use publishable/anon keys with cookie-based sessions.

**Why:** User explicitly chose this architecture — two auth systems would conflict.
**How to apply:** When touching auth or Supabase setup, never suggest Supabase Auth patterns (SSR cookies, middleware session refresh, publishable keys). Always use the service key server-side.
