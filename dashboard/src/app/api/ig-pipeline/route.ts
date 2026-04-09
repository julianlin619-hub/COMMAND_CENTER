/**
 * Instagram auto-pipeline API route.
 *
 * This is the main orchestrator for the automated Instagram posting pipeline.
 * It runs the full flow: pick tweets → generate images → convert to video →
 * upload to Google Drive → schedule on Instagram via Zernio.
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
import { pickRandomUnused, markUsed, getNextBankBatchNumber } from '@/lib/tweet-bank';
import { normalizeTweetText } from '@/lib/tweet-normalize';
import { renderTweetToBuffer } from '@/lib/canvas-render';
import { renderPngToVideo } from '@/lib/video-render';
import { createFolder, uploadToDrive } from '@/lib/google-drive';
import { getInstagramAccount, scheduleVideoToInstagram } from '@/lib/zernio';

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

  // 1. Pick random unused tweets from the shared CSV bank.
  //    The 'instagram' parameter ensures we only check Instagram's history —
  //    Threads has its own independent tracking.
  const { picked, remainingUnused } = pickRandomUnused('instagram', BATCH_SIZE);
  if (picked.length === 0) {
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

  // 3. Upload everything to Google Drive for backup/archival.
  //    Creates a batch folder (e.g., "IG Bank Batch #6") with a Videos subfolder.
  const parentFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID!;
  const batchNum = getNextBankBatchNumber('instagram');
  const batchFolder = await createFolder(`IG Bank Batch #${batchNum}`, parentFolderId);
  const videosFolder = await createFolder('Videos', batchFolder.id);

  for (const g of generated) {
    await uploadToDrive(g.pngPath, `tweet-${g.hash}.png`, batchFolder.id);
    await uploadToDrive(g.mp4Path, `tweet-${g.hash}.mp4`, videosFolder.id);
  }

  // 4. Schedule each video to Instagram via Zernio.
  //    Zernio handles the actual Instagram API interaction — we just upload
  //    the video and provide the caption text.
  const { accountId, profileId } = await getInstagramAccount();
  const scheduled: { hash: string; postId: string }[] = [];
  for (const g of generated) {
    const post = await scheduleVideoToInstagram(accountId, profileId, g.text, g.mp4Path);
    scheduled.push({ hash: g.hash, postId: post.id });
  }

  // 5. Mark tweets as used ONLY after everything succeeded.
  //    This is intentionally the last step — if any earlier step fails,
  //    the tweets remain in the unused pool and will be retried next run.
  markUsed('instagram', picked.map((t) => t.hash));

  return NextResponse.json({
    processed: picked.length,
    remainingUnused,
    batchFolder: batchFolder.name,
    scheduled,
  });
}
