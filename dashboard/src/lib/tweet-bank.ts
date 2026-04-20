/**
 * Tweet bank — reads tweets from a shared CSV and tracks per-platform usage.
 *
 * Both Instagram and Threads pull from the same CSV file (TweetMasterBank.csv),
 * but each platform maintains its own history of which tweets it has already
 * used. This means the same tweet can appear on Instagram AND Threads, but
 * won't be repeated on the same platform.
 *
 * The history is stored in JSON files at the repo root (data/ directory):
 *   - data/ig-bank-history.json      — Instagram's used-tweet tracking
 *   - data/threads-bank-history.json  — Threads' used-tweet tracking
 *
 * These JSON files are committed back to the repo by GitHub Actions after
 * each pipeline run, which is how state persists between runs.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// The data directory lives at the repo root, one level up from the dashboard.
// In GitHub Actions, TWEET_BANK_DATA_DIR is set explicitly to the absolute path.
// When running locally from the dashboard directory, we default to ../data.
function getDataDir(): string {
  return process.env.TWEET_BANK_DATA_DIR || path.resolve(process.cwd(), '..', 'data');
}

function getBankFilePath(): string {
  return path.join(getDataDir(), 'TweetMasterBank.csv');
}

// Each platform gets its own history file so they track usage independently.
// Instagram uses "ig-bank-history.json", Threads uses "threads-bank-history.json".
function getHistoryPath(platform: 'instagram' | 'threads' | 'tiktok'): string {
  const prefixMap: Record<string, string> = {
    instagram: 'ig',
    threads: 'threads',
    tiktok: 'tiktok',
  };
  return path.join(getDataDir(), `${prefixMap[platform]}-bank-history.json`);
}

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

interface BankHistory {
  usedHashes: string[];
  bankBatchCount: number;
}

export interface BankTweet {
  hash: string;
  text: string;
}

export function hashTweet(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

/**
 * Parse the shared CSV bank file into an array of tweets with hashes.
 * Handles TweetMasterBank.csv format (tweet_id, text, favorite_count)
 * as well as legacy single-column CSVs.
 */
export function parseBankFile(): BankTweet[] {
  // Lazy-require csv-parse — it's an optionalDependency that may not be
  // installed in every environment (e.g. local dev without the pipeline).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require('csv-parse/sync');
  const raw = fs.readFileSync(getBankFilePath(), 'utf-8');
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

  if (headerLower.includes('text')) {
    textCol = headerLower.indexOf('text');
    startRow = 1; // skip header
  } else if (header.length > 1) {
    textCol = 1;
    startRow = 1;
  }

  return rows
    .slice(startRow)
    .map((row) => row[textCol]?.trim())
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ hash: hashTweet(text), text: decodeHtml(text) }));
}

function getBankHistory(platform: 'instagram' | 'threads' | 'tiktok'): BankHistory {
  const historyPath = getHistoryPath(platform);
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    return JSON.parse(raw) as BankHistory;
  } catch {
    // If the file doesn't exist yet, create it with defaults
    const defaults: BankHistory = { usedHashes: [], bankBatchCount: 0 };
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

function writeBankHistory(platform: 'instagram' | 'threads' | 'tiktok', history: BankHistory): void {
  const historyPath = getHistoryPath(platform);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Pick `count` random unused tweets for the given platform.
 * "Unused" means the tweet's hash is not in that platform's history file.
 * Uses Fisher-Yates shuffle for unbiased random selection.
 */
export function pickRandomUnused(
  platform: 'instagram' | 'threads' | 'tiktok',
  count: number
): { picked: BankTweet[]; remainingUnused: number } {
  const all = parseBankFile();
  const { usedHashes } = getBankHistory(platform);
  const usedSet = new Set(usedHashes);
  const available = all.filter((t) => !usedSet.has(t.hash));

  // Fisher-Yates shuffle for unbiased random ordering
  const shuffled = [...available];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const picked = shuffled.slice(0, Math.min(count, shuffled.length));
  return { picked, remainingUnused: available.length - picked.length };
}

/**
 * Mark tweet hashes as used for a specific platform.
 * Called after successful scheduling — never before, so a failed run
 * doesn't consume tweets from the pool.
 */
export function markUsed(platform: 'instagram' | 'threads' | 'tiktok', hashes: string[]): void {
  const history = getBankHistory(platform);
  const merged = Array.from(new Set([...history.usedHashes, ...hashes]));
  writeBankHistory(platform, { ...history, usedHashes: merged });
}

/**
 * Increment and return the next batch number for a platform.
 * Used to name Google Drive folders (e.g., "IG Bank Batch #6").
 */
export function getNextBankBatchNumber(platform: 'instagram' | 'threads' | 'tiktok'): number {
  const history = getBankHistory(platform);
  const next = history.bankBatchCount + 1;
  writeBankHistory(platform, { ...history, bankBatchCount: next });
  return next;
}

/**
 * Reset a platform's usage history. Useful if you want to re-use
 * tweets that were previously scheduled (e.g., after refreshing the CSV).
 */
export function resetBankHistory(platform: 'instagram' | 'threads' | 'tiktok'): void {
  writeBankHistory(platform, { usedHashes: [], bankBatchCount: 0 });
}
