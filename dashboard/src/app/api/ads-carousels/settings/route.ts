/**
 * Ad Carousels settings — the user-editable default prompt + CTA copy.
 *
 * GET  /api/ads-carousels/settings → { defaultPrompt, ctaText }
 * PUT  /api/ads-carousels/settings   Body: { defaultPrompt?, ctaText? }
 *
 * Backed by the ads_carousel_settings singleton row (id = 1, seeded by
 * the 20260802120001 migration). These live in their own table — NOT in
 * the ads templates row — because the template designer's
 * validateTemplateConfig strips unknown config keys on save, which
 * would silently delete them.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyApiAuth } from '@/lib/auth';
import { getSupabaseClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('ads_carousel_settings')
    .select('default_prompt, cta_text')
    .eq('id', 1)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: 'Settings row missing — run the 20260802120001 migration' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    defaultPrompt: data.default_prompt,
    ctaText: data.cta_text,
  });
}

export async function PUT(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { defaultPrompt?: unknown; ctaText?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Partial update: only fields present in the body are written, so a
  // future caller can save the CTA without also resending the prompt.
  const update: Record<string, string> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body.defaultPrompt === 'string') update.default_prompt = body.defaultPrompt;
  if (typeof body.ctaText === 'string') update.cta_text = body.ctaText;

  if (Object.keys(update).length === 1) {
    return NextResponse.json(
      { error: 'Provide defaultPrompt and/or ctaText as strings' },
      { status: 400 },
    );
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('ads_carousel_settings')
    .update(update)
    .eq('id', 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
