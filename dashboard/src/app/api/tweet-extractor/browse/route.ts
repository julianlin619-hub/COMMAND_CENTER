/**
 * GET /api/tweet-extractor/browse?dir=<absolute path>
 *
 * Lists a directory on THIS machine so the Tweet Extractor UI can offer a
 * standard-view file picker that yields a real filesystem path. A browser's
 * native file dialog deliberately hides the absolute path from JavaScript, but
 * the local-file transcription needs that path — so the dashboard's own server
 * (running on the same machine in dev) does the listing instead.
 *
 * Returns the resolved directory, its parent (null at the filesystem root), and
 * its entries: sub-folders plus media files (other file types are hidden as
 * noise). Dotfiles and unreadable/broken entries are skipped.
 *
 * ⚠️ SECURITY: this exposes the local filesystem, so — like the transcribe route
 * — it is DISABLED in production (NODE_ENV=production) and gated by verifyApiAuth.
 * It's a local-dev convenience, never a deployed feature.
 */

import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync } from "fs";
import path from "path";
import os from "os";
import { verifyApiAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// File types worth transcribing. Folders are always shown; any file outside this
// set is hidden so the list reads like a media picker, not a raw directory dump.
const MEDIA_EXT = new Set([
  ".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi", // video
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", // audio
]);

type Entry = { name: string; path: string; type: "dir" | "file"; size?: number };

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "File browsing is disabled in production." },
      { status: 403 },
    );
  }
  if (!(await verifyApiAuth(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Default to the user's home directory; resolve to an absolute, normalized path.
  const raw = new URL(req.url).searchParams.get("dir");
  const dir = path.resolve(raw && raw.trim() ? raw : os.homedir());

  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch {
    return NextResponse.json({ error: `No such directory: ${dir}` }, { status: 404 });
  }
  if (!dirStat.isDirectory()) {
    return NextResponse.json({ error: `Not a directory: ${dir}` }, { status: 400 });
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return NextResponse.json({ error: `Cannot read directory: ${dir}` }, { status: 403 });
  }

  const entries: Entry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles, like a standard view
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full); // follows symlinks; a broken link throws → skipped
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      entries.push({ name, path: full, type: "dir" });
    } else if (st.isFile() && MEDIA_EXT.has(path.extname(name).toLowerCase())) {
      entries.push({ name, path: full, type: "file", size: st.size });
    }
  }

  // Folders first, then files, each alphabetical (case-insensitive).
  entries.sort((a, b) =>
    a.type !== b.type
      ? a.type === "dir"
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const parent = path.dirname(dir);
  return NextResponse.json({
    dir,
    parent: parent === dir ? null : parent, // null at the root
    entries,
  });
}
