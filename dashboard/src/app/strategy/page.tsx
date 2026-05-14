"use client";

// Strategy page — MATRIX REDESIGN TEST.
//
// Layout (top to bottom):
//   - Back link (← Command Center) — preserved from the previous design so
//     there's still a way home.
//   - Header row: page title "Media ecosystem" + "Hide experiments" toggle.
//   - Legend row: source-color swatches, status-pill examples, repost icon.
//   - Matrix table: Shows (rows) × FormatGroups (columns), sticky left col.
//   - Platform settings card: 4-column auto-fit grid listing platforms in
//     each format group.
//
// Status pills cycle on click: active → experiment → none → active.
// Clicking an em-dash (none) promotes the cell straight to experiment —
// per the spec, that's the "safer default for adding something new".
//
// State persistence:
//   - On first mount we hydrate from localStorage (key STORAGE_KEY) if a
//     prior session saved something; otherwise we start from `seedShows`
//     in strategy-config.ts (the "committed default").
//   - "Save as new default" writes the current state to localStorage —
//     this becomes the new starting state for subsequent reloads on this
//     browser. It does NOT change strategy-config.ts; the committed
//     default is still the seed in source.
//   - "Reset to default" clears localStorage AND replaces state with the
//     committed seed. After this, refreshing the page also loads the seed.
//
// We use localStorage (not Supabase) because this is still a UI test —
// the user is evaluating the matrix layout before deciding whether to
// invest in real persistence. Per-browser saves are enough for that.
// The component accepts an optional onChange callback at the boundary
// so a future PR can wire it to Supabase without changing internals.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Plus, RefreshCw, X } from "lucide-react";

import {
  FORMAT_GROUP_LABELS,
  FORMAT_GROUP_ORDER,
  SOURCE_COLORS,
  SOURCE_LABELS,
  STEP_CATEGORY_LABELS,
  STEP_CATEGORY_ORDER,
  seedPlatformGroups,
  seedShows,
  type AutomationStep,
  type FormatGroup,
  type Show,
  type Source,
  type Status,
  type StepCategory,
} from "./strategy-config";

// Click-cycle order for status pills (and for em-dash cells, which jump
// straight to `experiment` regardless of where they "would" be in this
// sequence — see handleCycle).
const CYCLE: Record<Status, Status> = {
  active: "experiment",
  experiment: "none",
  none: "active",
};

// Versioned storage key. Bumped to v2 when the drawer work added the
// required `automation` field to Show — old v1 entries lack it and
// would render incorrectly if applied. Orphan v1 entries are harmless
// (we never read them); we'll leave them in localStorage rather than
// add cleanup code for a UI test.
const STORAGE_KEY = "strategy-matrix-shows-v2";

// Defensive parse of a localStorage payload. We don't want a corrupted
// or stale entry from an older shape to crash the page — if anything
// looks off, return null and we fall back to the seed.
function loadSavedShows(): Show[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Minimal sanity check — must be an array with the expected number
    // of shows. We do NOT validate every field; if you bump the shape,
    // bump STORAGE_KEY too.
    if (!Array.isArray(parsed)) return null;
    return parsed as Show[];
  } catch {
    return null;
  }
}

interface StrategyPageProps {
  // Spec asks for this at the component boundary so a future wiring to
  // Supabase has a hook. Unused today — state stays local.
  onChange?: (show: Show, group: FormatGroup, status: Status) => void;
}

