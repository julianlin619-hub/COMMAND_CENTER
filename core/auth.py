"""OAuth token refresh utilities. Tokens are stored in environment variables."""

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
    data = {
        "grant_type": "refresh_token",
        "client_id": os.environ[client_id_env],
        "client_secret": os.environ[client_secret_env],
        "refresh_token": os.environ[refresh_token_env],
    }
    if extra_params:
        data.update(extra_params)

    response = httpx.post(token_url, data=data)
    response.raise_for_status()
    token_data = response.json()
    access_token = token_data["access_token"]
    logger.info("Refreshed OAuth token via %s", token_url)
    return access_token
