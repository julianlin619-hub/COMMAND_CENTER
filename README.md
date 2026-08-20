# Media Command Center

A social media automation monorepo. A Next.js dashboard schedules and previews
posts; Python cron jobs running on Render publish them to YouTube, TikTok,
Threads, LinkedIn, and Snapchat. The two halves never talk to each other
directly — they coordinate through Supabase.

## What it does

- **Tweet → video/image fan-out.** Scrapes outlier tweets (Apify), renders a
  TikTok MP4 + Facebook PNG + LinkedIn PNG, and fans the result out to Buffer
  in a single run (`cron/tiktok_pipeline.py`, `cron/tiktok_bank_pipeline.py`).
- **Written posts.** Daily Threads + LinkedIn posts for the Alex and Leila
  channels (`cron/threads_cron.py`, `cron/threads_leila_cron.py`,
  `cron/linkedin_leila_cron.py`).
- **YouTube Studio scheduling.** Picks canonical upload slots and rewrites
  titles via Claude (`cron/youtube_cron.py`, `core/youtube_studio_scheduler.py`,
  `core/youtube_title_generator.py`).
- **Snapchat Spotlight.** Generates the clip on the dashboard, then a headless
  Chromium publisher uploads it through Snapchat's Web Uploader since there's
  no public API (`cron/snapchat_trigger.py`, `cron/snapchat_pipeline.py`,
  `platforms/snapchat.py`).
- **Storage cleanup.** Reclaims Supabase Storage after Buffer confirms a
  publish (`cron/tiktok_storage_cleanup.py`).

## Architecture

```
┌────────────────────┐         ┌──────────────────────────┐
│  Next.js dashboard │         │  Python crons (Render)   │
│  (Clerk auth)      │         │  • tiktok_pipeline       │
│  • upload media    │         │  • threads_cron          │
│  • compose posts   │         │  • snapchat_pipeline     │
│  • schedule        │         │  • youtube_cron          │
│  • content-gen API │         │  • …                     │
└─────────┬──────────┘         └────────────┬─────────────┘
          │                                 │
          │       ┌─────────────────┐       │
          └──────►│    Supabase     │◄──────┘
                  │ Postgres + Storage │
                  └─────────────────┘
```

**Dashboard and crons communicate only through Supabase.** No shared
in-process state, no cross-service imports. The cron reads media via the
dashboard's `/api/media/[id]` endpoint; it never reaches into Storage
directly. See `CLAUDE.md` for the full architecture rules.

### Cron scheduling

`core/scheduler.py` claims schedule rows atomically with
`mark_schedule_picked_up()` before publishing. Post processing is **never**
parallelized — overlapping runs would double-publish. Stuck claims auto-reset
via `_reset_stale_pickups` in `core/database.py`.

### Platform adapter contract

Every platform under `platforms/` extends `PlatformBase` (`platforms/base.py`)
and implements: `create_post`, `upload_media`, `refresh_credentials`,
`validate_credentials`, `get_media_constraints`, `validate_config`. This
strategy pattern lets the cron layer stay platform-agnostic.

## Repo layout

```
core/         Shared Python: DB client, scheduler, models, formatting,
              YouTube slot logic, content sources, Buffer client
platforms/    Per-platform adapters (PlatformBase subclasses)
cron/         Entry points for the Render cron services
dashboard/    Next.js 15 app (App Router, Clerk, shadcn/ui, Tailwind)
supabase/     Migrations + local config
scripts/      One-off scripts (YouTube refresh-token mint, etc.)
tests/        pytest suite for the Python side
data/         Static content banks (CSV, JSON) shipped with the repo
render.yaml   Render service definitions (dashboard + every cron)
```

## Tech stack

- **Backend / crons**: Python 3.11+, httpx, Pydantic, Supabase Python SDK,
  Anthropic SDK, Playwright (Snapchat only)
- **Dashboard**: Next.js 15, React, TypeScript, Tailwind, shadcn/ui, Clerk
- **Data**: Supabase (Postgres + Storage)
- **Infra**: Render (web service + cron jobs), Buffer (cross-posting)

## Local setup

### Prerequisites

- Python 3.11+ (see `.python-version`)
- Node 20+
- A Supabase project (URL + service key)
- A Clerk app (publishable + secret key)
- Buffer access token + channel/org IDs for the platforms you publish to

### Install

```bash
# Python deps for crons + tests
pip install -r requirements.txt
pip install -e .

# Dashboard deps
cd dashboard && npm install
```

Copy `.env.example` to `.env` and fill in the values. The same env file is
read by both the Python crons and (via Next's loader) the dashboard during
local dev.

### Run

```bash
# Dashboard
cd dashboard && npm run dev          # http://localhost:3000

# A cron pipeline (one-shot, not on a schedule)
python -m cron.tiktok_pipeline
python -m cron.threads_cron
python -m cron.snapchat_pipeline
# …etc — one entry point per file in cron/
```

### Lint / test

```bash
ruff check .                         # Python lint
pytest                               # Python tests

cd dashboard
npm run lint                         # ESLint
npx tsc --noEmit                     # TypeScript type check
```

### Database migrations

```bash
supabase db push
```

## Auth

- **Clerk** handles all dashboard authentication. Don't add Supabase Auth.
- DB writes go through the **Supabase service key** (never the anon key) for
  protected operations.
- Every dashboard API route is guarded by `await verifyApiAuth(req)` from
  `dashboard/src/lib/auth.ts`. It accepts a Clerk session **or** an
  `Authorization: Bearer ${CRON_SECRET}` header — crons use the bearer form,
  so don't call Clerk's `auth()` directly on any route a cron also hits.
- Per-platform OAuth/API tokens live in Render env vars; see `render.yaml`
  for the full list per service.

## Deployment

Everything ships through `render.yaml`:

- `command-center-dashboard` — the Next.js web service (Standard plan, since
  node-canvas + ffmpeg in `/api/content-gen/generate` won't fit in 512 MB).
- One Render cron service per file under `cron/`, each pinned to its own
  schedule in `render.yaml`. Edit the `schedule:` line there to change cadence;
  the comments next to each cron explain why the time was chosen.

Some Render gotchas worth knowing about (full notes are inline in
`render.yaml`):

- Snapchat's publisher installs `chromium-headless-shell` (not full chromium)
  into `/opt/render/project/src/.playwright-browsers` because only that path
  is persisted from build to runtime on Render cron services.
- The YouTube cron and the dashboard's "Run cron now" button share the same
  `YOUTUBE_*` env vars — rotate them on both services together.

## Conventions

- **Naming**: `kebab-case` under `dashboard/`, `snake_case` under `core/`,
  `platforms/`, `cron/`.
- **Comments**: generous in this repo. Explain *why* code exists and how it
  works — this overrides the usual "no comments" default. (See `CLAUDE.md`.)
- **Error logging in crons**: route platform exceptions through
  `platform.sanitize_error(exc)` before `logger.error` to avoid leaking
  tokens into Render logs. DB writes to `cron_runs.error_message` are
  sanitized automatically.
- **Frontend design tokens**: see `.claude/rules/dashboard.md` — dark theme,
  zinc scale, blue-500 as the sole accent.

## Pointers

- `CLAUDE.md` — the canonical architecture + workflow rules.
- `TODO.md` — what's queued and in the backlog.
- `render.yaml` — every deployed service, with inline notes on why each
  schedule and build step is the way it is.
