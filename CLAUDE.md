# MEDIA COMMAND CENTER

Social media automation monorepo — one dashboard to manage posting across 6 platforms (YouTube, Instagram, TikTok, LinkedIn, X, Threads).

## Architecture

```
MEDIA_COMMAND_CENTER/
├── core/           — Shared Python logic (models, DB, scheduling, retry, media, auth)
├── platforms/      — One adapter per platform, all implement PlatformBase (strategy pattern)
├── cron/           — Scheduled background jobs (one per platform, runs on Render)
├── dashboard/      — Next.js web UI (Clerk auth, Supabase backend)
├── db/             — Database migrations (PostgreSQL)
├── pyproject.toml  — Python project config (Python 3.11+, pydantic, httpx, supabase)
└── render.yaml     — Deployment config (1 web service + 6 cron jobs on Render)
```

## Data flow

Dashboard writes posts/schedules to Supabase. Cron jobs (every 4h) read due posts and publish via platform APIs. Dashboard and crons communicate only through the database.

## Key conventions

- **Platform adapters** (`platforms/`) all implement `PlatformBase` from `platforms/base.py` — methods: `create_post`, `upload_media`, `refresh_credentials`, `validate_credentials`, `get_media_constraints`.
- **Data models** in `core/models.py` use Pydantic: `Post`, `ScheduledPost`, `MediaUploadResult`, `CronRun`.
- **Database tables**: `posts`, `schedules`, `cron_runs` (see `db/migrations/001_initial_schema.sql`).
- **Media upload flow**: Dashboard UI upload -> Supabase Storage -> cron reads via `/api/media/[id]`.
- **Auth**: Clerk for dashboard users, per-platform OAuth/API tokens for platform APIs (stored as env vars on Render).

## Tech stack

- **Backend**: Python 3.11+, Pydantic, httpx, supabase-py
- **Frontend**: Next.js, TypeScript, Tailwind CSS, shadcn/ui
- **Database**: Supabase (PostgreSQL + Storage)
- **Auth**: Clerk
- **Hosting**: Render (web service + cron jobs)

## Coding style

### General

- Write clear comments explaining **why** code exists and how it works — the developer is learning, so be generous with explanations.
- Keep functions small and focused on one thing.

### File naming

- **Frontend** (`dashboard/`): kebab-case — `post-scheduler.tsx`, `use-posts.ts`
- **Python** (`core/`, `platforms/`, `cron/`): snake_case — `post_scheduler.py`, `cron_runner.py`

### Frontend rules

- Use **server components by default**. Only add `"use client"` when you need hooks, event handlers, or browser APIs.
- Use **named exports** for components: `export function PostCard() {}` (not `export default`).
- Use `@/` path alias for imports: `import { PostCard } from "@/components/post-card"`.
- Use **shadcn/ui** for common UI elements — don't rebuild buttons, dialogs, inputs, etc.
- Colocate component files near where they're used when possible.

### Design rules

Dark theme using Tailwind's zinc scale with blue-500 as the sole accent color.

- **Background**: `#09090b` (near-black)
- **Card backgrounds**: `#111113` or `#0a0a0c`
- **Card borders**: `#1f1f23`
- **Primary text**: `#fafafa` (off-white)
- **Secondary/muted text**: `#a1a1aa` (zinc-400)
- **Placeholder text**: `#52525b` (zinc-600)
- **Input backgrounds**: `#18181b` (zinc-900)
- **Input borders**: `#27272a` (zinc-800)
- **Primary accent** (buttons, links, selected radio): `#3b82f6` (blue-500)
- **Accent hover**: `#2563eb` (blue-600)
- **Success green**: `#22c55e` (green-500)
- **Badge/pill backgrounds**: `#27272a` with `#a1a1aa` text
- **Selected pill/chip**: `#fafafa` bg with `#09090b` text (inverted)
- **Unselected pill/chip**: `#27272a` bg with `#fafafa` text
- **CTA filled button**: `#fafafa` bg with `#09090b` text
- **CTA outline/ghost button**: transparent with `#fafafa` text and subtle border
