// ---------------------------------------------------------------------------
// Command Center config — single source of truth for the home page.
//
// This file is intentionally a static config (not a DB read). Following the
// project's "no premature abstraction" rule from CLAUDE.md, we hand-write the
// formats list here until there's a real product reason to model formats in
// Supabase. The shape is JSON-serializable (string literal unions, plain
// arrays), so moving to a DB later won't require touching the React tree.
// ---------------------------------------------------------------------------
import type { FormatGroup } from "@/app/strategy/strategy-config";

// Re-export so the home page doesn't have to import from a sibling route's
// internal config. `FormatGroup` is the existing taxonomy: long/mid/short/written.
export type { FormatGroup };

// The set of platforms a format can publish to. Distinct from the
// platform-enum the cron pipeline uses (which has variants like
// `instagram_2nd`, `threads_leila`, …) — at the Command Center level we
// collapse those down to the brand-facing identity. The chip's `name`
// field is what users see; the `id` drives the icon lookup in
// platform-chip.tsx.
export type PlatformId =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "x"
  | "linkedin"
  | "threads"
  | "facebook";

export interface FormatPlatform {
  id: PlatformId;
  name: string;
}

// Creator identity. The home page renders one creator at a time via the
// CreatorToggle and a `?creator=` URL search param. Defaults to "alex"
// when the param is absent. Leila's formats wrap her two existing crons
// (`linkedin-leila-cron`, `threads-leila-cron`) and route to her existing
// detail pages — no backend changes yet.
export type CreatorKey = "alex" | "leila";

export const CREATORS: { key: CreatorKey; label: string }[] = [
  { key: "alex", label: "Alex" },
  { key: "leila", label: "Leila" },
];

export const DEFAULT_CREATOR: CreatorKey = "alex";

/** Parse a raw URL search-param value into a valid CreatorKey, falling
 *  back to the default. Centralised so the toggle and the home page
 *  agree on what counts as "leila" (case-insensitive, ignores junk). */
export function parseCreatorParam(raw: string | string[] | undefined): CreatorKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v && v.toLowerCase() === "leila") return "leila";
  return DEFAULT_CREATOR;
}

export interface Format {
  id: string;
  name: string;
  subtitle: string;
  category: FormatGroup;
  status: "live" | "paused";
  creator: CreatorKey;
  platforms: FormatPlatform[];
  // Optional route to navigate to when the format card is clicked. When
  // omitted the card is a no-op (placeholder for formats that don't have
  // a detail view yet). When set, FormatCard wraps the surface in a
  // Next.js navigation so the click takes the user to the legacy
  // per-platform automation page.
  href?: string;
}

// Category color tokens. These are intentionally NOT the dashboard's
// terracotta accent — the Command Center page introduces its own palette
// because each category carries identity (Short feels different than Long).
// Used in: pulse bars, chip tints, category labels, legend swatches.
export const CATEGORY_COLORS: Record<FormatGroup, string> = {
  short: "#16B68A", // teal-green
  written: "#A8A39A", // warm gray
  long: "#E5562C", // orange
  mid: "#7B6FE8", // purple
};

export const CATEGORY_LABELS: Record<FormatGroup, string> = {
  short: "Short",
  written: "Written",
  long: "Long",
  mid: "Mid",
};

// Command Center display order. Active sections render in this order, then
// empty sections fall back to the same order at the bottom of the page.
//
// Deliberately differs from `FORMAT_GROUP_ORDER` in strategy-config.ts
// (which is long→mid→short→written for the matrix). Here we front-load
// "short" because that's where most active formats live today, and "mid"
// is last because it's currently empty.
export const CATEGORY_ORDER: FormatGroup[] = [
  "short",
  "written",
  "long",
  "mid",
];

