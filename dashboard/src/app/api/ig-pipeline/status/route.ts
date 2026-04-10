/**
 * GET /api/ig-pipeline/status
 *
 * Returns the current state of the Instagram tweet bank — how many tweets
 * are in the CSV, how many have been used, and how many remain. Used by
 * the dashboard to show bank health before running the pipeline.
 */

import { NextResponse } from 'next/server';
import { parseBankFile, pickRandomUnused } from '@/lib/tweet-bank';
import { verifyApiAuth } from '@/lib/auth';

export async function GET(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const allTweets = parseBankFile();
    // Pick 0 just to get the remaining count without consuming any tweets
    const { remainingUnused } = pickRandomUnused('instagram', 0);

    return NextResponse.json({
      totalTweets: allTweets.length,
      usedTweets: allTweets.length - remainingUnused,
      remainingUnused,
    });
  } catch (e) {
    console.error("IG pipeline status error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
