// ---------------------------------------------------------------------------
// Strategy config — single source of truth for the /strategy page.
//
// This is the MATRIX-REDESIGN-TEST shape. The page currently visualizes the
// content strategy as a Shows × FormatGroups grid (rather than the previous
// SOURCE → FORMAT → DISTRIBUTION pillar tabs). We're trying this layout to
// see whether it's more readable at a glance than the master-detail UI.
//
// Two top-level concepts:
//   - Show: a content franchise (Scale or Fail, Hotline, The Game, …) tagged
//     with the "source" it originates from (live recording / event / DTC /
//     written) and a per-format-group distribution status (active / experiment
//     / none).
//   - PlatformGroup: the bucket of platforms that consumes each format group
//     (e.g. the LONG bucket = YouTube + Podcasts). Used for the column
//     headers and the platform-settings card below the matrix.
//
// Why a static config file (not the database)?
//   - This data changes infrequently and is edited by hand.
//   - Keeping it in source means changes flow through git review.
//   - Types are JSON-serializable (string literal unions, no enums) so a
//     future move to Supabase doesn't require shape changes.
// ---------------------------------------------------------------------------

// The originating bucket a show comes from. Drives the row's colored bar
// and the color of every status pill on that row.
export type Source = "live" | "event" | "dtc" | "words";

// One of four output-shape buckets. The matrix has one column per group;
// each cell answers "does this show ship to this group, and at what
// confidence level?"
export type FormatGroup = "long" | "mid" | "short" | "written";

// Lifecycle of a Show × FormatGroup intersection.
//   - active: shipping today.
//   - experiment: we're trying it. Renders as a dashed outline pill.
//   - none: not in scope. Renders as an em-dash that's still clickable
//     (clicking promotes it to `experiment` per the spec's "safer default
//     for adding something new" rule).
export type Status = "active" | "experiment" | "none";

// One of three fixed stages in a show's automation workflow. Drives the
// drawer's Automation tab — steps are grouped by category and rendered
// in this order: Capture → Production → Distribution.
export type StepCategory = "capture" | "production" | "distribution";

// One step in a show's automation workflow. Lives inside Show.automation.
// `group` + `status` are only meaningful for distribution steps; they're
// optional on the type so non-distribution steps don't have to carry
// dead fields.
//
// Note: `status` is stored explicitly rather than derived from the
// matrix's distribution[group]. The two can drift if the user cycles the
// matrix cell after adding the step; we don't auto-sync because doing so
// would force a "which is canonical" decision. The user can re-add the
// step or click Reset to realign.
export interface AutomationStep {
  id: string;
  category: StepCategory;
  title: string;
  description?: string;
  group?: FormatGroup;
  // WARNING: not rendered — the UI reads from show.distribution[step.group]
  // as the single source of truth for the pill on a distribution card.
  // Kept on the type for forward-compat (future overrides, migrations).
  status?: Status;
}

export interface Show {
  // Stable kebab-case id. Used as the React key and as the address in
  // the reducer when a cell click mutates state.
  id: string;

  // Display name shown in the sticky-left column.
  name: string;

  // Drives the row color bar + the color of every pill on the row.
  source: Source;

  // Per-format-group status. Every group must be present (Record, not
  // Partial) so the matrix never renders a hole — cells are always one of
  // active / experiment / none.
  distribution: Record<FormatGroup, Status>;

  // Drawer-only metadata. All optional so existing shows can stay sparse.
  // The drawer subtitle renders an em-dash for any undefined value.
  owner?: string;
  updatedAt?: string;

  // Drawer's Automation tab content. Empty array = "no steps yet"; the
  // drawer renders placeholder text in each category section.
  automation: AutomationStep[];

  // Drawer's Creative Brief tab content. Bound to the textarea via
  // "commit on blur" — typing doesn't update React state; tabbing/
  // clicking away does. In-memory only; refreshing the page resets to
  // the seed value.
  notes?: string;

  // Optional external brief doc. When set, the Creative Brief tab
  // shows a link to this URL instead of the inline textarea — used
  // when the canonical brief lives in Google Docs / Notion / etc.
  briefUrl?: string;

  // Optional supporting references displayed as a list of link cards
  // below the brief textarea. Use this when the show has its own
  // inline brief AND external docs worth linking to (notes from
  // contributors, visual guides, etc.).
  briefLinks?: Array<{ label: string; url: string }>;
}

