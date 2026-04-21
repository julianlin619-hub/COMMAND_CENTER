/**
 * Constant-time string comparison.
 *
 * Used for comparing secrets (bearer tokens, API keys) where a naive `===`
 * would leak information via response timing — each byte of a correct prefix
 * takes measurably longer, letting an attacker brute-force the secret one
 * character at a time with enough samples.
 *
 * Pure JS so it works in both Node.js and Edge Runtime (Next.js middleware
 * runs on Edge by default, where `node:crypto.timingSafeEqual` is not
 * reliably available across runtimes).
 *
 * Note: length is leaked (fast early return). That is acceptable for our
 * use — `CRON_SECRET` length is not sensitive, only its bytes.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
