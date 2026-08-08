---
description: Scaffold a new social platform adapter end-to-end in COMMAND_CENTER — PlatformBase implementation, platform_enum migration, direct-vs-Buffer wiring, and the cron entry point. Use when the user says "add a platform", "add a new platform adapter", "support <platform>", "wire up <platform> publishing", or "create a new platforms/ adapter".
argument-hint: [platform name, e.g. "bluesky" or "mastodon"]
---

# Add a platform adapter

Target platform: $ARGUMENTS

A "platform" here is one publishing destination (youtube, threads, snapchat…). Adding one touches **4 places in a fixed order**. Each platform string must be identical everywhere: the `platform_enum` value, the adapter's `name`, the cron's `process_due_posts(client, "<name>")`, and the `posts.platform` column rows.

Read `platforms/base.py` and `platforms/snapchat.py` (the cleanest real direct-publish example) before writing. Per CLAUDE.md, write generous *why* comments — the developer is learning.

## Decision to make first: Buffer or direct?

- **Direct publish** (youtube, threads, snapchat): `create_post()` talks to the platform API and returns a real, already-live post id. Leave `publishes_via_buffer = False`.
- **Buffer fan-out** (tiktok): `create_post()` only hands the post to Buffer's queue; it isn't live yet. Set `publishes_via_buffer = True`. The scheduler then marks the post `sent_to_buffer` (not `published`), and `cron/buffer_reconcile.py` confirms it later. If reconcile needs to re-send on failure, also override `buffer_replay()` to return the payload (e.g. `{"channel_id": ...}`).

Ask the user which one if it isn't obvious.

## Steps

### 1. Add the enum value (migration)

New `posts.platform` values must exist in `platform_enum` first, or inserts fail with `invalid_text_representation`. Create `supabase/migrations/<timestamp>_<name>_enum.sql` modeled exactly on `20260519120000_add_snapchat_enum.sql`:

```sql
ALTER TYPE platform_enum ADD VALUE IF NOT EXISTS '<name>';
```

Postgres rule: an enum value added in a transaction can't be used in the **same** transaction. Keep this `ALTER TYPE` alone in its own migration — never combine it with a migration that consumes the value. Apply with `supabase db push` (the `/new-migration` skill covers conventions).

### 2. Write the adapter `platforms/<name>.py`

Subclass `PlatformBase` and implement all 4 abstract methods (`validate_config`, `refresh_credentials`, `validate_credentials`, `create_post`). Set `name = "<name>"` to match the enum. (The old `upload_media` / `get_media_constraints` methods were removed Aug 2026 — no caller ever consumed them; media flows through Buffer URLs or inline uploads.)

- **`validate_config`**: call `self._check_env_vars("FOO_TOKEN", ...)` — fail fast at startup, not mid-publish. Per-platform secrets live as env vars on Render.
- **Error handling**: every `except` that logs must run the exception through `self.sanitize_error(exc)` first — raw tokens otherwise leak into Render logs. (DB writes via `cron_runs.error_message` are auto-sanitized, but logger calls are not.)
- For Buffer-backed adapters, set `publishes_via_buffer = True` and override `buffer_replay()` if needed (see above).

### 3. Add the cron entry point `cron/<name>_cron.py` (or `<name>_pipeline.py`)

Model it on `cron/snapchat_pipeline.py` (direct) — that's the canonical shape. There is **no adapter registry**; you import and instantiate the class directly here.

```python
from core.database import log_cron_finish, log_cron_start
from core.scheduler import process_due_posts
from platforms.<name> import <ClassName>

def main():
    client = <ClassName>()                       # __init__ calls validate_config
    client.refresh_credentials()                 # if the platform uses OAuth
    run_id = log_cron_start(platform="<name>", job_type="post")
    try:
        processed = process_due_posts(client, "<name>")
        log_cron_finish(run_id, status="success", posts_processed=processed)
    except Exception as e:
        log_cron_finish(run_id, status="failed", error_message=client.sanitize_error(e))

if __name__ == "__main__":
    main()
```

`process_due_posts` (in `core/scheduler.py`) already does the atomic claim (`mark_schedule_picked_up`), per-post try/except, status updates, and Buffer branching. **Do not** reimplement the claim or parallelize the loop — overlapping runs would double-publish.

### 4. Register the cron on Render

Tell the user it won't run until they add a Render cron service that executes `python -m cron.<name>_cron` on the desired schedule. You can't do this from here — surface it as a manual step.

## Verify

- `ruff check .` passes; `python -c "from platforms.<name> import <ClassName>; <ClassName>()"` constructs without abstract-method errors.
- Migration applied: `supabase db push`.
- A dry run: insert a test `posts` row with `platform='<name>'` + a due schedule, run `python -m cron.<name>_cron`, confirm a `cron_runs` row and the post's status transition.
