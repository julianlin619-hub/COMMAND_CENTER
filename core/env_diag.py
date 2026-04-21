"""Env-var diagnostics for cron pipelines.

Each pipeline's `main()` calls `log_env_diagnostics()` as its very first step
so the dashboard UI's output pane shows which expected env vars are present
before any phase runs. This is the fastest way to diagnose failures where a
cron works when triggered directly on Render but fails when triggered from
the dashboard's "Run All Crons" button (different container, different env
scope — see docs in `dashboard/src/app/api/cron/run/route.ts`).

Values are never logged — only presence (SET / MISSING) — so this is safe
to surface in the UI even for secrets.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def log_env_diagnostics(
    job_name: str,
    required: list[str],
    optional: list[str] | None = None,
) -> None:
    """Log which expected env vars are set vs missing for a cron pipeline.

    A missing REQUIRED var is logged at ERROR level — the cron is about to
    fail, and this line flags the likely cause before the real exception
    stack trace.

    Args:
        job_name: Human-readable pipeline name (e.g. "tiktok-bank-pipeline").
        required: Env vars the pipeline needs to run at all.
        optional: Env vars with sensible defaults — missing ones are info-only.
    """
    def _status(key: str) -> str:
        # Treat empty string the same as unset: Render's UI sometimes leaves
        # `sync: false` entries with a blank value, which `os.environ.get()`
        # returns as "" rather than None. Either way the cron will crash on
        # use, so we flag both as MISSING.
        return "SET" if os.environ.get(key) else "MISSING"

    logger.info(
        "[env-diag] %s required: %s",
        job_name,
        ", ".join(f"{k}={_status(k)}" for k in required),
    )
    if optional:
        logger.info(
            "[env-diag] %s optional: %s",
            job_name,
            ", ".join(f"{k}={_status(k)}" for k in optional),
        )

    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        logger.error(
            "[env-diag] %s MISSING REQUIRED: %s — pipeline will likely fail",
            job_name,
            ", ".join(missing),
        )
