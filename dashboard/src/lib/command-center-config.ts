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
  | "facebook"
  | "snapchat";

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
  // Optional within-category subdivision (see FormatSubgroup below).
  // Currently only applied to Alex's Short formats so the row can show
  // "Creation" vs "Distribution" sub-headers.
  subgroup?: FormatSubgroup;
  // List of `posts.platform` values that this format's automation
  // writes to. Used by the home page to derive a health signal from a
  // 24h count of `sent_to_buffer` / `published` rows on those platforms.
  // Leave undefined when the format has no live automation behind it
  // (Reposts, L1 Q&A) — the card falls back to "paused" via `status`.
  // Set even on cards that are currently paused at the infra layer
  // (Bulk Tweet Cards, Scheduling) so flipping `status` back to "live"
  // immediately surfaces real counts.
  healthPlatforms?: string[];
}

// Card health, derived at request time on the home page. Driven by:
//   - `paused` when `format.status === "paused"` (operator-disabled).
//   - `healthy` when ≥ 1 post on any of the format's `healthPlatforms`
//     in the last 24h.
//   - `failing` otherwise (live but nothing has gone out).
// Exported here so the health helpers (lib/format-health.ts) and the
// FormatCard pill share one definition.
export type FormatHealth = "healthy" | "failing" | "paused";

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

// Optional subdivision *within* a category. Today only "short" uses
// subgroups (Creation vs Distribution), but the field is on the base
// Format type so any category can opt in by tagging its formats. When a
// category has 2+ distinct subgroups present, CategorySection renders
// each as a faint-headed sub-section. Categories where all formats omit
// `subgroup` (or share a single subgroup) render flat as before.
export type FormatSubgroup = "creation" | "distribution";

export const SUBGROUP_ORDER: FormatSubgroup[] = ["distribution", "creation"];

export const SUBGROUP_LABELS: Record<FormatSubgroup, string> = {
  creation: "Creation",
  distribution: "Distribution",
};

