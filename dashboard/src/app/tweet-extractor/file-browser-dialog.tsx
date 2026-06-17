"use client";

/**
 * A standard-view file picker, backed by the local filesystem via
 * /api/tweet-extractor/browse. Opens at the home folder; click a folder to
 * navigate in, the "Up" row to go to the parent, and a media file to pick it.
 * Picking returns the file's absolute path (which a browser's native dialog
 * can't give us) so the local-file transcription can read it.
 *
 * Dev-only, like the routes it calls.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  FolderIcon,
  FileVideoIcon,
  CornerLeftUpIcon,
  LoaderIcon,
} from "lucide-react";

type Entry = { name: string; path: string; type: "dir" | "file"; size?: number };
type BrowseResponse = { dir: string; parent: string | null; entries: Entry[] };

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function FileBrowserDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (filePath: string) => void;
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const qs = target ? `?dir=${encodeURIComponent(target)}` : "";
      const res = await fetch(`/api/tweet-extractor/browse${qs}`);
      const data = (await res.json()) as BrowseResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setDir(data.dir);
      setParent(data.parent);
      setEntries(data.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read directory");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the home folder each time the dialog opens.
  useEffect(() => {
    if (open) load(null);
  }, [open, load]);

  function choose(entry: Entry) {
    if (entry.type === "dir") {
      load(entry.path);
    } else {
      onPick(entry.path);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a file</DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px] text-white/45">
            {dir ?? "…"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] min-h-[200px] overflow-y-auto rounded-lg border border-[var(--surface-border)]">
          {loading ? (
            <div className="flex h-[200px] items-center justify-center text-white/45">
              <LoaderIcon className="size-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-[var(--pill-warn-fg)]">{error}</div>
          ) : (
            <ul className="divide-y divide-[var(--surface-border)]">
              {parent && (
                <li>
                  <button
                    type="button"
                    onClick={() => load(parent)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-white/70 transition-colors hover:bg-[var(--surface-raised)]"
                  >
                    <CornerLeftUpIcon className="size-4 shrink-0 text-white/40" />
                    <span className="font-mono text-[12px] text-white/50">.. (up)</span>
                  </button>
                </li>
              )}
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => choose(entry)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--surface-raised)]"
                  >
                    {entry.type === "dir" ? (
                      <FolderIcon className="size-4 shrink-0 text-[var(--terracotta-hover)]" />
                    ) : (
                      <FileVideoIcon className="size-4 shrink-0 text-white/45" />
                    )}
                    <span className="flex-1 truncate text-white/80">{entry.name}</span>
                    {entry.type === "file" && (
                      <span className="font-mono text-[10.5px] tabular text-white/35">
                        {formatSize(entry.size)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {entries.length === 0 && (
                <li className="px-3 py-6 text-center text-[12px] text-white/40">
                  No folders or media files here.
                </li>
              )}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
