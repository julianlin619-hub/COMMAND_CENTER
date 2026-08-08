---
description: Diagnose why a post in COMMAND_CENTER didn't publish, is stuck, or failed — by walking the posts → schedules → cron_runs trail and the stale-pickup logic. Use when the user says "why didn't this post go out", "this post is stuck", "post failed to publish", "debug a post", "nothing published", or "the <platform> cron didn't run".
argument-hint: [post id, platform, or symptom]
---

# Debug a stuck or failed post

What to investigate: $ARGUMENTS

The dashboard and crons share nothing but the database, so every publish leaves a trail across three tables. Diagnose by reading that trail in order. All queries need the **service key** (anon key gets zero rows under RLS). Reference: `core/scheduler.py`, `core/database.py`.

## The status ladder (`posts.status`)

A healthy post moves `draft → scheduled → publishing → published` (direct) or `… → publishing → sent_to_buffer → published` (Buffer-backed: tiktok, and any adapter with `publishes_via_buffer=True`). Where it's stuck tells you what failed:

| Status | Meaning | Likely cause |
|---|---|---|
| `draft` | never scheduled | no `schedules` row exists → content-gen never scheduled it |
| `scheduled` | waiting, past its time | cron isn't running, or `scheduled_for` is in the future, or schedule was claimed but not released |
| `publishing` | claimed, mid-publish | **stuck** — worker crashed after claiming; auto-resets after 30 min (`STALE_PICKUP_MINUTES`) |
| `failed` | publish raised | read `posts.error_message` (already sanitized) |
| `sent_to_buffer` | handed to Buffer, unconfirmed | `buffer_reconcile` hasn't confirmed yet, or Buffer is sitting on it |
| `buffer_error` | Buffer rejected it | read `error_message`; reconcile surfaced a Buffer-side failure |

## Walk the trail

1. **The post** — find the row. Note `status`, `platform`, `error_message`, `updated_at`, `published_at`.

2. **Its schedule** — `schedules` where `post_id = <id>` (1-to-1, cascade delete). Check:
   - `scheduled_for` — is it actually due (≤ now)? A future time means it's simply waiting, not broken.
   - `picked_up_at` — **null** = unclaimed/available; **set** = a worker claimed it. A `picked_up_at` set >30 min ago on a still-unpublished post is a **stale claim** from a crashed run; `_reset_stale_pickups` clears it on the next cron run for that platform so it retries. Set but recent = a run is in flight right now.
   - No schedule row at all + post is `draft` → it was never scheduled.

3. **The cron runs** — `cron_runs` where `platform = <platform>` order by `started_at desc`. Check:
   - Is the platform's cron even running? If the newest row is hours/days old, Render isn't firing it — that's the bug, not the post.
   - Newest run `status` = `failed` → read its `error_message`. `status='running'` with an old `started_at` → that run hung (and is what stranded the `publishing` post).
   - `posts_processed` = 0 on recent successful runs → nothing was due, or `get_due_schedules` filtered it out (future `scheduled_for`, or `picked_up_at` still set within the 30-min window).

## Common verdicts

- **Stuck in `publishing` / claimed schedule** → crashed mid-run. Wait for the 30-min stale reset, or manually clear `schedules.picked_up_at = null` and `posts.status = 'scheduled'`. There's a requeue endpoint: `POST /api/posts/[id]/requeue`.
- **`failed` with a token/auth error** → the platform's credentials expired (`refresh_credentials` failing); check the env vars on Render.
- **`scheduled` but no recent `cron_runs`** → the Render cron service is down/misconfigured; the post is fine.
- **`sent_to_buffer` for a long time** → check Buffer's own queue (`cron/buffer_introspect.py`). Note `buffer_reconcile` is no longer scheduled on Render (removed for Buffer API-limit reasons) — run `python -m cron.buffer_reconcile` manually to confirm/retry handoffs.
- **Duplicate-caption insert silently dropped** → the `idx_posts_platform_caption_dedup` unique index blocks a second non-failed post with the same `(platform, md5(caption))`.

State the verdict plainly: which stage failed, the evidence row, and the fix. Don't claim it's fixed unless you ran the requeue/reset and saw the status advance.