export interface PlatformGroup {
  id: FormatGroup;
  label: string;
  platforms: Array<{
    name: string;
    // True when this platform consumes reposted content from other
    // platforms instead of (or in addition to) freshly produced content
    // for this group. Renders a refresh icon next to the platform name.
    isRepost?: boolean;
    // True when this platform is still being trialed. Renders at 70%
    // opacity on a second line in the column header.
    isExperimental?: boolean;
  }>;
  // Optional "first principles" brief for this format group, shown in
  // the drawer that opens when the user clicks the column header. Plain
  // text — rendered in a monospace block (matches the show briefs) so
  // structured headings and bullets line up. Leave undefined for groups
  // that don't have copy yet — the drawer shows a placeholder.
  firstPrinciples?: string;
}

// ---------------------------------------------------------------------------
// Source color palette.
//
// These are the four colors the spec calls out by name (Coral / Purple /
// Teal / Gray). They drive every visible accent on the matrix: the row's
// left bar, the filled Active pill's background, the Experiment pill's
// dashed border + text color.
//
// Why hex literals instead of CSS variables?
//   The dashboard's accent is terracotta (--terracotta = #ae5630). The
//   matrix uses a *different* palette deliberately — the whole point of this
//   redesign test is to evaluate the spec's color system in situ. We do NOT
//   unify these with --terracotta even though Coral (#D85A30) is visually
//   close; that would defeat the test.
// ---------------------------------------------------------------------------
export const SOURCE_COLORS: Record<Source, string> = {
  live: "#D85A30", // Coral
  event: "#7F77DD", // Purple
  dtc: "#1D9E75", // Teal
  words: "#888780", // Gray
};

// Darker variants. Reserved for a future light-mode build (where the
// Experiment pill's text would need a darker shade to stay legible on a
// pale background). Unused today because the dashboard is dark-only.
export const SOURCE_DARK_COLORS: Record<Source, string> = {
  live: "#993322",
  event: "#534AB7",
  dtc: "#0F6E56",
  words: "#5F5E5A",
};

// ---------------------------------------------------------------------------
// Source display labels (for the legend row).
// ---------------------------------------------------------------------------
export const SOURCE_LABELS: Record<Source, string> = {
  live: "Live",
  event: "Event",
  dtc: "DTC",
  words: "Words",
};

// ---------------------------------------------------------------------------
// Format-group display labels (used in the matrix column headers and the
// platform settings card). Kept separate from the FormatGroup union so we
// can change wording without touching every callsite.
// ---------------------------------------------------------------------------
export const FORMAT_GROUP_LABELS: Record<FormatGroup, string> = {
  long: "Long",
  mid: "Mid",
  short: "Short",
  written: "Written",
};

// Stable column order. We don't iterate Object.keys() because object key
// order is implementation-defined and we want a canonical source of truth
// for which group is the leftmost / rightmost column.
export const FORMAT_GROUP_ORDER: FormatGroup[] = [
  "long",
  "mid",
  "short",
  "written",
];

// Fixed Capture → Production → Distribution flow order for the drawer's
// Automation tab. The flowchart iterates this list to render section
// headers and the ↓ icons between adjacent sections.
export const STEP_CATEGORY_ORDER: StepCategory[] = [
  "capture",
  "production",
  "distribution",
];

export const STEP_CATEGORY_LABELS: Record<StepCategory, string> = {
  capture: "Capture",
  production: "Production",
  distribution: "Distribution",
};

