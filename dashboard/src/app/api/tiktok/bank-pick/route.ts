/**
 * POST /api/tiktok/bank-pick — Pick random high-performing tweets from the bank.
 *
 * Reads TweetMasterBank.csv, filters by favorite_count >= minLikes,
 * deduplicates against existing TikTok posts, and returns random picks.
 *
 * Body: { count?: number, minLikes?: number }
 * Returns: { picked: [{ tweetId, text, favoriteCount }], total, remaining }
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";
import { normalizeTweetText } from "@/lib/tweet-normalize";

interface CsvRow {
  tweetId: string;
  text: string;
  favoriteCount: number;
}

/**
 * Parse the bank CSV and return all three columns.
 */
function parseCsvWithLikes(raw: string): CsvRow[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require("csv-parse/sync");
  const rows: string[][] = parse(raw, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length === 0) return [];

  const header = rows[0];
  const headerLower = header.map((h) => h.toLowerCase());

  const textCol = headerLower.includes("text") ? headerLower.indexOf("text") : 1;
  const idCol = headerLower.includes("tweet_id") ? headerLower.indexOf("tweet_id") : 0;
  const likesCol = headerLower.includes("favorite_count") ? headerLower.indexOf("favorite_count") : 2;
  const startRow = 1; // skip header

  return rows
    .slice(startRow)
    .map((row) => ({
      tweetId: row[idCol]?.trim().replace(/'$/, "") || "",
      text: row[textCol]?.trim() || "",
      favoriteCount: parseInt(row[likesCol]?.trim() || "0", 10),
    }))
    .filter((r) => r.text && !isNaN(r.favoriteCount));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function POST(req: NextRequest) {
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { count?: number; minLikes?: number };
  const count = body.count ?? 1;
  const minLikes = body.minLikes ?? 6500;

  const bankPath = resolve(
    process.cwd(),
    process.env.CONTENT_BANK_PATH || "../data/TweetMasterBank.csv"
  );

  // Path containment check
  const projectRoot = resolve(process.cwd(), "..");
  if (!bankPath.startsWith(projectRoot)) {
    console.error("Bank path escapes project root:", bankPath);
    return NextResponse.json(
      { error: "Invalid content bank path configuration" },
      { status: 400 }
    );
  }

  if (!existsSync(bankPath)) {
    console.error("Content bank file not found:", bankPath);
    return NextResponse.json(
      { error: "Content bank file not found" },
      { status: 400 }
    );
  }

  try {
    const raw = readFileSync(bankPath, "utf-8");
    const allRows = parseCsvWithLikes(raw);

    // Filter by minimum likes
    const highPerformers = allRows.filter((r) => r.favoriteCount >= minLikes);

    // Get existing TikTok captions for dedup
    const supabase = getSupabaseClient();
    const { data: existingPosts } = await supabase
      .from("posts")
      .select("caption")
      .eq("platform", "tiktok");

    const existingCaptions = new Set(
      (existingPosts || []).map((p) => p.caption)
    );

    // Filter out already-posted entries (check both raw and normalized text)
    const available = highPerformers.filter((r) => {
      const normalized = normalizeTweetText(r.text);
      return !existingCaptions.has(r.text) && !existingCaptions.has(normalized);
    });

    if (available.length === 0) {
      return NextResponse.json({
        picked: [],
        total: highPerformers.length,
        remaining: 0,
        message: "All high-performing bank tweets have been posted to TikTok.",
      });
    }

    const selected = shuffle(available).slice(0, count);

    return NextResponse.json({
      picked: selected.map((r) => ({
        tweetId: r.tweetId,
        text: r.text,
        favoriteCount: r.favoriteCount,
      })),
      total: highPerformers.length,
      remaining: available.length - selected.length,
    });
  } catch (err) {
    console.error("TikTok bank-pick error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
