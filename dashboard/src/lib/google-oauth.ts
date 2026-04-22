/**
 * Google OAuth access-token refresh helper.
 *
 * Google access tokens expire after ~1 hour. The refresh token (minted
 * once by scripts/generate_youtube_second_refresh_token.py) is exchanged
 * at oauth2.googleapis.com/token for a fresh access token whenever we
 * need to call the YouTube Data API.
 *
 * This module is intentionally minimal — one fetch, no retries, no
 * caching. Callers are short-lived API route handlers; if a refresh
 * fails transiently, the route returns an error and the browser retries.
 */

export interface RefreshedToken {
  accessToken: string;
  /** ms-since-epoch timestamp after which the access token is expired. */
  expiresAt: number;
}

export interface RefreshTokenParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Thrown when Google returns a non-2xx response or malformed body. */
export class OAuthRefreshError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OAuthRefreshError";
    this.status = status;
  }
}

export async function refreshOauthToken(
  params: RefreshTokenParams,
): Promise<RefreshedToken> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Read the error body for diagnostics, but scrub any token-like substrings
    // that might echo back (Google sometimes includes the client_id in errors).
    const raw = await res.text().catch(() => "");
    const scrubbed = raw.replace(/[A-Za-z0-9_\-]{40,}/g, "[REDACTED]");
    throw new OAuthRefreshError(
      res.status,
      `Google OAuth refresh failed (${res.status}): ${scrubbed.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new OAuthRefreshError(
      res.status,
      "Google OAuth refresh returned malformed response.",
    );
  }

  return {
    accessToken: data.access_token,
    // Shave 60s off the stated expiry so callers don't race a near-expired token.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}
