/**
 * Instagram auto-pipeline API route.
 *
 * This is the main orchestrator for the automated Instagram (2nd) posting
 * pipeline. It runs the full flow: pick tweets → generate images → convert
 * to video → upload to Supabase Storage → schedule on Instagram via Buffer
 * (alexhighlights2026 channel).
 *
 * Triggered by GitHub Actions on a daily schedule (see .github/workflows/ig-pipeline.yml)
 * AND from the dashboard "Run" button on /instagram-2nd. Auth via verifyApiAuth,
 * which accepts both CRON_SECRET (for the workflow) and a Clerk session
 * (for dashboard users) — see dashboard/src/lib/auth.ts.
 *
 * POST /api/ig-pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { pickRandomUnused, markUsed } from '@/lib/tweet-bank';
import { normalizeTweetText } from '@/lib/tweet-normalize';
import { renderTweetToBuffer } from '@/lib/canvas-render';
import { renderPngToVideo } from '@/lib/video-render';
import { getChannelId, sendToBuffer } from '@/lib/buffer';
import { getSupabaseClient } from '@/lib/supabase';
import { verifyApiAuth } from '@/lib/auth';

// How many tweets to process per pipeline run
const BATCH_SIZE = 10;

// Instagram's Graph API caption ceiling — Buffer rejects longer captions.
const INSTAGRAM_CAPTION_LIMIT = 2200;

// Buffer profile name for the second Instagram account.
const BUFFER_IG_2ND_NAME =
  process.env.BUFFER_INSTAGRAM_2ND_NAME ?? 'alexhighlights2026';

// 7-day signed URL — Buffer may not pull the file for hours or days.
const SIGNED_URL_EXPIRY_SECONDS = 604800;

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const startedAt = new Date().toISOString();

  try {
    // 1. Pick random unused tweets from the shared CSV bank.
    //    The 'instagram' parameter ensures we only check Instagram's history —
    //    Threads has its own independent tracking.
    const { picked, remainingUnused } = pickRandomUnused('instagram', BATCH_SIZE);
    if (picked.length === 0) {
      // Log a successful cron run even when there's nothing to process
      await supabase.from('cron_runs').insert({
        platform: 'instagram_2nd',
        job_type: 'post',
        status: 'success',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        posts_processed: 0,
        error_message: null,
      });
      return NextResponse.json({ message: 'No unused tweets remaining in bank', remainingUnused: 0 });
    }

    // 2. Generate PNG images and MP4 videos for each tweet.
    //    Each tweet gets rendered onto a branded canvas image, then the image
    //    is converted to a 5-second video (required format for Instagram Reels).
    const imagesDir = path.join(process.cwd(), 'exports', 'bank-images');
    const videosDir = path.join(process.cwd(), 'exports', 'bank-videos');
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

    // 3. Schedule each video to Instagram via Buffer and mark used incrementally.
    //    Buffer downloads the MP4 from a Supabase Storage signed URL, so we
    //    upload first and pass the signed URL to sendToBuffer. We mark each
    //    tweet "used" immediately after Buffer accepts the post — NOT at the
    //    end of the loop. Otherwise a partial-batch failure would leave
    //    already-queued items in the unused pool, and the next run would
    //    regenerate and re-post them as Instagram duplicates.
    const channelId = await getChannelId(undefined, 'instagram', BUFFER_IG_2ND_NAME);
    const scheduled: { hash: string; postId: string }[] = [];
    const failedHashes: { hash: string; error: string }[] = [];
    for (const g of generated) {
      const storagePath = `instagram_2nd/tweet-${g.hash}.mp4`;
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

        const { data: signed, error: signError } = await supabase.storage
          .from('media')
          .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);
        if (signError || !signed?.signedUrl) {
          throw new Error(`Failed to sign URL: ${signError?.message ?? 'unknown'}`);
        }

        const bufferPostId = await sendToBuffer(
          channelId,
          g.text,
          signed.signedUrl,
          'video',
          { instagramPostType: 'reel', captionLimit: INSTAGRAM_CAPTION_LIMIT },
        );

        // Record one posts row per successful Buffer hand-off. The
        // overview card's "Sent to Buffer (24h)" pill counts these rows.
        // We don't fail the run if the insert errors — Buffer already
        // accepted the post and rolling that back is fiddly, so log and
        // continue.
        const { error: insertError } = await supabase.from('posts').insert({
          platform: 'instagram_2nd',
          status: 'sent_to_buffer',
          caption: g.text,
          media_type: 'video',
          media_urls: [storagePath],
          platform_post_id: bufferPostId,
        });
        if (insertError) {
          console.error(
            `posts insert failed for instagram_2nd hash=${g.hash} (Buffer id=${bufferPostId}):`,
            insertError.message,
          );
        }

        scheduled.push({ hash: g.hash, postId: bufferPostId });
        // Commit this one tweet to the used pool right away so a later
        // failure in this batch can't cause it to be regenerated.
        markUsed('instagram', [g.hash]);
      } catch (err) {
        // Orphan-file cleanup so a retry isn't blocked by a half-uploaded
        // artifact at the same storage path.
        if (uploaded) {
          await supabase.storage.from('media').remove([storagePath]).catch(() => {});
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Buffer scheduling failed for ${g.hash}:`, message);
        failedHashes.push({ hash: g.hash, error: message });
      }
    }

    // 5. Log cron run to Supabase. Status reflects partial success: success
    //    if any tweet scheduled, failed only if every tweet errored. The
    //    error_message records the count + first error so the dashboard
    //    surfaces partial-failure batches without burying the success.
    const cronStatus = scheduled.length > 0 ? 'success' : 'failed';
    const errorSummary = failedHashes.length > 0
      ? `${failedHashes.length}/${generated.length} failed: ${failedHashes[0].error}`
      : null;
    await supabase.from('cron_runs').insert({
      platform: 'instagram_2nd',
      job_type: 'post',
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
    // Log failed cron run so the dashboard accurately reflects the failure
    await supabase.from('cron_runs').insert({
      platform: 'instagram_2nd',
      job_type: 'post',
      status: 'failed',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      posts_processed: 0,
      error_message: (err as Error).message,
    });
    throw err;
  }
}
