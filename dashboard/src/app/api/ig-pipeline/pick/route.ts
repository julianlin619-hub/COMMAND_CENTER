/**
 * POST /api/ig-pipeline/pick
 *
 * Step 1: Pick random unused tweets from the bank for Instagram.
 * Returns the picked tweets (hash + text) without marking them as used yet —
 * that happens in the schedule step after successful posting.
 *
 * Body (optional): { "count": 10 }
 */

import { NextRequest, NextResponse } from 'next/server';
import { pickRandomUnused } from '@/lib/tweet-bank';
import { verifyApiAuth } from '@/lib/auth';

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const count = (body as { count?: number }).count ?? 10;

    const { picked, remainingUnused } = pickRandomUnused('instagram', count);

    return NextResponse.json({
      picked: picked.map((t) => ({ hash: t.hash, text: t.text })),
      remainingUnused,
    });
  } catch (e) {
    console.error("IG pipeline pick error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
