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

    if (!tweets?.length) {
      return NextResponse.json({ error: "No tweets provided" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const generated: { id: string; text: string; storagePath: string }[] = [];

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
    // Facebook just renders directly to a buffer)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `${platform}-gen-`));

    for (const tweet of tweets) {
      // Validate tweet ID to prevent path traversal attacks.
      // Allows alphanumeric, underscores, and hyphens (UUIDs from Supabase contain hyphens).
      if (!/^[a-zA-Z0-9_-]+$/.test(tweet.id)) {
        return NextResponse.json(
          { error: "Invalid tweet ID format" },
          { status: 400 }
        );
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
          return NextResponse.json(
            { error: `Upload failed: ${uploadError.message}` },
            { status: 500 }
          );
        }

        generated.push({ id: tweet.id, text: normalized, storagePath });
      } else {
        // TikTok path: render 1080x1920 PNG → convert to 5-second MP4 video
        const pngBuffer = await renderTweetToBuffer(normalized);
        const pngPath = path.join(tmpDir, `tweet-${tweet.id}.png`);
        const mp4Path = path.join(tmpDir, `tweet-${tweet.id}.mp4`);

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
          return NextResponse.json(
            { error: `Upload failed: ${uploadError.message}` },
            { status: 500 }
          );
        }

        // Clean up temp files now that upload succeeded
        await fs.unlink(pngPath).catch((e) => console.warn(`Cleanup failed: ${pngPath}`, e.message));
        await fs.unlink(mp4Path).catch((e) => console.warn(`Cleanup failed: ${mp4Path}`, e.message));

        generated.push({ id: tweet.id, text: normalized, storagePath });
      }
    }

    // Clean up the temp directory
    await fs.rm(tmpDir, { recursive: true }).catch((e) => console.warn(`Cleanup failed: ${tmpDir}`, e.message));

    return NextResponse.json({ generated });
  } catch (e) {
    console.error("Content-gen generate error:", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
