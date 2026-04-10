/**
 * POST /api/ig-pipeline/generate
 *
 * Step 2: Generate PNG images and MP4 videos for the given tweets.
 * Takes an array of { hash, text } objects, renders each tweet onto a
 * branded canvas image, converts to a 5-second video, and returns the
 * file paths for use in the schedule step.
 *
 * Body: { "tweets": [{ "hash": "abc123", "text": "Tweet content..." }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { normalizeTweetText } from '@/lib/tweet-normalize';
import { renderTweetToBuffer } from '@/lib/canvas-render';
import { renderPngToVideo } from '@/lib/video-render';
import { verifyApiAuth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { tweets } = (await req.json()) as {
      tweets: { hash: string; text: string }[];
    };

    if (!tweets?.length) {
      return NextResponse.json({ error: 'No tweets provided' }, { status: 400 });
    }

    const imagesDir = path.join(process.cwd(), 'exports', 'bank-images');
    const videosDir = path.join(process.cwd(), 'exports', 'bank-videos');
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.mkdir(videosDir, { recursive: true });

    const generated: { hash: string; text: string; pngPath: string; mp4Path: string }[] = [];

    for (const tweet of tweets) {
      // Validate hash is alphanumeric to prevent path traversal via crafted
      // hash values like "../../etc/passwd" which would escape the exports/ dir
      if (!/^[a-zA-Z0-9]+$/.test(tweet.hash)) {
        return NextResponse.json(
          { error: "Invalid hash format — must be alphanumeric" },
          { status: 400 }
        );
      }

      const normalized = normalizeTweetText(tweet.text);
      const buffer = await renderTweetToBuffer(normalized);
      const pngPath = path.join(imagesDir, `tweet-${tweet.hash}.png`);
      const mp4Path = path.join(videosDir, `tweet-${tweet.hash}.mp4`);

      // Verify resolved paths stay within the exports directory (defense in depth)
      const exportsRoot = path.resolve(process.cwd(), 'exports');
      if (!path.resolve(pngPath).startsWith(exportsRoot) ||
          !path.resolve(mp4Path).startsWith(exportsRoot)) {
        return NextResponse.json(
          { error: "Path escapes exports directory" },
          { status: 400 }
        );
      }
      await fs.writeFile(pngPath, buffer);
      await renderPngToVideo(pngPath, mp4Path);
      generated.push({ hash: tweet.hash, text: tweet.text, pngPath, mp4Path });
    }

    return NextResponse.json({
      generated: generated.map((g) => ({
        hash: g.hash,
        text: g.text,
        pngPath: g.pngPath,
        mp4Path: g.mp4Path,
      })),
    });
  } catch (e) {
    console.error("IG pipeline generate error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
