/**
 * Instagram auto-pipeline API route.
 *
 * This is the main orchestrator for the automated Instagram posting pipeline.
 * It runs the full flow: pick tweets → generate images → convert to video →
 * schedule on Instagram via Zernio.
 *
 * Triggered by GitHub Actions on a daily schedule (see .github/workflows/ig-pipeline.yml).
 * Protected by CRON_SECRET bearer token to prevent unauthorized access.
 *
 * POST /api/ig-pipeline
 * Authorization: Bearer <CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { pickRandomUnused, markUsed } from '@/lib/tweet-bank';
import { normalizeTweetText } from '@/lib/tweet-normalize';
import { renderTweetToBuffer } from '@/lib/canvas-render';
import { renderPngToVideo } from '@/lib/video-render';
import { getInstagramAccount, scheduleVideoToInstagram } from '@/lib/zernio';
import { getSupabaseClient } from '@/lib/supabase';

// How many tweets to process per pipeline run
const BATCH_SIZE = 10;

export async function POST(req: NextRequest) {
  // Auth check — only allow requests with the correct CRON_SECRET token.
  // This prevents random internet traffic from triggering the pipeline.
  const authHeader = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
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

    // 3. Schedule each video to Instagram via Zernio and mark used incrementally.
    //    Zernio handles the actual Instagram API interaction. We mark each
    //    tweet as "used" immediately after its schedule call succeeds — NOT
    //    at the end of the loop. Previous code only marked used after ALL
    //    tweets succeeded, so if Zernio failed on tweet #7 of 10 the first
    //    6 stayed in the unused pool. Next run would regenerate and re-post
    //    them to Instagram as duplicates.
    const { accountId, profileId } = await getInstagramAccount();
    const scheduled: { hash: string; postId: string }[] = [];
    const failedHashes: { hash: string; error: string }[] = [];
    for (const g of generated) {
      try {
        const post = await scheduleVideoToInstagram(accountId, profileId, g.text, g.mp4Path);
        scheduled.push({ hash: g.hash, postId: post.id });
        // Commit this one tweet to the used pool right away so a later
        // failure in this batch can't cause it to be regenerated.
        markUsed('instagram', [g.hash]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Zernio scheduling failed for ${g.hash}:`, message);
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
