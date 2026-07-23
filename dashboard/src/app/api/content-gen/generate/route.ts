/**
 * POST /api/content-gen/generate
 *
 * Multi-platform content generation route. Takes selected tweets and
 * generates platform-specific media:
 *
 *   - TikTok (default): 1080x1920 PNG → 5-second MP4 video
 *   - Facebook / LinkedIn / Leila-LinkedIn: 1080x1080 square PNG quote
 *     card (no video conversion) — all read the Facebook template row
 *     and layer per-platform color overrides in code.
 *   - Instagram: 1080x1350 portrait PNG quote card (4:5, IG's max
 *     portrait aspect — carousel slides all share one aspect ratio, so
 *     crop-safe matters) — reads its own dedicated template row so the
 *     height can diverge from FB's 1:1 without affecting FB/LI.
 *
 * Body: { tweets: [{ id, text }], platform?: 'tiktok' | 'facebook' |
 *         'linkedin' | 'linkedin_leila' | 'instagram' }
 * Returns: { generated: [{ id, text, storagePath }] }
 *
 * Quote-card platforms use the template from the `templates` table in
 * Supabase; TikTok still reads from data/canvas-config.json.
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
import {
  DEFAULT_TEMPLATE_CONFIG,
  DEFAULT_INSTAGRAM_TEMPLATE_CONFIG,
  validateTemplateConfig,
} from "@/lib/template-types";

// Per-creator header image overrides. The square renderer's default is
// Alex's Header.png in public/ig-pipeline; anything in this map wins for
// that platform. Loaded once and cached per-process — these files don't
// change at runtime, and re-reading on every cron call would needlessly
// thrash the disk.
const PLATFORM_HEADER_PATHS: Record<string, string> = {
  linkedin_leila: "public/ig-pipeline/Leila_Header.png",
};
const headerBufferCache = new Map<string, Buffer>();
async function loadPlatformHeader(platform: string): Promise<Buffer | undefined> {
  const rel = PLATFORM_HEADER_PATHS[platform];
  if (!rel) return undefined;
  const cached = headerBufferCache.get(rel);
  if (cached) return cached;
  const buf = await fs.readFile(path.join(process.cwd(), rel));
  headerBufferCache.set(rel, buf);
  return buf;
}

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      // `swipe` marks a carousel title-card slide: rendered like any quote
      // card but with a red "SWIPE →" pill below the text (see
      // renderSquareQuoteCard's swipeBadge option). Only meaningful for
      // square-template platforms; the TikTok branch ignores it.
      tweets: { id: string; text: string; swipe?: boolean }[];
      platform?: string;
    };
    const { tweets, platform: rawPlatform = "tiktok" } = body;

    // Explicit allowlist — the type assertion above is compile-time only,
    // so without this check an unknown platform value would silently fall
    // through to the TikTok branch (wrong storage path, wrong render).
    // The storage path is also interpolated from `platform` directly for
    // the square-template branch; keeping this list authoritative prevents
    // anything from sneaking into a path it shouldn't.
    const VALID_PLATFORMS = ["tiktok", "facebook", "linkedin", "linkedin_leila", "instagram"] as const;
    if (!(VALID_PLATFORMS as readonly string[]).includes(rawPlatform)) {
      return NextResponse.json(
        { error: `Unknown platform: ${rawPlatform}` },
        { status: 400 }
      );
    }
    const platform = rawPlatform as (typeof VALID_PLATFORMS)[number];

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

    // Facebook, Leila-LinkedIn, Alex-LinkedIn, and Instagram all render
    // a quote card via the shared `renderSquareQuoteCard` (the name is a
    // mild misnomer now — Instagram is 1080×1440 portrait, not square,
    // but the renderer is fully dimension-generic).
    //
    // Template-row routing:
    //   - facebook / linkedin / linkedin_leila → read the Facebook
    //     template row from Supabase, 1080×1080 base, layer per-platform
    //     color overrides on top (see below). None of them have a
    //     dedicated template row today.
    //   - instagram → read its own template row (1080×1350 portrait,
    //     seeded by the 20260522 migration, resized by 20260723120001).
    //     No color override — defaults match Facebook. Instagram has its
    //     own row because the height differs; using FB's row + an
    //     in-code height override would work but defeats the operator's
    //     ability to tune IG dimensions in the template designer later.
    const usesSquareTemplate =
      platform === "facebook" ||
      platform === "linkedin" ||
      platform === "linkedin_leila" ||
      platform === "instagram";
    let fbTemplateConfig: TemplateConfig | null = null;
    if (usesSquareTemplate) {
      // Pick the template row + in-code fallback per platform. Instagram
      // gets its own row + DEFAULT_INSTAGRAM_TEMPLATE_CONFIG (1080×1350);
      // everyone else reads Alex's Facebook row + DEFAULT_TEMPLATE_CONFIG
      // (1080×1080).
      const isInstagram = platform === "instagram";
      const templatePlatform = isInstagram ? "instagram" : "facebook";
      const baseDefaults = isInstagram
        ? DEFAULT_INSTAGRAM_TEMPLATE_CONFIG
        : DEFAULT_TEMPLATE_CONFIG;

      const { data: template, error: tmplError } = await supabase
        .from("templates")
        .select("config")
        .eq("platform", templatePlatform)
        .eq("is_active", true)
        .limit(1)
        .single();

      if (tmplError || !template) {
        return NextResponse.json(
          {
            error: `No active ${templatePlatform} template found — create one in the template designer`,
          },
          { status: 400 }
        );
      }
      // Merge with defaults so any missing fields (e.g. paddingLeft vs old
      // single "padding") fall back to the locked-in values.
      fbTemplateConfig = { ...baseDefaults, ...validateTemplateConfig(template.config as Record<string, unknown>) };

      // Per-platform overrides on top of the base template row. These
      // are the *locked-in* deltas — the operator decided on them in the
      // design sandbox and they stay constant regardless of any future
      // edits to the base template config. Anything else (padding,
      // typography, alignment) keeps inheriting from the row so that
      // broad layout changes apply to every platform by default.
      if (platform === "linkedin_leila") {
        fbTemplateConfig = {
          ...fbTemplateConfig,
          backgroundColor: "#000000",
          textColor: "#ffffff",
        };
      } else if (platform === "linkedin") {
        // Alex's LinkedIn — clean white card with dark text, matching
        // LinkedIn's professional aesthetic. Distinct from Facebook (which
        // typically renders dark-mode) so the same source tweet reads
        // differently per platform. Tweak via the design sandbox once a
        // dedicated LinkedIn template row exists; until then these
        // overrides are the source of truth.
        fbTemplateConfig = {
          ...fbTemplateConfig,
          backgroundColor: "#ffffff",
          textColor: "#0a1f33",
        };
      }
      // No instagram override — visual defaults match Facebook (white bg,
      // dark text). The only intentional difference is canvas height.
    }

    // Resolve the per-creator header image up front, so we don't re-read
    // from disk inside the per-tweet loop. Falls back to the renderer's
    // hardcoded Header.png default when this platform has no override.
    const platformHeaderBuffer = usesSquareTemplate
      ? await loadPlatformHeader(platform)
      : undefined;

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

          if (usesSquareTemplate) {
            // FB / LinkedIn / Leila-LinkedIn render a 1080×1080 PNG;
            // Instagram renders 1080×1350. The exact dimensions come
            // from `fbTemplateConfig` (width/height fields) so the
            // renderer adapts automatically. Storage path is namespaced
            // by `platform` so each platform's renders don't collide
            // (same tweet text can be reused across platforms and
            // Buffer needs distinct signed URLs anyway).
            const pngBuffer = await renderSquareQuoteCard(
              normalized,
              fbTemplateConfig!,
              {
                headerImageBuffer: platformHeaderBuffer,
                swipeBadge: tweet.swipe === true,
              },
            );
            const storagePath = `${platform}/tweet-${tweet.id}.png`;

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
