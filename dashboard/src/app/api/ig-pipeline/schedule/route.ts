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
      try {
        const post = await scheduleVideoToInstagram(accountId, profileId, g.text, g.mp4Path);
        // Mark used per-item as soon as Zernio accepts the post. A later
        // item's failure must not force a retry that re-schedules earlier
        // items (Zernio already accepted them → Instagram would see
        // duplicate posts and the run would burn daily quota).
        markUsed('instagram', [g.hash]);
        scheduled.push({ hash: g.hash, postId: post.id });
      } catch (itemErr) {
        // Surface what succeeded so far so the client can avoid a blind
        // full-batch retry that would duplicate the scheduled items.
        console.error(`IG pipeline schedule error on hash=${g.hash}:`, itemErr);
        return NextResponse.json(
          {
            error: (itemErr as Error).message || "Internal server error",
            scheduled,
            failedHash: g.hash,
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ scheduled });
  } catch (e) {
    console.error("IG pipeline schedule error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