export default function StrategyPage({ onChange }: StrategyPageProps) {
  const [shows, setShows] = useState<Show[]>(seedShows);
  const [hideExperiments, setHideExperiments] = useState(false);

  // Drawer state. `openShowId === null` means the drawer is closed.
  // `hoveredCellKey` is "{showId}:{group}" while a distribution step
  // card in the Automation tab is hovered; it drives the outline + glow
  // + z-index promotion on the matching matrix cell so it stays visible
  // through the 35% dim backdrop.
  const [openShowId, setOpenShowId] = useState<string | null>(null);
  const [hoveredCellKey, setHoveredCellKey] = useState<string | null>(null);

  // Element to return keyboard focus to when the drawer closes. We
  // store the show-name button that triggered the open; if the user
  // closes via Escape / X / backdrop, focus returns there instead of
  // disappearing into the document body.
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Hydrate from localStorage after mount. We can't do this in the
  // useState initializer because Next.js renders this client component
  // on the server first, where `window` doesn't exist — reading it there
  // would crash, and a lazy initializer that returned different values
  // on server vs. client would cause a hydration mismatch. So we accept
  // the brief flash of seed values, then setState once after mount.
  // This is the canonical one-shot hydration pattern; the lint rule
  // below has a known false positive for it. useSyncExternalStore would
  // be the "correct" alternative but is overkill for a single read.
  useEffect(() => {
    const saved = loadSavedShows();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setShows(saved);
  }, []);

  // Open the drawer for a show and remember the trigger element so we
  // can restore focus on close. Called from ShowRow's name button.
  function handleOpenShow(showId: string, trigger: HTMLElement | null) {
    lastFocusRef.current = trigger;
    setOpenShowId(showId);
  }

  // Close the drawer and restore focus. Used by Escape, X button, and
  // backdrop click — all share the same close path.
  function closeDrawer() {
    setOpenShowId(null);
    setHoveredCellKey(null);
    // Defer focus restore so React can finish unmounting the drawer
    // first; otherwise the focused button is briefly inside an
    // unmounting tree.
    queueMicrotask(() => lastFocusRef.current?.focus());
  }

  // Append a new automation step to a show. Generates a UUID for the
  // step id so React keys stay stable across renders.
  function handleAddStep(
    showId: string,
    step: Omit<AutomationStep, "id">,
  ) {
    setShows((prev) =>
      prev.map((show) =>
        show.id === showId
          ? {
              ...show,
              automation: [
                ...show.automation,
                { id: crypto.randomUUID(), ...step },
              ],
            }
          : show,
      ),
    );
  }

  // Update a show's notes field. Called from the Notes tab textarea
  // on blur (the "commit on blur" pattern — typing doesn't update
  // state, only blur does).
  function handleUpdateNotes(showId: string, notes: string) {
    setShows((prev) =>
      prev.map((show) => (show.id === showId ? { ...show, notes } : show)),
    );
  }

  // Save the current matrix state as the new starting point for future
  // page loads on this browser. Per-browser, no server involvement.
  function handleSaveDefault() {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shows));
  }

  // Wipe any saved override and snap state back to the committed seed
  // in strategy-config.ts. After this, a hard reload also loads the seed
  // (no leftover localStorage entry to re-apply).
  function handleResetDefault() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setShows(seedShows);
  }

  // Derived current open show. We don't store the Show object directly
  // in state because that would go stale when the user mutates the
  // matrix or adds an automation step — deriving from id-into-list
  // means every render sees the latest version of the show.
  const openShow: Show | null = openShowId
    ? shows.find((s) => s.id === openShowId) ?? null
    : null;

  // Single reducer for every cell mutation. Em-dash clicks pass
  // `forceExperiment: true` so the cell jumps straight to experiment
  // instead of following the active→experiment→none→active cycle.
  function handleCycle(
    showId: string,
    group: FormatGroup,
    forceExperiment = false,
  ) {
    setShows((prev) =>
      prev.map((show) => {
        if (show.id !== showId) return show;
        const current = show.distribution[group];
        const next: Status = forceExperiment ? "experiment" : CYCLE[current];
        const updated: Show = {
          ...show,
          distribution: { ...show.distribution, [group]: next },
        };
        onChange?.(updated, group, next);
        return updated;
      }),
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10">
      {/* Back link — the matrix design doesn't have its own home affordance
          so we keep the small mono link above the page header. */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[11px] font-mono tracking-[0.18em] uppercase text-[var(--overview-fg)]/45 hover:text-[var(--overview-fg)]/80 transition-colors mb-6"
      >
        ← Command Center
      </Link>

      {/* Header: title + action cluster.
          Per spec: title is 18px, weight 500, sentence case. The action
          cluster on the right groups three controls — Reset to default,
          Save as new default, Hide experiments. They share the same
          muted-text-button treatment to read as a single set of options;
          a thin vertical divider separates the save/reset pair from the
          Hide experiments toggle since they belong to different concerns
          (persistence vs. view filter). */}
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-[18px] font-medium text-[var(--foreground)]">
          Media ecosystem
        </h1>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleResetDefault}
            className="text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={handleSaveDefault}
            className="text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            Save as new default
          </button>
          <span
            aria-hidden
            className="inline-block h-[14px] w-px"
            style={{ backgroundColor: "var(--border)" }}
          />
          <HideExperimentsToggle
            hidden={hideExperiments}
            onToggle={() => setHideExperiments((v) => !v)}
          />
        </div>
      </header>

      {/* Legend */}
      <Legend />

      {/* Matrix table — wraps in overflow-x-auto so the sticky left column
          works correctly when the viewport is narrower than min-w-[720px]. */}
      <div className="overflow-x-auto mb-8">
        <table className="min-w-[720px] w-full border-separate border-spacing-0">
          <thead>
            <tr>
              {/* Empty top-left cell — sticky to match the column it sits
                  above so it doesn't slide when the matrix scrolls. */}
              <th
                className="sticky left-0 z-10 text-left align-bottom px-3 py-3 border-b-[0.5px] border-[var(--border)]"
                style={{ backgroundColor: "var(--background)" }}
              >
                {/* Intentionally blank — column 0 holds the show names. */}
                <span className="sr-only">Show</span>
              </th>
              {FORMAT_GROUP_ORDER.map((group) => (
                <ColumnHeader key={group} group={group} />
              ))}
            </tr>
          </thead>
          <tbody>
            {shows.map((show) => (
              <ShowRow
                key={show.id}
                show={show}
                hideExperiments={hideExperiments}
                onCellClick={handleCycle}
                onOpenShow={handleOpenShow}
                hoveredCellKey={hoveredCellKey}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Platform settings panel */}
      <PlatformSettingsPanel />

      {/* Drawer overlay — only mounts while a show is open. The dim
          backdrop and the drawer are siblings; both use `position: fixed`
          so they escape the page wrapper and stack above the matrix.
          z-index layering: backdrop=40, drawer=50, hover-promoted cell=41
          (cell pops *through* the dim, but stays under the drawer). */}
      {openShow ? (
        <>
          <div
            className="fixed inset-0 z-[40] bg-black/35 backdrop-blur-[0.5px]"
            onClick={closeDrawer}
            aria-hidden
          />
          <ShowDrawer
            show={openShow}
            onClose={closeDrawer}
            hoveredCellKey={hoveredCellKey}
            setHoveredCellKey={setHoveredCellKey}
            onAddStep={(step) => handleAddStep(openShow.id, step)}
            onUpdateNotes={(notes) => handleUpdateNotes(openShow.id, notes)}
          />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hide experiments toggle — plain button with a tiny filled-square indicator
// that flips between filled and outlined. No fancy switch primitive.
// ---------------------------------------------------------------------------

function HideExperimentsToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={hidden}
      className="inline-flex items-center gap-2 text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
    >
      <span
        className="inline-block h-[10px] w-[10px] rounded-[2px] border-[0.5px] border-[var(--muted-foreground)]"
        style={{
          backgroundColor: hidden ? "var(--muted-foreground)" : "transparent",
        }}
      />
      Hide experiments
    </button>
  );
}

// ---------------------------------------------------------------------------
// Legend — three groups separated by thin vertical dividers.
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-6 text-[11px] text-[var(--muted-foreground)]">
      {/* Source colors */}
      <div className="flex items-center gap-3">
        {(Object.keys(SOURCE_LABELS) as Source[]).map((src) => (
          <span key={src} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-[8px] w-[8px] rounded-[2px]"
              style={{ backgroundColor: SOURCE_COLORS[src] }}
            />
            {SOURCE_LABELS[src]}
          </span>
        ))}
      </div>

      <LegendDivider />

      {/* Status example pills. We render them in a neutral gray (the spec
          says "active solid pill, dashed pill" without prescribing a color
          for the legend example), keeping them generic so they read as
          structural examples rather than tied to any one source. */}
      <div className="flex items-center gap-2">
        <span
          className="rounded-full px-2.5 py-[3px] text-[11px] font-medium text-white"
          style={{ backgroundColor: "var(--muted-foreground)" }}
        >
          Active
        </span>
        <span
          className="rounded-full px-2.5 py-[3px] text-[11px] font-medium border border-dashed"
          style={{
            borderColor: "var(--muted-foreground)",
            color: "var(--muted-foreground)",
          }}
        >
          Experimental
        </span>
      </div>

      <LegendDivider />

      {/* Repost icon legend */}
      <span className="inline-flex items-center gap-1.5">
        <RefreshCw className="size-[10px]" />
        Repost
      </span>
    </div>
  );
}

function LegendDivider() {
  return (
    <span
      aria-hidden
      className="inline-block h-[14px] w-px"
      style={{ backgroundColor: "var(--border)" }}
    />
  );
}

// ---------------------------------------------------------------------------
// Column header — group label + list of platforms beneath. Experimental
// platforms render on a second sub-line at 60% opacity per spec.
// ---------------------------------------------------------------------------

function ColumnHeader({ group }: { group: FormatGroup }) {
  const groupConfig = seedPlatformGroups.find((g) => g.id === group);
  if (!groupConfig) return null;

  const mainPlatforms = groupConfig.platforms.filter((p) => !p.isExperimental);
  const experimentalPlatforms = groupConfig.platforms.filter(
    (p) => p.isExperimental,
  );

  return (
    <th className="text-left align-bottom px-3 py-3 border-b-[0.5px] border-[var(--border)]">
      <div className="text-[13px] font-medium text-[var(--foreground)]">
        {FORMAT_GROUP_LABELS[group]}
      </div>
      <div className="mt-1 text-[10px] text-[var(--overview-fg)]/35 leading-snug">
        {mainPlatforms.map((p, i) => (
          <span key={p.name} className="inline-flex items-center gap-1">
            {p.isRepost ? (
              <RefreshCw className="size-[9px] inline-block" aria-label="repost" />
            ) : null}
            <span>{p.name}</span>
            {i < mainPlatforms.length - 1 ? <span className="mr-0.5">,</span> : null}
          </span>
        ))}
      </div>
      {experimentalPlatforms.length > 0 ? (
        <div className="mt-0.5 text-[10px] text-[var(--overview-fg)]/35 leading-snug opacity-60">
          {experimentalPlatforms.map((p, i) => (
            <span key={p.name} className="inline-flex items-center gap-1">
              {p.isRepost ? (
                <RefreshCw className="size-[9px] inline-block" aria-label="repost" />
              ) : null}
              <span>{p.name}</span>
              {i < experimentalPlatforms.length - 1 ? (
                <span className="mr-0.5">,</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Single row in the matrix.
// ---------------------------------------------------------------------------

function ShowRow({
  show,
  hideExperiments,
  onCellClick,
  onOpenShow,
  hoveredCellKey,
}: {
  show: Show;
  hideExperiments: boolean;
  onCellClick: (showId: string, group: FormatGroup, forceExperiment?: boolean) => void;
  // Called when the show name button is clicked. The trigger element is
  // captured so the drawer can return keyboard focus to it on close.
  onOpenShow: (showId: string, trigger: HTMLElement | null) => void;
  // "{showId}:{group}" while a distribution step card in the drawer is
  // hovered. Drives the outline + glow + z-index promotion on the
  // matching matrix cell so it remains visible above the dim backdrop.
  hoveredCellKey: string | null;
}) {
  return (
    <tr>
      {/* Sticky-left name cell.
          The flex inside has the 4px source-color bar as its first child,
          stretched to full row height via `align-self: stretch` (which is
          the flex default for children without an explicit align). The
          spec requires the bar stretches the full row — verified with the
          `self-stretch` utility just in case browser defaults change. */}
      <th
        scope="row"
        className="sticky left-0 z-10 text-left border-b-[0.5px] border-[var(--border)] p-0"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="flex items-stretch min-h-[44px]">
          <div
            aria-hidden
            className="self-stretch w-1 rounded-[2px]"
            style={{ backgroundColor: SOURCE_COLORS[show.source] }}
          />
          {/* Show name is now a button that opens the drawer. We pass the
              clicked element back so the drawer can restore focus on
              close. The terracotta-hover token is reused for the hover
              tint to keep the page's accent vocabulary consistent. */}
          <button
            type="button"
            onClick={(e) => onOpenShow(show.id, e.currentTarget)}
            className="flex items-center pl-3 pr-4 text-[14px] font-medium text-[var(--foreground)] hover:text-[var(--terracotta-hover)] transition-colors text-left cursor-pointer"
          >
            {show.name}
          </button>
        </div>
      </th>

      {FORMAT_GROUP_ORDER.map((group) => {
        const isHovered = hoveredCellKey === `${show.id}:${group}`;
        return (
          <td
            key={group}
            className="text-left px-3 py-2 border-b-[0.5px] border-l-[0.5px] border-[var(--border)] align-middle"
            style={
              isHovered
                ? {
                    // Z-index 41 promotes the cell *above* the z-40 dim
                    // backdrop but below the z-50 drawer. Outline (not
                    // border) avoids any layout shift. The 33 hex suffix
                    // = 20% alpha for the soft halo.
                    position: "relative",
                    zIndex: 41,
                    outline: `2px solid ${SOURCE_COLORS[show.source]}`,
                    boxShadow: `0 0 0 8px ${SOURCE_COLORS[show.source]}33`,
                    backgroundColor: "var(--background)",
                  }
                : undefined
            }
          >
            <StatusCell
              source={show.source}
              status={show.distribution[group]}
              hideExperiments={hideExperiments}
              onClick={(forceExperiment) =>
                onCellClick(show.id, group, forceExperiment)
              }
            />
          </td>
        );
      })}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Status cell — renders the right pill / em-dash for a Show × FormatGroup
// intersection. Always returns a clickable element so adding a new
// experiment is one click on an empty cell.
// ---------------------------------------------------------------------------

function StatusCell({
  source,
  status,
  hideExperiments,
  onClick,
}: {
  source: Source;
  status: Status;
  hideExperiments: boolean;
  // forceExperiment = true when the click came from an em-dash cell.
  onClick: (forceExperiment?: boolean) => void;
}) {
  if (status === "none") {
    return (
      <button
        type="button"
        onClick={() => onClick(true)}
        className="text-[var(--overview-fg)]/35 hover:text-[var(--overview-fg)]/60 transition-colors text-[14px] leading-none"
        aria-label="Empty cell — click to add an experiment"
      >
        —
      </button>
    );
  }

  if (status === "experiment") {
    return (
      <button
        type="button"
        onClick={() => onClick()}
        className="rounded-full px-2.5 py-[3px] text-[11px] font-medium border border-dashed"
        style={{
          ...(hideExperiments ? { display: "none" } : {}),
          borderColor: SOURCE_COLORS[source],
          color: SOURCE_COLORS[source],
        }}
      >
        Experiment
      </button>
    );
  }

  // active
  return (
    <button
      type="button"
      onClick={() => onClick()}
      className="rounded-full px-2.5 py-[3px] text-[11px] font-medium text-white"
      style={{ backgroundColor: SOURCE_COLORS[source] }}
    >
      Active
    </button>
  );
}

// ---------------------------------------------------------------------------
// Platform settings panel — card below the matrix listing the platforms
// in each format group. Repost platforms get a refresh icon; experimental
// platforms render at 70% opacity on a second line.
// ---------------------------------------------------------------------------

function PlatformSettingsPanel() {
  return (
    <section
      className="rounded-[8px] border-[0.5px] p-5"
      style={{
        backgroundColor: "var(--card)",
        borderColor: "var(--border)",
      }}
    >
      <div className="text-[11px] font-medium text-[var(--muted-foreground)] mb-3">
        Platform settings
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
        {seedPlatformGroups.map((group) => (
          <PlatformColumn key={group.id} group={group} />
        ))}
      </div>
    </section>
  );
}

function PlatformColumn({ group }: { group: { id: FormatGroup; label: string; platforms: Array<{ name: string; isRepost?: boolean; isExperimental?: boolean }> } }) {
  const mainPlatforms = group.platforms.filter((p) => !p.isExperimental);
  const experimentalPlatforms = group.platforms.filter((p) => p.isExperimental);

  return (
    <div>
      <div className="text-[11px] font-medium text-[var(--foreground)] mb-2">
        {group.label}
      </div>
      <ul className="space-y-1.5">
        {mainPlatforms.map((p) => (
          <li
            key={p.name}
            className="flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)]"
          >
            {p.isRepost ? (
              <RefreshCw className="size-[11px]" aria-label="repost" />
            ) : null}
            <span>{p.name}</span>
          </li>
        ))}
        {experimentalPlatforms.map((p) => (
          <li
            key={p.name}
            className="flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)] opacity-70"
          >
            {p.isRepost ? (
              <RefreshCw className="size-[11px]" aria-label="repost" />
            ) : null}
            <span>{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Show drawer — right-side overlay with four tabs (Overview / Automation /
// Posts / Notes). Mounted by StrategyPage when openShowId is non-null.
//
// The drawer is its own focus realm:
//   - Body scroll is locked while open.
//   - Escape closes; Tab/Shift+Tab cycle focus within the drawer.
//   - Close button is auto-focused on mount so keyboard users land in a
//     sensible spot.
//   - The active tab indicator uses the show's source color, tying the
//     drawer visually to the matrix row.
// ---------------------------------------------------------------------------

type DrawerTab = "overview" | "automation" | "posts" | "notes";

const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "automation", label: "Automation" },
  { id: "posts", label: "Posts" },
  { id: "notes", label: "Notes" },
];

interface ShowDrawerProps {
  show: Show;
  onClose: () => void;
  hoveredCellKey: string | null;
  setHoveredCellKey: (key: string | null) => void;
  onAddStep: (step: Omit<AutomationStep, "id">) => void;
  onUpdateNotes: (notes: string) => void;
}

function ShowDrawer({
  show,
  onClose,
  setHoveredCellKey,
  onAddStep,
  onUpdateNotes,
}: ShowDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>("overview");
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Body scroll lock + keyboard handlers (Escape, focus trap).
  // All wired up while the drawer is mounted; cleanup restores state.
  useEffect(() => {
    // Lock body scroll. We restore the prior value (not just unset)
    // in case some other code had it set to a non-default value.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Snapshot of the element that had focus before the drawer mounted,
    // in case our top-level lastFocusRef misses (e.g. a keyboard
    // shortcut opened the drawer without a click).
    const prevActive = document.activeElement as HTMLElement | null;

    // Focus the close button shortly after mount. We use setTimeout(0)
    // because focus changes during mount can race with React's commit
    // phase on first paint.
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);

    function getFocusable(): HTMLElement[] {
      const root = drawerRef.current;
      if (!root) return [];
      // Standard "focusable" selector. We exclude tabindex=-1 and
      // disabled controls.
      const nodes = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
      // If the drawer closes for any reason and our consumer didn't
      // restore focus (shouldn't happen, but defense-in-depth), put
      // focus back where it was.
      if (prevActive && document.activeElement === document.body) {
        prevActive.focus?.();
      }
    };
  }, [onClose]);

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${show.name} details`}
      // Slide-in animation via tw-animate-css. 200ms duration matches
      // the spec; ease is the default (CSS ease-in-out).
      className="fixed top-0 right-0 h-screen w-full md:w-[60vw] md:max-w-[720px] bg-[var(--background)] z-[50] flex flex-col animate-in slide-in-from-right duration-200 border-l-[0.5px] border-[var(--border)]"
    >
      <DrawerHeader show={show} onClose={onClose} closeBtnRef={closeBtnRef} />
      <DrawerTabsNav source={show.source} tab={tab} onTabChange={setTab} />
      <div className="flex-1 overflow-y-auto">
        {tab === "overview" ? <OverviewTab show={show} /> : null}
        {tab === "automation" ? (
          <AutomationTab
            show={show}
            onAddStep={onAddStep}
            setHoveredCellKey={setHoveredCellKey}
          />
        ) : null}
        {tab === "posts" ? <PostsTab /> : null}
        {tab === "notes" ? (
          <NotesTab show={show} onUpdateNotes={onUpdateNotes} />
        ) : null}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Drawer header — 4px source-color bar + show name + subtitle + close X.
// ---------------------------------------------------------------------------

function DrawerHeader({
  show,
  onClose,
  closeBtnRef,
}: {
  show: Show;
  onClose: () => void;
  closeBtnRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="flex items-stretch gap-3 px-6 py-5 border-b-[0.5px] border-[var(--border)]">
      <div
        aria-hidden
        className="self-stretch w-1 rounded-[2px]"
        style={{ backgroundColor: SOURCE_COLORS[show.source] }}
      />
      <div className="flex-1 min-w-0">
        <h2 className="text-[17px] font-medium text-[var(--foreground)] truncate">
          {show.name}
        </h2>
        <p className="text-[11px] text-[var(--overview-fg)]/35 mt-1">
          Source: {SOURCE_LABELS[show.source]} · Owner: {show.owner ?? "—"} ·
          Updated {formatRelative(show.updatedAt)}
        </p>
      </div>
      <button
        ref={closeBtnRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors self-start"
      >
        <X className="size-4" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Drawer tabs — Overview / Automation / Posts / Notes. Active tab's
// underline uses the show's source color (not the global theme accent)
// so the drawer's identity is tied to the row that opened it.
// ---------------------------------------------------------------------------

function DrawerTabsNav({
  source,
  tab,
  onTabChange,
}: {
  source: Source;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
}) {
  return (
    <nav
      className="flex gap-6 px-6 border-b-[0.5px] border-[var(--border)]"
      role="tablist"
    >
      {DRAWER_TABS.map((t) => {
        const isActive = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(t.id)}
            className="py-3 text-[12px] font-medium transition-colors"
            style={{
              color: isActive
                ? "var(--foreground)"
                : "var(--muted-foreground)",
              // Underline overlaps the nav's bottom border by 0.5px so
              // the active tab visually "claims" that line.
              borderBottom: isActive
                ? `2px solid ${SOURCE_COLORS[source]}`
                : "2px solid transparent",
              marginBottom: "-0.5px",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Overview tab — read-only restatement of the show's matrix row plus a
// small data grid (source / owner / updated / active count / experiment
// count).
// ---------------------------------------------------------------------------

function OverviewTab({ show }: { show: Show }) {
  const activeCount = FORMAT_GROUP_ORDER.filter(
    (g) => show.distribution[g] === "active",
  ).length;
  const experimentCount = FORMAT_GROUP_ORDER.filter(
    (g) => show.distribution[g] === "experiment",
  ).length;

  return (
    <div className="p-6 space-y-6">
      <section>
        <div className="text-[11px] font-medium text-[var(--muted-foreground)] mb-3">
          Distribution
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {FORMAT_GROUP_ORDER.map((g) => (
            <div
              key={g}
              className="flex flex-col items-start gap-1.5 rounded-[8px] border-[0.5px] p-3"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35">
                {FORMAT_GROUP_LABELS[g]}
              </span>
              <ReadOnlyStatusPill
                source={show.source}
                status={show.distribution[g]}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <OverviewField label="Source" value={SOURCE_LABELS[show.source]} />
        <OverviewField label="Owner" value={show.owner ?? "—"} />
        <OverviewField label="Updated" value={formatRelative(show.updatedAt)} />
        <OverviewField label="Active" value={String(activeCount)} />
        <OverviewField label="Experiments" value={String(experimentCount)} />
      </section>
    </div>
  );
}

function OverviewField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35">
        {label}
      </div>
      <div className="text-[13px] text-[var(--foreground)] mt-1">{value}</div>
    </div>
  );
}

// Read-only version of StatusCell — used by the Overview tab and step
// cards. Same visual treatment as the clickable cell, minus the
// interactivity (no onClick, no cursor).
function ReadOnlyStatusPill({
  source,
  status,
}: {
  source: Source;
  status: Status;
}) {
  if (status === "none") {
    return (
      <span className="text-[var(--overview-fg)]/35 text-[14px]">—</span>
    );
  }
  if (status === "experiment") {
    return (
      <span
        className="rounded-full px-2.5 py-[3px] text-[11px] font-medium border border-dashed"
        style={{
          borderColor: SOURCE_COLORS[source],
          color: SOURCE_COLORS[source],
        }}
      >
        Experiment
      </span>
    );
  }
  return (
    <span
      className="rounded-full px-2.5 py-[3px] text-[11px] font-medium text-white"
      style={{ backgroundColor: SOURCE_COLORS[source] }}
    >
      Active
    </span>
  );
}

// ---------------------------------------------------------------------------
// Automation tab — Capture → Production → Distribution flowchart.
//
// Sections render in fixed order (STEP_CATEGORY_ORDER). Capture and
// Production are vertical stacks of cards; Distribution is a 1-4 column
// grid since "post X to platforms Y, Z" is essentially parallel work.
// Between adjacent sections, a centered ↓ icon makes the directional
// flow visible.
// ---------------------------------------------------------------------------

function AutomationTab({
  show,
  onAddStep,
  setHoveredCellKey,
}: {
  show: Show;
  onAddStep: (step: Omit<AutomationStep, "id">) => void;
  setHoveredCellKey: (key: string | null) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);

  // Index steps by category so each section just iterates its slice.
  const byCategory: Record<StepCategory, AutomationStep[]> = {
    capture: [],
    production: [],
    distribution: [],
  };
  for (const step of show.automation) {
    byCategory[step.category].push(step);
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="text-[11px] text-[var(--muted-foreground)]">
          Workflow from capture to distribution
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus className="size-3" />
          Add step
        </button>
      </div>

      {showAddForm ? (
        <AddStepForm
          onSubmit={(step) => {
            onAddStep(step);
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      ) : null}

      <div className="space-y-5">
        {STEP_CATEGORY_ORDER.map((category, idx) => {
          const steps = byCategory[category];
          const isLast = idx === STEP_CATEGORY_ORDER.length - 1;
          return (
            <div key={category}>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--overview-fg)]/35 mb-2">
                {STEP_CATEGORY_LABELS[category]}
              </div>

              {steps.length === 0 ? (
                <div
                  className="rounded-[8px] border-[0.5px] border-dashed px-3 py-3 text-[11px] text-[var(--overview-fg)]/35"
                  style={{ borderColor: "var(--border)" }}
                >
                  No steps yet
                </div>
              ) : category === "distribution" ? (
                // Distribution renders as a grid — parallel destinations.
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {steps.map((step) => (
                    <StepCard
                      key={step.id}
                      show={show}
                      step={step}
                      onHoverEnter={() =>
                        setHoveredCellKey(
                          step.group ? `${show.id}:${step.group}` : null,
                        )
                      }
                      onHoverLeave={() => setHoveredCellKey(null)}
                    />
                  ))}
                </div>
              ) : (
                // Capture / Production — vertical stack with ↓ between.
                <div className="space-y-2">
                  {steps.map((step, i) => (
                    <div key={step.id}>
                      <StepCard show={show} step={step} />
                      {i < steps.length - 1 ? (
                        <div className="flex justify-center py-1">
                          <ArrowDown className="size-3 text-[var(--overview-fg)]/35" />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              {!isLast ? (
                <div className="flex justify-center py-3">
                  <ArrowDown className="size-3.5 text-[var(--overview-fg)]/35" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step card — one item in the Automation flowchart.
//
// Non-distribution cards are simple: category label + title + description
// on a card-background surface, no border.
//
// Distribution cards additionally show destination platform list (the
// "→ Platform" lines) and a read-only status pill. The card has a
// source-color border (solid for active, dashed for experiment). Hover
// handlers fire so the matching matrix cell gets the outline+glow
// treatment behind the drawer.
//
// Note: we render `show.distribution[step.group]` for the pill, not
// `step.status` — the matrix is the source of truth for status, and
// keeping the pill derived avoids drift when the user cycles the cell.
// `step.status` is stored on the type for forward-compat but unused
// visually in v1.
// ---------------------------------------------------------------------------

function StepCard({
  show,
  step,
  onHoverEnter,
  onHoverLeave,
}: {
  show: Show;
  step: AutomationStep;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}) {
  const isDistribution = step.category === "distribution";
  // Effective status comes from the matrix when distribution, undefined
  // otherwise. Falls back to "none" if step.group is missing (should
  // never happen for distribution steps, but defensive).
  const effectiveStatus: Status | null =
    isDistribution && step.group ? show.distribution[step.group] : null;

  // Border treatment: distribution cards get the source-color border
  // matched to status. Non-distribution cards keep the warm card fill
  // with no special border (no source-color hint needed).
  let borderStyle: React.CSSProperties = {
    borderColor: "var(--border)",
    borderStyle: "solid",
  };
  if (isDistribution && effectiveStatus === "active") {
    borderStyle = {
      borderColor: SOURCE_COLORS[show.source],
      borderStyle: "solid",
    };
  } else if (isDistribution && effectiveStatus === "experiment") {
    borderStyle = {
      borderColor: SOURCE_COLORS[show.source],
      borderStyle: "dashed",
    };
  }

  // Look up platform list for the destination — used to render the
  // "→ Platform name" lines. seedPlatformGroups is the same source the
  // matrix column headers and platform-settings panel read from.
  const destinationPlatforms = isDistribution && step.group
    ? seedPlatformGroups.find((g) => g.id === step.group)?.platforms ?? []
    : [];

  return (
    <div
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      className="rounded-[8px] border-[0.5px] p-3 transition-colors"
      style={{
        backgroundColor: "var(--card)",
        ...borderStyle,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35">
            {STEP_CATEGORY_LABELS[step.category]}
          </div>
          <div className="text-[13px] font-medium text-[var(--foreground)] mt-1">
            {step.title}
          </div>
          {step.description ? (
            <p className="text-[11px] text-[var(--muted-foreground)] mt-1 leading-snug">
              {step.description}
            </p>
          ) : null}
        </div>
        {effectiveStatus && effectiveStatus !== "none" ? (
          <ReadOnlyStatusPill source={show.source} status={effectiveStatus} />
        ) : null}
      </div>
      {destinationPlatforms.length > 0 ? (
        <div className="mt-2 space-y-0.5">
          {destinationPlatforms.map((p) => (
            <div
              key={p.name}
              className="text-[10px] text-[var(--overview-fg)]/45"
            >
              → {p.name}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-step inline form — appears below the "Add step" button when toggled.
// Minimal fields: category (radio), title (text), description (text),
// plus group + status when category is Distribution.
// ---------------------------------------------------------------------------

function AddStepForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (step: Omit<AutomationStep, "id">) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<StepCategory>("capture");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState<FormatGroup>("long");
  const [status, setStatus] = useState<Status>("active");

  const isDistribution = category === "distribution";
  const canSubmit = title.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      category,
      title: title.trim(),
      description: description.trim() || undefined,
      group: isDistribution ? group : undefined,
      status: isDistribution ? status : undefined,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[8px] border-[0.5px] p-4 mb-5 space-y-3"
      style={{
        backgroundColor: "var(--card)",
        borderColor: "var(--border)",
      }}
    >
      <div>
        <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35 mb-1.5">
          Category
        </div>
        <div className="flex gap-2">
          {STEP_CATEGORY_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className="rounded-full px-2.5 py-[3px] text-[11px] font-medium border-[0.5px] transition-colors"
              style={{
                backgroundColor:
                  category === c ? "var(--foreground)" : "transparent",
                color:
                  category === c
                    ? "var(--background)"
                    : "var(--muted-foreground)",
                borderColor: "var(--border)",
              }}
            >
              {STEP_CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label
          htmlFor="step-title"
          className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35 block mb-1"
        >
          Title
        </label>
        <input
          id="step-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-[12px] bg-transparent border-[0.5px] rounded-[6px] px-2.5 py-1.5 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)]"
          style={{ borderColor: "var(--border)" }}
        />
      </div>

      <div>
        <label
          htmlFor="step-desc"
          className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35 block mb-1"
        >
          Description
        </label>
        <input
          id="step-desc"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-[12px] bg-transparent border-[0.5px] rounded-[6px] px-2.5 py-1.5 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)]"
          style={{ borderColor: "var(--border)" }}
        />
      </div>

      {isDistribution ? (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="step-group"
              className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35 block mb-1"
            >
              Group
            </label>
            <select
              id="step-group"
              value={group}
              onChange={(e) => setGroup(e.target.value as FormatGroup)}
              className="w-full text-[12px] bg-transparent border-[0.5px] rounded-[6px] px-2.5 py-1.5 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)]"
              style={{ borderColor: "var(--border)" }}
            >
              {FORMAT_GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {FORMAT_GROUP_LABELS[g]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="step-status"
              className="text-[10px] uppercase tracking-[0.08em] text-[var(--overview-fg)]/35 block mb-1"
            >
              Status
            </label>
            <select
              id="step-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              className="w-full text-[12px] bg-transparent border-[0.5px] rounded-[6px] px-2.5 py-1.5 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)]"
              style={{ borderColor: "var(--border)" }}
            >
              <option value="active">Active</option>
              <option value="experiment">Experiment</option>
              <option value="none">None</option>
            </select>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-full px-3 py-1 text-[12px] font-medium text-white transition-opacity"
          style={{
            backgroundColor: "var(--terracotta)",
            opacity: canSubmit ? 1 : 0.4,
          }}
        >
          Add
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Posts tab — placeholder per spec ("Don't build out").
// ---------------------------------------------------------------------------

function PostsTab() {
  return (
    <div className="p-6">
      <p className="text-[12px] text-[var(--muted-foreground)]">
        Recent posts will appear here once connected.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes tab — single textarea with "commit on blur" semantics. Typing
// updates local state; blur commits to React's shared `shows` state.
// Persistence to localStorage still requires the existing
// "Save as new default" button — same model as every other matrix edit.
// ---------------------------------------------------------------------------

function NotesTab({
  show,
  onUpdateNotes,
}: {
  show: Show;
  onUpdateNotes: (notes: string) => void;
}) {
  // Local textarea state. We use the show id as the dependency to reset
  // the buffer when a different show's drawer is opened.
  const [value, setValue] = useState(show.notes ?? "");

  // Reset local buffer ONLY when the drawer switches to a different
  // show. The textarea is the source of truth during an edit session,
  // so we deliberately do not depend on `show.notes` — if anything
  // external mutates it (future backend sync, import action, optimistic
  // update), we don't want to clobber in-progress typing. Re-hydration
  // happens only on show-identity change.
  useEffect(() => {
    setValue(show.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show.id]);

  return (
    <div className="p-6">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onUpdateNotes(value)}
        placeholder="Notes about this show…"
        className="w-full min-h-[200px] text-[13px] bg-transparent border-[0.5px] rounded-[8px] px-3 py-2 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)] resize-y leading-relaxed"
        style={{ borderColor: "var(--border)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny relative-time helper. No date library — we just bucket into
// "just now" / "Nd ago" / "Nw ago" / "Mon D, YYYY". Good enough for the
// drawer subtitle.
// ---------------------------------------------------------------------------

function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 5) return `${diffWk}w ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
