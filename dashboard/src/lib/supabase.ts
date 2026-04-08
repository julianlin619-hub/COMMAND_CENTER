/**
 * Supabase Client Factory
 *
 * Creates and returns a Supabase client for server-side database access.
 *
 * A Supabase client is a JavaScript object that lets you interact with your
 * Supabase project's database (PostgreSQL), storage (file uploads), and other
 * services via a simple API (e.g., supabase.from("posts").select("*")).
 */

import { createClient } from "@supabase/supabase-js";

export function getSupabaseClient() {
  // The `!` (non-null assertion) tells TypeScript "I guarantee this value exists
  // at runtime, even though the type says it could be undefined." Environment
  // variables (`process.env.X`) always have type `string | undefined` in TypeScript,
  // but we know these are set in our deployment environment. If they're missing,
  // the app will crash with a clear error at startup — which is what we want
  // (fail fast rather than silently returning undefined).
  const url = process.env.SUPABASE_URL!;

  // We use the SERVICE KEY (not the anon key) because this code runs on the server.
  // The service key bypasses Row Level Security (RLS) policies, giving us full
  // read/write access to all tables. This is safe because this key is only used
  // in server-side code (API routes, server components) and is never exposed to
  // the browser. The anon key would be subject to RLS rules, which we haven't
  // configured since all access goes through our own auth layer (Clerk + CRON_SECRET).
  const key = process.env.SUPABASE_SERVICE_KEY!;

  return createClient(url, key);
}
