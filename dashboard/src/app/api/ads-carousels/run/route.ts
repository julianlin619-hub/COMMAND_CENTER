/**
 * Ad Carousels Pipeline — manually-triggered API route.
 *
 * POST /api/ads-carousels/run
 * Body (one of):
 *   { action: "build_bank", prompt: string }
 *   { action: "generate", count: number, ctaText: string }
 *
 * Spawns core.ads_carousel_pipeline (Python) with the payload piped via
 * stdin.
 *   - build_bank: filters the whole ~5K-row tweet_bank through Claude
 *     against the brief and refills the ads_bank table. A once-off
 *     (rerunnable) pass, ~3-6 min.
 *   - generate: samples N random 9-tweet permutations from ads_bank
 *     (every carousel differs from every previous one by >= 3 tweets,
 *     remembered forever in the ads_carousels ledger), renders slides,
 *     and uploads one numbered Drive folder per carousel.
 *
 * Returns the pipeline's summary JSON plus `output` (combined
 * stdout+stderr run log) and `durationMs` — same shape as
 * /api/instagram-reposts/run.
 *
 * Auth: Clerk session (dashboard-only manual tool, no cron trigger).
 * Timeout: 20 min — a 100-carousel batch means up to ~900 canvas
 * renders' worth of unique slides plus ~1000 Drive copy calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/auth';
import { runPythonModule, combineOutput } from '@/lib/python-runner';

export const maxDuration = 1200;

// Server-side backstop matching _MAX_BATCH in the Python pipeline.
const MAX_BATCH = 100;

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    action?: unknown;
    prompt?: unknown;
    count?: unknown;
    ctaText?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Translate the dashboard's camelCase body into the pipeline's stdin
  // payload (snake_case, `mode` key). The pipeline re-validates
  // everything; these checks just give the UI immediate 400s.
  let stdinPayload: Record<string, unknown>;
  if (body.action === 'build_bank') {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }
    stdinPayload = { mode: 'build_bank', prompt };
  } else if (body.action === 'generate') {
    const ctaText = typeof body.ctaText === 'string' ? body.ctaText.trim() : '';
    const count = body.count;
    if (!ctaText) {
      return NextResponse.json({ error: 'ctaText is required' }, { status: 400 });
    }
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_BATCH
    ) {
      return NextResponse.json(
        { error: `count must be an integer between 1 and ${MAX_BATCH}` },
        { status: 400 },
      );
    }
    stdinPayload = { mode: 'generate', count, cta_text: ctaText };
  } else {
    return NextResponse.json(
      { error: 'action must be "build_bank" or "generate"' },
      { status: 400 },
    );
  }

  const result = await runPythonModule('core.ads_carousel_pipeline', [], {
    stdin: JSON.stringify(stdinPayload),
    timeoutMs: 1_200_000,
  });

  // The pipeline prints its summary as the last JSON line of stdout —
  // build_bank: {"status","mode","scanned","bank_size"}
  // generate:   {"status","mode","requested","generated",
  //              "total_permutations","folder_url"}
  // failure:    {"status":"error","error"}
  let summary: Record<string, unknown> = {};
  const jsonLines = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  const lastJson = jsonLines.at(-1);
  if (lastJson) {
    try {
      summary = JSON.parse(lastJson);
    } catch {
      // stdout didn't end with a parseable JSON line — leave summary empty
    }
  }

  return NextResponse.json({
    status: result.status,
    ...summary,
    output: combineOutput(result.stdout, result.stderr) || (result.status === 'failed' ? 'Unknown error' : ''),
    durationMs: result.durationMs,
  });
}
