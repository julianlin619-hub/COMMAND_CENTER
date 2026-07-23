/**
 * Instagram Reposts Pipeline — manually-triggered API route.
 *
 * POST /api/instagram-reposts/run
 * Body: { permalinks: string[] }
 *
 * Spawns core.instagram_repost_pipeline (Python) with the permalink list
 * piped via stdin. The Python module scrapes each post via Apify, downloads
 * the video, transcribes it, picks a RAG caption, and queues to Buffer on
 * Instagram (alexhighlights2026).
 *
 * Returns: { processed, scheduled, failed, output, status }
 * The `output` field carries combined stdout+stderr so the client can show
 * the run log (same shape as /api/cron/run).
 *
 * Auth: Clerk session (this is a dashboard-only manual tool, no cron trigger).
 * Timeout: 10 min — Apify + Deepgram per video can take 30–60s each.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/auth';
import { runPythonModule, combineOutput } from '@/lib/python-runner';

// Apify scraping + Deepgram transcription per video can take 30–60s each.
// With up to 10 videos per batch the ceiling is ~10 min.
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let permalinks: unknown;
  try {
    ({ permalinks } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(permalinks) || permalinks.length === 0) {
    return NextResponse.json(
      { error: 'permalinks must be a non-empty array of strings' },
      { status: 400 },
    );
  }

  const urls = permalinks.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (urls.length === 0) {
    return NextResponse.json(
      { error: 'No valid permalink strings provided' },
      { status: 400 },
    );
  }

  const result = await runPythonModule('core.instagram_repost_pipeline', [], {
    stdin: JSON.stringify({ permalinks: urls }),
    timeoutMs: 600_000,
  });

  // The pipeline prints one JSON line per post plus a final summary line.
  // Parse the last JSON line of stdout as the summary.
  let summary: { processed: number; scheduled: number; failed: number } = {
    processed: 0,
    scheduled: 0,
    failed: 0,
  };
  const jsonLines = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  const lastJson = jsonLines.at(-1);
  if (lastJson) {
    try {
      summary = JSON.parse(lastJson);
    } catch {
      // stdout didn't end with a parseable JSON line — leave summary as zeros
    }
  }

  return NextResponse.json({
    status: result.status,
    ...summary,
    output: combineOutput(result.stdout, result.stderr) || (result.status === 'failed' ? 'Unknown error' : ''),
    durationMs: result.durationMs,
  });
}
