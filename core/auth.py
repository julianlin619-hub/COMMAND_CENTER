"""OAuth token refresh utilities. Tokens are stored in environment variables."""

# ── Why this module exists ──────────────────────────────────────────────
# Most social media APIs use OAuth2 for authentication. OAuth2 access tokens
# expire (often after 1 hour), so you need to periodically "refresh" them
# using a long-lived refresh token. This module handles that exchange.
#
# The flow looks like this:
#   1. We already have a refresh_token (obtained once during initial OAuth setup).
#   2. We POST to the platform's token endpoint with grant_type=refresh_token.
#   3. The platform returns a new short-lived access_token we can use for API calls.
#
# Credentials (client_id, client_secret, refresh_token) are stored as
# environment variables on Render — never in code or the database.

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)


def refresh_oauth_token(
    token_url: str,
    client_id_env: str,
    client_secret_env: str,
    refresh_token_env: str,
    extra_params: dict | None = None,
) -> str:
    """Refresh an OAuth2 access token using a refresh token from env vars.

    Args:
        token_url: The OAuth token endpoint.
        client_id_env: Env var name for the client ID.
        client_secret_env: Env var name for the client secret.
        refresh_token_env: Env var name for the refresh token.
        extra_params: Additional params to include in the token request.

    Returns:
        The new access token.
    """
    # Build the standard OAuth2 refresh request body.
    # We read credentials from env vars (not passed directly) so callers
    # just specify which env var names to use — keeps secrets out of code.
    data = {
        "grant_type": "refresh_token",
        "client_id": os.environ[client_id_env],
        "client_secret": os.environ[client_secret_env],
        "refresh_token": os.environ[refresh_token_env],
    }
    # Some platforms need extra fields (e.g. LinkedIn requires "redirect_uri"
    # even during refresh). The caller can pass those in via extra_params.
    if extra_params:
        data.update(extra_params)

    # Send the token exchange request to the platform's OAuth endpoint
    response = httpx.post(token_url, data=data)
    # If the refresh token is invalid/expired, this raises an HTTPStatusError.
    # That signals the platform adapter to re-authenticate from scratch.
    response.raise_for_status()
    token_data = response.json()
    # The response contains the new short-lived access token (and sometimes
    # a new refresh token too, though we don't handle rotation here yet).
    access_token = token_data["access_token"]
    logger.info("Refreshed OAuth token via %s", token_url)
    return access_token
