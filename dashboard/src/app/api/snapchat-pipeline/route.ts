/**
 * Snapchat content-generation pipeline.
 *
 * Hourly counterpart to /api/ig-pipeline, but with a critical difference:
 * Snapchat has no Buffer-equivalent third-party scheduler, so we can't
 * hand off the queued video to someone else and call it done. Instead the
 * route inserts a `posts` row with status='scheduled' and a `schedules`
 * row with scheduled_for ≈ now()+4min. The Python publisher cron
 * (`cron/snapchat_pipeline.py`) — which runs 5 minutes after this one —
 * claims that schedule and drives headless Chromium against Snapchat's
 * Web Uploader.
 *
 * This is the FIRST dashboard TypeScript route to write into the
 * `schedules` table. The shape mirrors what Python crons already write
 * (post_id, scheduled_for, picked_up_at nullable) so the existing
 * scheduler.process_due_posts query keeps working without changes.
 *
 * Triggered hourly by Render's `snapchat-content-pipeline` cron (which
 * just curl-POSTs here with the CRON_SECRET) and manually from the
 * dashboard's /snapchat detail page. Auth via verifyApiAuth, same shape
 * as /api/ig-pipeline.
 *
 * POST /api/snapchat-pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { pickRandomUnused, markUsed } from '@/lib/tweet-bank';
import { normalizeTweetText } from '@/lib/tweet-normalize';
import { renderTweetToBuffer } from '@/lib/canvas-render';
import { renderPngToVideo } from '@/lib/video-render';
import { getSupabaseClient } from '@/lib/supabase';
import { verifyApiAuth } from '@/lib/auth';

// One tweet per hourly tick — distinct from /api/ig-pipeline which batches
// 10/day. Hourly + 1 = 24 posts/day, well under Snapchat's posting limits
// and gives us a smoother cadence on the publisher side (one publish per
// hour vs a 10-post burst).
const BATCH_SIZE = 1;

// Belt-and-suspenders offset so the schedule we just wrote isn't claimed
// by any other process polling between this route firing (xx:00) and the
// publisher cron firing (xx:05). 4 min lands us inside the publisher's
// next claim window with margin for clock skew.
const SCHEDULE_DELAY_MS = 4 * 60 * 1000;

// Snapchat caption ceiling. Selector discovery against the live composer
// found the textarea has NO `maxlength` attribute (DOM maxLength = -1, i.e.
// unenforced client-side), so Snap doesn't dictate a number for us. 280 is
// the natural tweet length — since every caption we feed in originates as a
// tweet from TweetMasterBank.csv, this matches the source-of-truth ceiling
// and avoids surprising mid-sentence truncation on edge cases. Snap accepts
// considerably more than 280 server-side, so this is purely a defensive
// upper bound, not a Snap-imposed one.
const SNAPCHAT_CAPTION_LIMIT = 280;

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const startedAt = new Date().toISOString();

  try {
    // 1. Pick one random unused tweet from the shared CSV bank. The
    //    'snapchat' parameter gives Snapchat its own independent history file
    //    (data/snapchat-bank-history.json) — a tweet can appear on Instagram,
    //    Threads, AND Snapchat without being repeated within any single one.
    const { picked, remainingUnused } = pickRandomUnused('snapchat', BATCH_SIZE);
    if (picked.length === 0) {
      // Empty-bank case is a success, not a failure — operator may have
      // intentionally drained the pool. Logging a 0-row cron_run keeps the
      // dashboard health pill from flipping red when there's simply nothing
      // to post.
      await supabase.from('cron_runs').insert({
        platform: 'snapchat',
        job_type: 'generate',
        status: 'success',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        posts_processed: 0,
        error_message: null,
      });
      return NextResponse.json({ message: 'No unused tweets remaining in bank', remainingUnused: 0 });
    }

    // 2. Render the tweet to a PNG → MP4 (5s loop, 1080×1920). Same renderer
    //    chain as the IG and TikTok pipelines so the visual brand stays
    //    consistent. We write to disk only as a staging step before uploading
    //    to Storage — once the upload is done the local files are disposable
    //    (the dashboard process restarts wipe /exports anyway).
    const imagesDir = path.join(process.cwd(), 'exports', 'snapchat-images');
    const videosDir = path.join(process.cwd(), 'exports', 'snapchat-videos');
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.mkdir(videosDir, { recursive: true });

    const generated: { hash: string; text: string; pngPath: string; mp4Path: string }[] = [];
    for (const tweet of picked) {
      const normalized = normalizeTweetText(tweet.text);
      const buffer = await renderTweetToBuffer(normalized);
      const pngPath = path.join(imagesDir, `tweet-${tweet.hash}.png`);
      const mp4Path = path.join(videosDir, `tweet-${tweet.hash}.mp4`);
      await fs.writeFile(pngPath, buffer);
      await renderPngToVideo(pngPath, mp4Path);
      generated.push({ hash: tweet.hash, text: tweet.text, pngPath, mp4Path });
    }

    // 3. Upload to Storage, insert posts+schedules row, mark tweet used.
    //    Per-item commit (markUsed after schedule insert) mirrors the
    //    ig-pipeline pattern: if step N succeeds for tweet A but step N
    //    fails for tweet B, tweet A is committed to the used pool so we
    //    never re-publish it as a Snapchat duplicate.
    const scheduled: { hash: string; postId: string }[] = [];
    const failedHashes: { hash: string; error: string }[] = [];
    for (const g of generated) {
      const storagePath = `snapchat/tweet-${g.hash}.mp4`;
      let uploaded = false;
      try {
        const fileBytes = await fs.readFile(g.mp4Path);
        const { error: uploadError } = await supabase.storage
          .from('media')
          .upload(storagePath, fileBytes, { contentType: 'video/mp4', upsert: true });
        if (uploadError) {
          throw new Error(`Storage upload failed: ${uploadError.message}`);
        }
        uploaded = true;

        // Truncate to SNAPCHAT_CAPTION_LIMIT. `.slice` matches the convention
        // used by /api/ig-pipeline (it passes the limit through to Buffer
        // and lets Buffer slice; here we slice ourselves since there's no
        // intermediary). Defensive — most TweetMasterBank rows are well
        // under 280, so this is a no-op on the common path.
        const caption = g.text.slice(0, SNAPCHAT_CAPTION_LIMIT);

        // 3a. Insert the posts row. status='scheduled' is what
        //     core/scheduler.py::process_due_posts expects to claim.
        //     hashtags is set to [] explicitly: the column is non-null on
        //     the Python side (Post.hashtags: list[str]) and Pydantic
        //     rejects DB-returned NULL on hydration. /api/ig-pipeline omits
        //     this and gets away with it because that route hands off to
        //     Buffer rather than going through the Pydantic-backed
        //     process_due_posts publisher. core/models.py now has a
        //     defensive field_validator that coerces None → [], but
        //     setting the column explicitly here is cheaper than relying
        //     on the validator.
        const { data: postRow, error: postError } = await supabase
          .from('posts')
          .insert({
            platform: 'snapchat',
            status: 'scheduled',
            caption,
            media_type: 'video',
            media_urls: [storagePath],
            hashtags: [],
          })
          .select('id')
          .single();
        if (postError || !postRow) {
          throw new Error(`posts insert failed: ${postError?.message ?? 'no row returned'}`);
        }

        // 3b. Insert the schedules row. scheduled_for = now()+4min — see
        //     SCHEDULE_DELAY_MS for why we offset rather than using now().
        //     The shape (post_id + scheduled_for + null picked_up_at by
        //     default) matches what core/database.py::insert_schedule
        //     writes, so the existing scheduler query continues to work
        //     without changes.
        const scheduledFor = new Date(Date.now() + SCHEDULE_DELAY_MS).toISOString();
        const { error: scheduleError } = await supabase
          .from('schedules')
          .insert({ post_id: postRow.id, scheduled_for: scheduledFor });
        if (scheduleError) {
          throw new Error(`schedules insert failed: ${scheduleError.message}`);
        }

        scheduled.push({ hash: g.hash, postId: postRow.id });
        // Mark used only after BOTH the post and schedule rows commit.
        // Otherwise a failure between the two writes would consume the
        // tweet without actually scheduling it — bank tweet permanently
        // lost from the pool with no posted artifact.
        markUsed('snapchat', [g.hash]);
      } catch (err) {
        // Orphan-file cleanup so a retry isn't blocked by a half-uploaded
        // artifact at the same Storage path. We don't roll back a partial
        // posts/schedules pair here — the next run's bank pick will simply
        // pick a different tweet, and the orphaned posts row stays as
        // 'scheduled' until process_due_posts publishes or fails it.
        if (uploaded) {
          await supabase.storage.from('media').remove([storagePath]).catch(() => {});
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Snapchat scheduling failed for ${g.hash}:`, message);
        failedHashes.push({ hash: g.hash, error: message });
      }
    }

    // 4. Log the cron run. Same partial-success semantics as ig-pipeline.
    const cronStatus = scheduled.length > 0 ? 'success' : 'failed';
    const errorSummary = failedHashes.length > 0
      ? `${failedHashes.length}/${generated.length} failed: ${failedHashes[0].error}`
      : null;
    await supabase.from('cron_runs').insert({
      platform: 'snapchat',
      job_type: 'generate',
      status: cronStatus,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      posts_processed: scheduled.length,
      error_message: errorSummary,
    });

    return NextResponse.json({
      processed: scheduled.length,
      remainingUnused,
      scheduled,
      failed: failedHashes,
    });
  } catch (err) {
    // Top-level failure (e.g. tweet-bank read errored, renderer crashed
    // before any per-item work). Log it so the dashboard reflects the
    // failure accurately.
    await supabase.from('cron_runs').insert({
      platform: 'snapchat',
      job_type: 'generate',
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      posts_processed: 0,
      error_message: (err as Error).message,
    });
    throw err;
  }
}
