/**
 * POST /api/ig-pipeline/schedule
 *
 * Step 3: Schedule generated videos to Instagram via Buffer (alexhighlights2026
 * channel) and mark the tweets as used in the bank history.
 *
 * The MP4 is uploaded to Supabase Storage first so Buffer can fetch it via
 * a signed URL — Buffer doesn't accept direct file uploads. Mirrors the
 * pattern in dashboard/src/app/api/tiktok/manual-upload/route.ts.
 *
 * Body: { "generated": [{ "hash": "abc123", "text": "...", "mp4Path": "/path/to/video.mp4" }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { markUsed } from '@/lib/tweet-bank';
import { getChannelId, sendToBuffer } from '@/lib/buffer';
import { getSupabaseClient } from '@/lib/supabase';
import { verifyApiAuth } from '@/lib/auth';

// Instagram's Graph API caption ceiling. Buffer rejects longer captions
// outright, so we override sendToBuffer's TikTok-default 150-char limit.
const INSTAGRAM_CAPTION_LIMIT = 2200;

// Buffer profile name for the second Instagram account. Defaults to
// "alexhighlights2026" but can be overridden via env so a rename in
// Buffer doesn't require a code deploy.
const BUFFER_IG_2ND_NAME =
  process.env.BUFFER_INSTAGRAM_2ND_NAME ?? 'alexhighlights2026';

// Buffer may not pull the file for hours/days, so use a 7-day signed URL.
// Same expiry as cron/instagram_pipeline.py:176.
const SIGNED_URL_EXPIRY_SECONDS = 604800;

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

    const supabase = getSupabaseClient();
    const channelId = await getChannelId(undefined, 'instagram', BUFFER_IG_2ND_NAME);
    const scheduled: { hash: string; postId: string }[] = [];

    for (const g of generated) {
      // Re-validate hash here even though /generate already did — this route
      // can be called directly with an arbitrary `mp4Path`. Restricting hash
      // to alphanumeric keeps the storage path safe from traversal.
      if (!/^[a-zA-Z0-9]+$/.test(g.hash)) {
        return NextResponse.json(
          { error: `Invalid hash format for ${g.hash} — must be alphanumeric`, scheduled },
          { status: 400 },
        );
      }

      const storagePath = `instagram_2nd/tweet-${g.hash}.mp4`;
      let uploaded = false;
      try {
        const fileBytes = await fs.readFile(g.mp4Path);
        const { error: uploadError } = await supabase.storage
          .from('media')
          .upload(storagePath, fileBytes, { contentType: 'video/mp4', upsert: true });
        if (uploadError) {
          throw new Error(`Storage upload failed: ${uploadError.message}`);
        }
        uploaded = true;

        const { data: signed, error: signError } = await supabase.storage
          .from('media')
          .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);
        if (signError || !signed?.signedUrl) {
          throw new Error(`Failed to sign URL: ${signError?.message ?? 'unknown'}`);
        }

        const bufferPostId = await sendToBuffer(
          channelId,
          g.text,
          signed.signedUrl,
          'video',
          { instagramPostType: 'reel', captionLimit: INSTAGRAM_CAPTION_LIMIT },
        );

        // Record one posts row per successful Buffer hand-off so the
        // overview card's "Sent to Buffer (24h)" pill picks this up.
        // Don't fail the run if the insert errors — Buffer has already
        // accepted, so log and continue.
        const { error: insertError } = await supabase.from('posts').insert({
          platform: 'instagram_2nd',
          status: 'sent_to_buffer',
          caption: g.text,
          media_type: 'video',
          media_urls: [storagePath],
          platform_post_id: bufferPostId,
        });
        if (insertError) {
          console.error(
            `posts insert failed for instagram_2nd hash=${g.hash} (Buffer id=${bufferPostId}):`,
            insertError.message,
          );
        }

        // Mark used per-item as soon as Buffer accepts the post. A later
        // item's failure must not force a retry that re-schedules earlier
        // items (Buffer already accepted them → Instagram would see
        // duplicate posts and the run would burn daily quota).
        markUsed('instagram', [g.hash]);
        scheduled.push({ hash: g.hash, postId: bufferPostId });
      } catch (itemErr) {
        // Clean up the orphan storage file so a retry isn't blocked by a
        // half-uploaded artifact at the same path.
        if (uploaded) {
          await supabase.storage.from('media').remove([storagePath]);
        }
        // Surface what succeeded so far so the client can avoid a blind
        // full-batch retry that would duplicate the scheduled items.
        console.error(`IG pipeline schedule error on hash=${g.hash}:`, itemErr);
        return NextResponse.json(
          {
            error: (itemErr as Error).message || 'Internal server error',
            scheduled,
            failedHash: g.hash,
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ scheduled });
  } catch (e) {
    console.error('IG pipeline schedule error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
