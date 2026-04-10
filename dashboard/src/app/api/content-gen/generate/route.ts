/**
 * POST /api/content-gen/generate
 *
 * Step 3 of the Outlier Tweet Reel pipeline: takes selected tweets, renders
 * each as a branded PNG quote card (via canvas-render), converts to a 5-second
 * vertical MP4 video (1080x1920, 9:16 for TikTok), uploads the MP4 to Supabase
 * Storage, then cleans up local temp files.
 *
 * Body: { tweets: [{ id: string, text: string }] }
 * Returns: { generated: [{ id, text, storagePath }] }
 *
 * Reuses the same canvas-render and video-render libs as the IG pipeline —
 * the rendered images use the same light-theme design (white bg, dark text).
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { normalizeTweetText } from "@/lib/tweet-normalize";
import { renderTweetToBuffer } from "@/lib/canvas-render";
import { renderPngToVideo } from "@/lib/video-render";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { tweets } = (await req.json()) as {
      tweets: { id: string; text: string }[];
    };

    if (!tweets?.length) {
      return NextResponse.json({ error: "No tweets provided" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const generated: { id: string; text: string; storagePath: string }[] = [];

    // Use os.tmpdir() instead of a local exports/ directory — temp files get
    // cleaned up after upload to Supabase Storage
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tiktok-gen-"));

    for (const tweet of tweets) {
      // Validate tweet ID is alphanumeric to prevent path traversal attacks.
      // A crafted ID like "../../etc/passwd" would escape the temp directory.
      if (!/^[a-zA-Z0-9_]+$/.test(tweet.id)) {
        return NextResponse.json(
          { error: "Invalid tweet ID format — must be alphanumeric" },
          { status: 400 }
        );
      }

      // 1. Normalize tweet text (strip URLs, fix spacing)
      const normalized = normalizeTweetText(tweet.text);

      // 2. Render tweet onto a branded 1080x1920 PNG canvas
      const pngBuffer = await renderTweetToBuffer(normalized);
      const pngPath = path.join(tmpDir, `tweet-${tweet.id}.png`);
      const mp4Path = path.join(tmpDir, `tweet-${tweet.id}.mp4`);

      // 3. Write PNG to temp, convert to 5-second MP4 video
      await fs.writeFile(pngPath, pngBuffer);
      await renderPngToVideo(pngPath, mp4Path);

      // 4. Upload MP4 to Supabase Storage under tiktok/ prefix
      const mp4Buffer = await fs.readFile(mp4Path);
      const storagePath = `tiktok/tweet-${tweet.id}.mp4`;
      const { error: uploadError } = await supabase.storage
        .from("media")
        .upload(storagePath, mp4Buffer, {
          contentType: "video/mp4",
          upsert: true, // overwrite if re-generating the same tweet
        });

      if (uploadError) {
        console.error(`Upload failed for tweet ${tweet.id}:`, uploadError.message);
        return NextResponse.json(
          { error: `Upload failed: ${uploadError.message}` },
          { status: 500 }
        );
      }

      // 5. Clean up temp files (PNG + MP4) now that the upload succeeded
      await fs.unlink(pngPath).catch(() => {});
      await fs.unlink(mp4Path).catch(() => {});

      generated.push({ id: tweet.id, text: normalized, storagePath });
    }

    // Clean up the temp directory itself
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});

    return NextResponse.json({ generated });
  } catch (e) {
    console.error("Content-gen generate error:", e);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
