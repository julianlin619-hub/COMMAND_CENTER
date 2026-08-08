# MEDIA COMMAND CENTER

## Architecture rules

- **IMPORTANT: Dashboard and crons communicate ONLY through the Supabase database.** No shared in-process state, no cross-service imports.
- **YOU MUST implement `PlatformBase`** (from `platforms/base.py`) for any new platform adapter under `platforms/`. Required methods: `validate_config`, `create_post`, `refresh_credentials`, `validate_credentials`.
- **Media flow**: Dashboard upload → Supabase Storage → cron reads via `/api/media/[id]`. Don't bypass the API endpoint.
- **Cron locking**: `core/scheduler.py` claims schedules atomically via `mark_schedule_picked_up()` before publishing. **YOU MUST NOT parallelize post processing or skip the claim step** — overlapping runs would double-publish. Stuck claims auto-reset (see `_reset_stale_pickups` in `core/database.py`).

## Auth

- **IMPORTANT: Clerk handles all dashboard authentication. NEVER add Supabase Auth.**
- **YOU MUST use the Supabase service key (not the anon key) for protected DB operations.**
- Per-platform OAuth/API tokens are stored as env vars on Render.
- **YOU MUST guard every dashboard API route with `await verifyApiAuth(req)`** (from `@/lib/auth`). It accepts a Clerk session OR `Authorization: Bearer ${CRON_SECRET}`. Don't call Clerk's `auth()` directly on any route that a cron job also hits.

## Coding style

- Write clear comments explaining **why** code exists and how it works — the developer is learning, so be generous with explanations. (This overrides Claude's default "no comments" stance.)
- File naming: kebab-case in `dashboard/`, snake_case in `core/` / `platforms/` / `cron/`.
- When logging platform exceptions in cron code, run them through `platform.sanitize_error(exc)` first — raw `logger.error(e)` can leak tokens to Render logs. (DB writes to `cron_runs.error_message` are auto-sanitized.)

## Workflow

- **No premature abstraction.** Cut features not in active use; add abstractions only when actually needed. Concrete > flexible.
- **UI mocks**: when asked for a UI mock, return a reusable Claude Code prompt that another session can implement, not the code itself.

## Commands Claude can't guess

- Run a cron job locally: `python -m cron.<platform>_pipeline`
- Lint Python: `ruff check .`
- Lint frontend: `cd dashboard && npm run lint`
- Type-check frontend: `cd dashboard && npx tsc --noEmit`
- Run tests: `pytest`
- Apply Supabase migrations: `supabase db push`

Frontend conventions and design tokens are in `.claude/rules/dashboard.md` (loads when editing `dashboard/**`).