// ---------------------------------------------------------------------------
// Seed shows.
//
// Spec order is preserved exactly. Every show declares all four
// FormatGroups in its `distribution`, even when the value is `none` — the
// Record type enforces this at compile time, and it makes the data shape
// dead obvious when reading the seed.
// ---------------------------------------------------------------------------
export const seedShows: Show[] = [
  {
    id: "scale-or-fail",
    name: "Scale or Fail",
    source: "live",
    distribution: {
      long: "active",
      mid: "none",
      short: "experiment",
      written: "none",
    },
    automation: [],
    briefUrl:
      "https://docs.google.com/document/d/1p-0rrn6prLtCPUewBAwPGG7ZgO1v9cym0S2edWCCt00/edit?usp=sharing",
  },
  {
    id: "hotline",
    name: "Hotline",
    source: "live",
    distribution: {
      long: "active",
      mid: "active",
      short: "experiment",
      written: "none",
    },
    // Owner + recent updatedAt seeded so the drawer subtitle shows
    // all three fields ("Source · Owner · Updated") on first open.
    // Other shows leave these undefined → subtitle renders em-dashes.
    owner: "Sam",
    updatedAt: "2026-05-12T17:00:00Z",
    // Example workflow from the spec. Each id is kebab-case + stable so
    // a future migration into the database doesn't need to rewrite refs.
    automation: [
      {
        id: "hotline-capture",
        category: "capture",
        title: "Live show recorded weekly",
        description: "Restream → S3 bucket · ~90 min raw",
      },
      {
        id: "hotline-production",
        category: "production",
        title: "Editor cuts three versions",
        description: "Frame.io brief · 48hr SLA · Owner: Sam",
      },
      {
        id: "hotline-dist-long",
        category: "distribution",
        group: "long",
        status: "active",
        title: "Full cut",
        description: "Posts to YouTube and podcast feeds",
      },
      {
        id: "hotline-dist-mid",
        category: "distribution",
        group: "mid",
        status: "active",
        title: "15-min highlight",
        description: "Posts to YT Highlights and X Secondary",
      },
      {
        id: "hotline-dist-short",
        category: "distribution",
        group: "short",
        status: "experiment",
        title: "Opus Clip auto-clips",
        description: "Posts to IG, TikTok, YT Shorts",
      },
    ],
    notes: `HIGH STAKES HOTLINE — On The Line / Fix My Business

[1] CASTING — Same criteria as Scale or Fail

    PERSON
    ☐ Compelling on camera
    ☐ Real stakes in their story
    ☐ Specific point of view
    ☐ Genuine, not rehearsed
    ☐ Doesn't dominate the room

    BUSINESS
    ☐ Recognizable category
    ☐ Concrete numbers to share
    ☐ At a real inflection point
    ☐ Decisions still ahead of them

[2] PRE PRODUCTION

    Gather the same intake info as Scale or Fail, condensed into
    an L3-style brief for Alex.

[3] PRODUCTION

    ☐ Guest opens with a virtual presentation phase (slides / numbers)
    ☐ Rest of the session is interactive with Alex

[4] POST PRODUCTION

    Minimal pass — no narrative re-edit.
    ☐ Transcript cut (filler, dead air, false starts)
    ☐ Cam switching (presenter / Alex / split)

[5] DISTRIBUTION

    ☐ Uploaded to YouTube`,
  },
  {
    id: "l1-qa",
    name: "L1 Q&A",
    source: "event",
    distribution: {
      long: "experiment",
      mid: "active",
      short: "active",
      written: "none",
    },
    automation: [],
    briefLinks: [
      {
        label: "Devin Notes",
        url: "https://docs.google.com/document/d/1CefvU4dpC8ChJH9mxPHWoCPKKGMGP4Zq9RaPKgBIXHA/edit?usp=sharing",
      },
      {
        label: "Oliver Notes",
        url: "https://www.notion.so/YT-Shorts-Content-Type-Outlines-1dbf6823298280af8f5ef8a7ed4210cd#2e8f68232982802cb1c6e80fa36f8c10",
      },
      {
        label: "Oliver Visual Guide",
        url: "https://www.notion.so/Alex-Q-A-SF-Visual-Guide-32ef6823298280c5a939c568cb906d36",
      },
    ],
    notes: `[1] CASTING — Would you take them to the club with you?

    PERSON
    ☐ Compelling on camera
    ☐ Real stakes in their story
    ☐ Specific point of view
    ☐ Genuine, not rehearsed
    ☐ Doesn't dominate the room

    BUSINESS
    ☐ Recognizable category
    ☐ Concrete numbers to share
    ☐ At a real inflection point
    ☐ Decisions still ahead of them

[2] CLIP SELECTION

    ☐ Guest selection was positive (see above)
    ☐ Broadly applicable (solution)
    ☐ Clear problem + payoff
    ☐ Strong hook (bars)

[3] EDITING

    ☐ HOOK — "business is X, revenue Y, goal Z; blocker A; question B"
    ☐ TENSION — establish immediately (stakes)
    ☐ PAYOFF — single payoff / problem; trim context to the minimum needed
    ☐ Title card — simple, concise, curiosity hook`,
  },
  {
    // Spec wrote "L3 Boardroomnt" — treated as a typo for "L3 Boardroom"
    // (matches the show name used elsewhere in the codebase).
    id: "l3-boardroom",
    name: "L3 Boardroom",
    source: "event",
    distribution: {
      long: "experiment",
      mid: "active",
      short: "experiment",
      written: "none",
    },
    automation: [],
    notes: `USES

    ☐ Pull concepts & tactics to become long form videos (10-1 rule)
    ☐ Pull soundbites to serve as tweets (using writing guide)`,
  },
  {
    id: "the-game",
    name: "The Game",
    source: "dtc",
    distribution: {
      long: "active",
      mid: "active",
      short: "none",
      written: "none",
    },
    automation: [],
    notes: `SOURCE OF IDEAS`,
  },
  {
    id: "podcasts",
    name: "Podcasts",
    source: "dtc",
    distribution: {
      long: "experiment",
      mid: "active",
      short: "none",
      written: "none",
    },
    automation: [],
  },
  {
    id: "ai-hotline",
    name: "AI Hotline",
    source: "dtc",
    distribution: {
      long: "none",
      mid: "none",
      short: "active",
      written: "none",
    },
    automation: [],
    notes: `1. Go to business-related forums on Reddit, e.g., r/smallbusiness, r/entrepreneur
2. Search top upvoted posts (all time, recent, etc.)
3. Look for posts with the following criteria:
   - High upvotes
   - Clear question
   - High TAM question
   - High stakes
   - Strong hook (title)
4. Trim down the post so it's more concise
5. Run it through ElevenLabs to generate voice (or use a voice changer)
6. Alex responds to the AI caller
7. Editing involves placing audio from the AI caller and Alex's response (cut down to make it more concise), then adding captions`,
  },
  {
    id: "tweets",
    name: "Tweets",
    source: "words",
    distribution: {
      long: "none",
      mid: "none",
      short: "experiment",
      written: "active",
    },
    automation: [],
  },
];

