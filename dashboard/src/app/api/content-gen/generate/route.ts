/**
 * POST /api/content-gen/generate
 *
 * Multi-platform content generation route. Takes selected tweets and
 * generates platform-specific media:
 *
 *   - TikTok (default): 1080x1920 PNG → 5-second MP4 video
 *   - Facebook: 1080x1080 square PNG quote card (no video conversion)
 *
 * Body: { tweets: [{ id, text }], platform?: 'tiktok' | 'facebook' }
 * Returns: { generated: [{ id, text, storagePath }] }
 *
 * Facebook uses the template from the `templates` table in Supabase,
 * while TikTok still reads from data/canvas-config.json.
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { normalizeTweetText } from "@/lib/tweet-normalize";
import { renderTweetToBuffer } from "@/lib/canvas-render";
import { renderPngToVideo } from "@/lib/video-render";
import { renderSquareQuoteCard } from "@/lib/square-canvas-render";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import type { TemplateConfig } from "@/lib/template-types";
import { DEFAULT_TEMPLATE_CONFIG, validateTemplateConfig } from "@/lib/template-types";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      tweets: { id: string; text: string }[];
      platform?: "tiktok" | "facebook";
    };
    const { tweets, platform = "tiktok" } = body;

    // Explicit Array.isArray — previously `!tweets?.length` would pass
    // for `tweets = null` and crash later in the for-loop with a cryptic
    // "not iterable" error.
    if (!Array.isArray(tweets) || tweets.length === 0) {
      return NextResponse.json({ error: "No tweets provided" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const generated: { id: string; text: string; storagePath: string }[] = [];
    // Per-item error collection — a single upload hiccup shouldn't fail the
    // whole batch. The caller (cron pipeline) decides what threshold to fail
    // on based on errors.length vs generated.length.
    const errors: { id: string; error: string }[] = [];

    // For Facebook: fetch the active template config from the database
    let fbTemplateConfig: TemplateConfig | null = null;
    if (platform === "facebook") {
      const { data: template, error: tmplError } = await supabase
        .from("templates")
        .select("config")
        .eq("platform", "facebook")
        .eq("is_active", true)
        .limit(1)
        .single();

      if (tmplError || !template) {
        return NextResponse.json(
          { error: "No active Facebook template found — create one in the template designer" },
          { status: 400 }
        );
      }
      // Merge with defaults so any missing fields (e.g. paddingLeft vs old
      // single "padding") fall back to the locked-in values.
      fbTemplateConfig = { ...DEFAULT_TEMPLATE_CONFIG, ...validateTemplateConfig(template.config as Record<string, unknown>) };
    }

    // Temp directory for intermediate files (TikTok needs PNG→MP4 conversion,
    // Facebook just renders directly to a buffer). We wrap the per-item work
    // in try/finally so the directory is removed even if a tweet throws.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `${platform}-gen-`));

    try {
      for (const tweet of tweets) {
        // Per-tweet try/catch: record the error and continue with the next
        // item instead of bailing out of the whole batch. A transient upload
        // failure on tweet #7 of 10 shouldn't discard the 6 that already
        // succeeded (and certainly shouldn't leave them orphaned in Storage
        // with no DB record pointing at them).
        try {
          // Validate tweet ID to prevent path traversal attacks.
          // Allows alphanumeric, underscores, and hyphens (UUIDs contain hyphens).
          if (!/^[a-zA-Z0-9_-]+$/.test(tweet.id)) {
            errors.push({ id: tweet.id, error: "Invalid tweet ID format" });
            continue;
          }

          // Normalize tweet text (strip URLs, fix spacing)
          const normalized = normalizeTweetText(tweet.text);

          if (platform === "facebook") {
            // Facebook path: render a 1080x1080 square PNG — no video conversion
            const pngBuffer = await renderSquareQuoteCard(normalized, fbTemplateConfig!);
            const storagePath = `facebook/tweet-${tweet.id}.png`;

            const { error: uploadError } = await supabase.storage
              .from("media")
              .upload(storagePath, pngBuffer, {
                contentType: "image/png",
                upsert: true,
              });

            if (uploadError) {
              console.error(`Upload failed for tweet ${tweet.id}:`, uploadError.message);
              errors.push({ id: tweet.id, error: `Upload failed: ${uploadError.message}` });
              continue;
            }

            generated.push({ id: tweet.id, text: normalized, storagePath });
          } else {
            // TikTok path: render 1080x1920 PNG → convert to 5-second MP4 video
            const pngBuffer = await renderTweetToBuffer(normalized);
            const pngPath = path.join(tmpDir, `tweet-${tweet.id}.png`);
            const mp4Path = path.join(tmpDir, `tweet-${tweet.id}.mp4`);

            try {
              await fs.writeFile(pngPath, pngBuffer);
              await renderPngToVideo(pngPath, mp4Path);

              const mp4Buffer = await fs.readFile(mp4Path);
              const storagePath = `tiktok/tweet-${tweet.id}.mp4`;
              const { error: uploadError } = await supabase.storage
                .from("media")
                .upload(storagePath, mp4Buffer, {
                  contentType: "video/mp4",
                  upsert: true,
                });

              if (uploadError) {
                console.error(`Upload failed for tweet ${tweet.id}:`, uploadError.message);
                errors.push({ id: tweet.id, error: `Upload failed: ${uploadError.message}` });
                continue;
              }

              generated.push({ id: tweet.id, text: normalized, storagePath });
            } finally {
              // Always try to clean up per-tweet temp files, even on failure.
              // The outer tmpDir cleanup would handle leftovers too, but
              // clearing as we go keeps peak disk usage down for big batches.
              await fs.unlink(pngPath).catch(() => {});
              await fs.unlink(mp4Path).catch(() => {});
            }
          }
        } catch (tweetErr) {
          const msg = tweetErr instanceof Error ? tweetErr.message : String(tweetErr);
          console.error(`Tweet ${tweet.id} failed:`, msg);
          errors.push({ id: tweet.id, error: msg });
        }
      }
    } finally {
      // Clean up the temp directory regardless of how the loop exited
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(`Cleanup failed: ${tmpDir}`, e instanceof Error ? e.message : e),
      );
    }

    // Return partial results. Caller decides what constitutes failure
    // (e.g., `errors.length > 0 && generated.length === 0` = total failure).
    return NextResponse.json({ generated, errors });
  } catch (e) {
    console.error("Content-gen generate error:", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
