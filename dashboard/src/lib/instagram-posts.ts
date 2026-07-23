/**
 * Instagram post data reader — reads data/instagram-post-data-all.csv.
 *
 * CSV format (Meta Business Suite export):
 *   Post ID, Description, Publish time, Permalink, Post type, Views, Reach,
 *   Likes, Shares, Follows, Comments, Saves
 *
 * Used server-side by /instagram-reposts to list and sort past posts by saves.
 * Returns [] when the CSV is absent so the page degrades gracefully.
 */

import fs from 'fs';
import path from 'path';

export interface InstagramPost {
  postId: string;
  permalink: string;
  saves: number;
  publishTime: Date;
  postType: string;
}

// Reuse the same data-dir convention as tweet-bank.ts so one env var
// controls both (set by GitHub Actions and Render for production runs).
function getDataDir(): string {
  return process.env.TWEET_BANK_DATA_DIR || path.resolve(process.cwd(), '..', 'data');
}

export function getCsvPath(): string {
  return path.join(getDataDir(), 'instagram-post-data-all.csv');
}

/**
 * Parse instagram-post-data-all.csv and return rows sorted by saves descending.
 * Returns [] if the file is absent (the page renders an empty-state card).
 */
export function parseInstagramPosts(): InstagramPost[] {
  const csvPath = getCsvPath();

  let raw: string;
  try {
    raw = fs.readFileSync(csvPath, 'utf-8');
  } catch {
    return [];
  }

  // csv-parse/sync handles quoted fields that contain commas (e.g. descriptions).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parse } = require('csv-parse/sync');
  const rows: string[][] = parse(raw, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const col = (name: string): number => header.indexOf(name);

  const idxPostId = col('post id');
  const idxPermalink = col('permalink');
  const idxSaves = col('saves');
  const idxPublishTime = col('publish time');
  const idxPostType = col('post type');

  // Can't proceed without at least a URL and saves count.
  if (idxPermalink === -1 || idxSaves === -1) return [];

  const posts: InstagramPost[] = [];
  for (const row of rows.slice(1)) {
    const permalink = row[idxPermalink]?.trim();
    if (!permalink) continue;

    // Remove thousands-separator commas before parsing ("1,795" → 1795).
    const savesRaw = row[idxSaves]?.replace(/,/g, '').trim();
    const saves = parseInt(savesRaw ?? '0', 10);

    // Publish time: Meta exports as "MM/DD/YYYY H:MM" — Date constructor
    // parses this fine in V8.
    let publishTime = new Date(0);
    if (idxPublishTime >= 0 && row[idxPublishTime]) {
      const parsed = new Date(row[idxPublishTime]);
      if (!isNaN(parsed.getTime())) publishTime = parsed;
    }

    posts.push({
      postId: idxPostId >= 0 ? (row[idxPostId]?.trim() ?? '') : '',
      permalink,
      saves: isNaN(saves) ? 0 : saves,
      publishTime,
      postType: idxPostType >= 0 ? (row[idxPostType]?.trim() ?? '') : '',
    });
  }

  return posts.sort((a, b) => b.saves - a.saves);
}