// ---------------------------------------------------------------------------
// Seed platform groups — drives the column-header platform list AND the
// platform-settings card below the matrix.
// ---------------------------------------------------------------------------
export const seedPlatformGroups: PlatformGroup[] = [
  {
    id: "long",
    label: "Long",
    platforms: [{ name: "YouTube" }, { name: "Podcasts" }],
    firstPrinciples: `FUTURE DIRECTION

    ☐ YouTube = TV
        ◦ https://www.youtube.com/watch?v=h69SwIn-bA4
        ◦ https://www.youtube.com/watch?v=rGmXQNZ2yBU`,
  },
  {
    id: "mid",
    label: "Mid",
    platforms: [{ name: "YouTube Highlights" }, { name: "X Secondary" }],
  },
  {
    id: "short",
    label: "Short",
    platforms: [
      { name: "IG" },
      { name: "TikTok", isRepost: true },
      { name: "YT Shorts", isRepost: true },
      { name: "Snapchat", isRepost: true, isExperimental: true },
      { name: "Pinterest", isExperimental: true },
      { name: "Reddit", isExperimental: true },
    ],
    firstPrinciples: `METRICS

    ☐ Cluster 1: Views + Likes + Reach + Shares
    ☐ Cluster 2: Follows + Saves
    ☐ Cluster 3: Comments

OTHER

    ☐ Carousels = followers, Reels = new
    ☐ IG: volume vs views not positively correlated (more volume = lower views per post, but potentially higher aggregate)

SECONDARY IG CHANNEL

    ☐ Second channel IG (high TAM)
    ☐ 6000 tweets in 6 months then repost
        ◦ Potentially AI voice to read out tweets
    ☐ Is a moat (Alex's writing)
    ☐ Fully automated (doesn't change much behaviour)
    ☐ Increase reach
    ☐ Increase beginner (view discrimination)
    ☐ Precision > volume (Ali Abdaal reduced relevance when he did too much)
    ☐ New follower to Skool
    ☐ Act as an umbrella brand
    ☐ Decrease risk with new name / collab / 2 hour automation

NEW FORMAT IDEAS

    ☐ Mozi 6
    ☐ Scaling Roadmap
    ☐ Horizontal Q&A with written hook on top
    ☐ Carousel static of Q&A`,
  },
  {
    id: "written",
    label: "Written",
    platforms: [
      { name: "X" },
      { name: "Threads", isRepost: true },
      { name: "YT Community" },
    ],
  },
];
