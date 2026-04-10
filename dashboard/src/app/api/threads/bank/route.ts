/**
 * POST /api/threads/bank — Manually trigger content bank sourcing for Threads.
 *
 * Reads TweetMasterBank.csv (columns: tweet_id, text, favorite_count),
 * deduplicates against existing posts, selects random entries, and creates
 * scheduled posts in Supabase.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { verifyApiAuth } from "@/lib/auth";

/**
 * Parse the content bank CSV and extract just the text column.
 * Handles TweetMasterBank.csv format (tweet_id, text, favorite_count)
 * as well as legacy single-column CSVs.
 */
function parseCsv(raw: string): string[] {
  // Lazy-require csv-parse — handles quoted multiline fields correctly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require("csv-parse/sync");
  const rows: string[][] = parse(raw, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length === 0) return [];

  // Detect header row and text column index
  const header = rows[0];
  const headerLower = header.map((h) => h.toLowerCase());
  let textCol = 0;
  let startRow = 0;

  if (headerLower.includes("text")) {
    textCol = headerLower.indexOf("text");
    startRow = 1; // skip header
  } else if (header.length > 1) {
    textCol = 1;
    startRow = 1;
  }

  return rows
    .slice(startRow)
    .map((row) => row[textCol]?.trim())
    .filter((text): text is string => Boolean(text));
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function POST(request: Request) {
  if (!(await verifyApiAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bankPath = resolve(
    process.cwd(),
    process.env.CONTENT_BANK_PATH || "../data/TweetMasterBank.csv"
  );
  const count = parseInt(process.env.CONTENT_BANK_COUNT || "5", 10);

  // Path containment check — ensure the resolved bank path stays within
  // the project root so a misconfigured CONTENT_BANK_PATH env var can't
  // read arbitrary files on the filesystem (e.g. /etc/passwd).
  const projectRoot = resolve(process.cwd(), "..");
  if (!bankPath.startsWith(projectRoot)) {
    console.error("Bank path escapes project root:", bankPath);
    return NextResponse.json(
      { error: "Invalid content bank path configuration" },
      { status: 400 }
    );
  }

  if (!existsSync(bankPath)) {
    // Don't expose the full filesystem path to the client — it reveals
    // the server's directory structure and aids reconnaissance.
    console.error("Content bank file not found:", bankPath);
    return NextResponse.json(
      { error: "Content bank file not found" },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();

  // Log cron run start
  const { data: cronRun } = await supabase
    .from("cron_runs")
    .insert({ platform: "threads", job_type: "content_bank", status: "running" })
    .select("id")
    .single();
  const runId = cronRun?.id;

  try {
    // Read and parse single-column CSV (handles quoted multiline entries)
    const raw = readFileSync(bankPath, "utf-8");
    const allEntries = parseCsv(raw);

    // Get existing captions to deduplicate
    const { data: existingPosts } = await supabase
      .from("posts")
      .select("caption")
      .eq("platform", "threads");

    const existingCaptions = new Set(
      (existingPosts || []).map((p) => p.caption)
    );

    // Filter out already-posted entries
    const available = allEntries.filter((e) => !existingCaptions.has(e));

    if (available.length === 0) {
      if (runId) {
        await supabase
          .from("cron_runs")
          .update({
            status: "success",
            finished_at: new Date().toISOString(),
            posts_processed: 0,
          })
          .eq("id", runId);
      }
      return NextResponse.json({
        sourced: 0,
        total: allEntries.length,
        remaining: 0,
        message: "Content bank exhausted — all entries have been posted.",
      });
    }

    // Shuffle and pick
    const selected = shuffle(available).slice(0, count);
    const now = new Date().toISOString();
    let sourced = 0;

    for (const text of selected) {
      const { data: post } = await supabase
        .from("posts")
        .insert({
          platform: "threads",
          caption: text,
          status: "scheduled",
        })
        .select("id")
        .single();

      if (post) {
        await supabase
          .from("schedules")
          .insert({ post_id: post.id, scheduled_for: now });
        sourced++;
      }
    }

    if (runId) {
      await supabase
        .from("cron_runs")
        .update({
          status: "success",
          finished_at: new Date().toISOString(),
          posts_processed: sourced,
        })
        .eq("id", runId);
    }

    return NextResponse.json({
      sourced,
      total: allEntries.length,
      remaining: available.length - sourced,
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error("Threads bank error:", err);
    if (runId) {
      await supabase
        .from("cron_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: message,
        })
        .eq("id", runId);
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
