# MEDIA COMMAND CENTER

Social media automation monorepo — one dashboard to manage posting and analytics across 6 platforms (YouTube, Instagram, TikTok, LinkedIn, X, Threads).

## Architecture

```
MEDIA_COMMAND_CENTER/
├── core/           — Shared Python logic (models, DB, scheduling, retry, media, auth)
├── platforms/      — One adapter per platform, all implement PlatformBase (strategy pattern)
├── cron/           — Scheduled background jobs (one per platform, runs on Render)
├── dashboard/      — Next.js web UI (Clerk auth, Supabase backend)
├── supabase/       — Database migrations (PostgreSQL)
├── pyproject.toml  — Python project config (Python 3.11+, pydantic, httpx, supabase)
└── render.yaml     — Deployment config (1 web service + 6 cron jobs on Render)
```

## Data flow

Dashboard writes posts/schedules to Supabase. Cron jobs (every 4h) read due posts, publish via platform APIs, and pull metrics back into Supabase. Dashboard and crons communicate only through the database.

## Key conventions

- **Platform adapters** (`platforms/`) all implement `PlatformBase` from `platforms/base.py` — methods: `create_post`, `upload_media`, `get_post_metrics`, `refresh_credentials`, `validate_credentials`, `get_media_constraints`.
- **Data models** in `core/models.py` use Pydantic: `Post`, `ScheduledPost`, `EngagementSnapshot`, `MediaUploadResult`, `CronRun`.
- **Database tables**: `posts`, `schedules`, `engagement_metrics`, `cron_runs` (see `supabase/migrations/001_initial_schema.sql`).
- **Media upload flow**: Dashboard UI upload -> Supabase Storage -> cron reads via `/api/media/[id]`.
- **Auth**: Clerk for dashboard users, per-platform OAuth/API tokens for platform APIs (stored as env vars on Render).

## Tech stack

- **Backend**: Python 3.11+, Pydantic, httpx, supabase-py
- **Frontend**: Next.js, TypeScript, Tailwind CSS
- **Database**: Supabase (PostgreSQL + Storage)
- **Auth**: Clerk
- **Hosting**: Render (web service + cron jobs)