export const FORMATS: Format[] = [
  // ──────────────────────────── Alex ────────────────────────────
  {
    id: "reposts",
    name: "Reposts",
    subtitle: "Auto-recycle top performers",
    category: "short",
    status: "live",
    creator: "alex",
    platforms: [{ id: "youtube", name: "YouTube" }],
    // No href yet — the "auto-recycle top performers" workflow doesn't
    // have a detail page. Clicking the card is a no-op until one exists.
  },
  {
    id: "crosspost-short",
    name: "Crosspost",
    subtitle: "Multi-platform syndication",
    category: "short",
    status: "live",
    creator: "alex",
    platforms: [
      { id: "instagram", name: "Instagram" },
      { id: "tiktok", name: "TikTok" },
      { id: "youtube", name: "YouTube" },
      { id: "x", name: "X" },
    ],
    // Links to the manual-upload page — user-triggered form that fans the
    // same video out to TikTok, YouTube Shorts, and LinkedIn (and X via
    // the Twitter bridge). The "multi-platform syndication" subtitle on
    // this card describes exactly what /manual-upload does, so it's the
    // natural detail surface. API endpoints stay at
    // /api/tiktok/manual-upload — backend routes were not renamed.
    href: "/manual-upload",
  },
  {
    id: "tweet-cards",
    name: "Tweet Cards",
    subtitle: "Short-form visuals",
    category: "short",
    status: "live",
    creator: "alex",
    platforms: [
      { id: "tiktok", name: "TikTok" },
      { id: "facebook", name: "Facebook" },
      { id: "linkedin", name: "LinkedIn" },
      { id: "instagram", name: "Instagram" },
    ],
    // /tweet-cards hosts both unified pathways: "X Outlier Reel" (Apify
    // scrape of @AlexHormozi) and "X Bank Reel" (random pick from
    // TweetMasterBank.csv). Each pathway renders the source tweet 3 ways
    // — 1080×1920 MP4 (TikTok), 1080×1080 PNG (Facebook), 1080×1080 PNG
    // with LinkedIn color overrides — and fans out to four Buffer
    // channels in a single cron run. Instagram's leg reuses the Facebook
    // PNG byte-for-byte and queues as instagram_post_type='post' (feed
    // post — no Reel cross-post anymore).
    href: "/tweet-cards",
  },
  {
    id: "crosspost-written",
    name: "Crosspost",
    subtitle: "Text syndication",
    category: "written",
    status: "live",
    creator: "alex",
    platforms: [
      { id: "x", name: "X" },
      { id: "threads", name: "Threads" },
    ],
    // Threads automation page filtered to the Cross-Post pathway —
    // for written crosspost (X → Threads) this is the actual underlying
    // workflow.
    href: "/threads?pathway=crosspost",
  },
  {
    id: "bank-post-written",
    name: "Bank Post",
    subtitle: "Tweet bank syndication",
    category: "written",
    status: "live",
    creator: "alex",
    platforms: [
      { id: "x", name: "X" },
      { id: "threads", name: "Threads" },
    ],
    // Same /threads page filtered to Pathway 2 ("X Bank-Post") — random
    // unposted entries from TweetMasterBank.csv → Threads via Buffer.
    href: "/threads?pathway=bank",
  },
  // ──────────────────────────── Leila ────────────────────────────
  // Wraps Leila's two existing crons as-is (linkedin-leila-cron at 11:45
  // UTC, threads-leila-cron at 11:00 UTC). The detail pages already exist
  // under /leila/*. No backend changes — the toggle just surfaces them on
  // the home page.
  {
    id: "leila-tweet-cards",
    name: "Tweet Cards",
    subtitle: "Quote-card visuals",
    category: "short",
    status: "live",
    creator: "leila",
    platforms: [{ id: "linkedin", name: "LinkedIn" }],
    // /leila/linkedin shows the linkedin-leila-cron pathway:
    // Apify @LeilaHormozi → 1080×1080 quote card → Buffer LinkedIn
    // with caption "Agree?".
    href: "/leila/linkedin",
  },
  {
    id: "leila-crosspost-written",
    name: "Crosspost",
    subtitle: "Text syndication",
    category: "written",
    status: "live",
    creator: "leila",
    platforms: [{ id: "threads", name: "Threads" }],
    // /leila/threads shows the threads-leila-cron pathway:
    // Apify @LeilaHormozi tweets → Buffer Threads.
    href: "/leila/threads",
  },
];
