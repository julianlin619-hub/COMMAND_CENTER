/**
 * POST /api/ig-pipeline/schedule
 *
 * Step 3: Schedule generated videos to Instagram via Zernio and mark
 * the tweets as used in the bank history.
 *
 * Body: { "generated": [{ "hash": "abc123", "text": "...", "mp4Path": "/path/to/video.mp4" }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { markUsed } from '@/lib/tweet-bank';
import { getInstagramAccount, scheduleVideoToInstagram } from '@/lib/zernio';
import { verifyApiAuth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { generated } = (await req.json()) as {
      generated: { hash: string; text: string; mp4Path: string }[];
    };

    if (!generated?.length) {
      return NextResponse.json({ error: 'No generated items provided' }, { status: 400 });
    }

    const { accountId, profileId } = await getInstagramAccount();
    const scheduled: { hash: string; postId: string }[] = [];

    for (const g of generated) {
      const post = await scheduleVideoToInstagram(accountId, profileId, g.text, g.mp4Path);
      scheduled.push({ hash: g.hash, postId: post.id });
    }

    // Mark tweets as used only after all were successfully scheduled
    markUsed('instagram', generated.map((g) => g.hash));

    return NextResponse.json({ scheduled });
  } catch (e) {
    console.error("IG pipeline schedule error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