export const FORMATS: Format[] = [
  // ──────────────────────────── Alex ────────────────────────────
  // Order within each category drives left-to-right placement in the
  // home page's CategorySection grid. For "short" we keep the two live
  // formats first (Crosspost, Tweet Cards) and the paused Reposts card
  // last so it sits on the right edge — a visual cue that it's the
  // odd-one-out until the auto-recycle workflow ships.
  {
    id: "crosspost-short",
    name: "Crosspost",
    subtitle: "Multi-platform syndication",
    category: "short",
    status: "live",
    creator: "alex",
    subgroup: "distribution",
    // Matches the actual fan-out in /api/tiktok/manual-upload: TikTok,
    // YouTube Shorts, LinkedIn (gated by LINKEDIN_FANOUT_ENABLED but
    // listed because the gate is expected to flip back on), and X via
    // the Twitter bridge (service="twitter", channel="acq_official").
    // Instagram is NOT a destination of this workflow — the previous
    // entry had it listed in error.
    platforms: [
      { id: "tiktok", name: "TikTok" },
      { id: "youtube", name: "YouTube" },
      { id: "linkedin", name: "LinkedIn" },
      { id: "x", name: "X" },
    ],
    // Links to the manual-upload page — user-triggered form that fans the
    // same video out to TikTok, YouTube Shorts, and LinkedIn (and X via
    // the Twitter bridge). The "multi-platform syndication" subtitle on
    // this card describes exactly what /manual-upload does, so it's the
    // natural detail surface. API endpoints stay at
    // /api/tiktok/manual-upload — backend routes were not renamed.
    href: "/manual-upload",
    // The route writes 4 posts per upload, one per platform. The X leg
    // lands as platform="x_acq_official" (not "twitter") — see
    // /api/tiktok/manual-upload/route.ts.
    healthPlatforms: ["tiktok", "youtube", "x_acq_official", "linkedin"],
  },
  {
    id: "tweet-cards",
    name: "Tweet Cards",
    subtitle: "Short-form visuals",
    category: "short",
    status: "live",
    creator: "alex",
    subgroup: "creation",
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
    // Cron writes one post row per platform per run (see
    // cron/_tweet_card_legs.py): tiktok / facebook / linkedin /
    // instagram. Any of the four producing a row in the last 24h marks
    // the format healthy.
    healthPlatforms: ["tiktok", "facebook", "linkedin", "instagram"],
  },
  {
    id: "reposts",
    name: "Reposts",
    subtitle: "Auto-recycle top performers",
    category: "short",
    // Paused until the automation lands (see TODO.md). The card still
    // renders for visibility but doesn't run the animated pulse, isn't
    // counted in the header's "N live" tally, and has no href — clicking
    // it is a no-op. Flip back to "live" and add an href when the
    // auto-recycle workflow ships.
    status: "paused",
    creator: "alex",
    subgroup: "distribution",
    platforms: [{ id: "youtube", name: "YouTube" }],
  },
  {
    // Bulk Tweet Cards — the /instagram-2nd pipeline. Picks tweets from
    // the CSV bank, renders quote-card media (PNG/MP4), and queues them
    // to the "alexhighlights2026" Buffer channel (Instagram's 2nd
    // account). Distinct from the regular Tweet Cards card (which
    // multi-platform fans a single source tweet) — this one is the
    // bulk, single-destination daily pipeline.
    //
    // Status is "paused" because the GitHub Actions schedule trigger
    // is currently commented out in .github/workflows/ig-pipeline.yml
    // (see also `instagram_2nd.paused: true` in lib/cron-schedule.ts).
    // The detail page at /instagram-2nd still loads — it shows the
    // last batch the cron queued and the remaining bank — so the card
    // stays clickable while the muted opacity treatment signals that
    // the automation is suspended at the infra layer. Flip to "live"
    // when the workflow trigger is re-enabled.
    id: "bulk-tweet-cards",
    name: "Bulk Tweet Cards",
    subtitle: "Bank → 2nd Instagram",
    category: "short",
    status: "paused",
    creator: "alex",
    subgroup: "creation",
    platforms: [{ id: "instagram", name: "Instagram" }],
    href: "/instagram-2nd",
    // ig-pipeline writes posts under platform="instagram_2nd". Tagged
    // even though status is currently "paused" so the count appears
    // immediately when the GitHub Actions trigger is re-enabled.
    healthPlatforms: ["instagram_2nd"],
  },
  {
    // Snapchat Spotlight via Playwright. Hourly: /api/snapchat-pipeline
    // (Next.js route) picks a tweet, renders MP4, and inserts posts +
    // schedules rows. Five minutes later, cron/snapchat_pipeline.py claims
    // the schedule and drives headless Chromium against Snap's Web
    // Uploader. Distinct from every other format because the publish
    // path is browser automation, not an HTTP API — there's no Buffer in
    // the loop. See /snapchat for the full flow + AUTH_EXPIRED recovery
    // instructions.
    id: "snapchat-playwright",
    name: "Playwright",
    subtitle: "Snapchat Spotlight via headless Chromium",
    category: "short",
    status: "live",
    creator: "alex",
    subgroup: "distribution",
    platforms: [{ id: "snapchat", name: "Snapchat" }],
    href: "/snapchat",
    // The publisher cron writes posts under platform="snapchat" and flips
    // them to status='published' only when Snap's success indicator
    // confirms the post landed — so a healthy pill here means real
    // publishes, not just "we queued something".
    healthPlatforms: ["snapchat"],
  },
  {
    // L1 Q&A — pipeline doesn't exist yet, but /l1-qa hosts a static
    // visual map of the planned automation so the design is the source
    // of truth while the actual cron is being scoped. Status stays
    // "paused" (no live pulse, not counted in the header's live tally)
    // and `platforms` is left empty so the card hides its "Publishes
    // to" eyebrow until destinations are decided. Flip to "live" once
    // the workflow ships.
    id: "l1-qa",
    name: "L1 Q&A",
    subtitle: "Automation map",
    category: "short",
    status: "paused",
    creator: "alex",
    subgroup: "creation",
    platforms: [],
    href: "/l1-qa",
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
    // The threads cron writes one row per published post under
    // platform="threads", with the pathway tucked into metadata. We
    // intentionally share this signal with bank-post-written below —
    // both pathways flow through the same daily cron, and splitting by
    // metadata->>'pathway' would add a JSON filter for marginal signal.
    healthPlatforms: ["threads"],
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
    // Shares the threads cron's signal with crosspost-written above —
    // see that comment for why we don't split by pathway.
    healthPlatforms: ["threads"],
  },
  {
    // Studio-first scheduling pipeline — discovers Private drafts in
    // YouTube Studio (2nd channel), generates transcript-based titles,
    // and assigns each video to a publish slot.
    //
    // Status is "paused" because the youtube-second-cron is currently
    // suspended at the infra layer (see render.yaml — service commented
    // out, and `youtube_second.paused: true` in lib/cron-schedule.ts).
    // The detail page at /youtube-second still works and shows the
    // last batch the cron scheduled; flip to "live" when the cron is
    // resumed on Render.
    id: "scheduling-mid",
    name: "Scheduling",
    subtitle: "Auto-schedule Studio drafts",
    category: "mid",
    status: "paused",
    creator: "alex",
    platforms: [{ id: "youtube", name: "YouTube" }],
    href: "/youtube-second",
    // No `healthPlatforms` on purpose: the youtube_cron writes posts
    // under platform="youtube", but so does the /manual-upload route
    // (crosspost-short's YouTube leg). Tagging this card with ["youtube"]
    // would let manual-upload runs flip scheduling-mid green even when
    // the studio cron itself is dead. The crons are distinguishable via
    // metadata.source='studio' (see /youtube-second/page.tsx:121), so
    // once this format is unpaused, switch to a {platform, metadataSource}
    // filter rather than a bare platform list.
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
    healthPlatforms: ["linkedin_leila"],
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
    healthPlatforms: ["threads_leila"],
  },
];
