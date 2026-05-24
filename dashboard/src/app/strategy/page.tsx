"use client";

// Strategy page — MATRIX REDESIGN TEST.
//
// Layout (top to bottom):
//   - Back link (← Command Center) — preserved from the previous design so
//     there's still a way home.
//   - Header row: page title "Media ecosystem".
//   - Legend row: source-color swatches, status-pill examples, repost icon.
//   - Matrix table: Shows (rows) × FormatGroups (columns), sticky left col.
//   - Platform settings card: 4-column auto-fit grid listing platforms in
//     each format group.
//
// Status pills are read-only — the matrix shows distribution state from
// the seed in strategy-config.ts. Clicking a show name opens the drawer.

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ExternalLink, Plus, RefreshCw, X } from "lucide-react";

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
  type PlatformGroup,
  type Show,
  type Source,
  type Status,
  type StepCategory,
} from "./strategy-config";

export default function StrategyPage() {
  const [shows, setShows] = useState<Show[]>(seedShows);

  // Drawer state. The page has two mutually-exclusive drawers:
  //   - openShowId: opened by clicking a show name (left column).
  //   - openGroupId: opened by clicking a format-group column header.
  // We track them as separate ids (rather than a tagged union) because
  // each drawer renders distinct components and props — keeping the
  // state shape flat avoids a useReducer/discriminated-union helper
  // when two booleans-by-proxy do the job.
  // `hoveredCellKey` is "{showId}:{group}" while a distribution step
  // card in the Automation tab is hovered; it drives the outline + glow
  // + z-index promotion on the matching matrix cell so it stays visible
  // through the 35% dim backdrop.
  const [openShowId, setOpenShowId] = useState<string | null>(null);
  const [openGroupId, setOpenGroupId] = useState<FormatGroup | null>(null);
  const [hoveredCellKey, setHoveredCellKey] = useState<string | null>(null);

  // Element to return keyboard focus to when the drawer closes. Shared
  // between the show drawer and the group drawer — only one is ever
  // open at a time, so a single ref is enough. If the user closes via
  // Escape / X / backdrop, focus returns to the triggering header/name
  // button instead of disappearing into the document body.
  const lastFocusRef = useRef<HTMLElement | null>(null);

  // Open the show drawer and remember the trigger element so we can
  // restore focus on close. Closes the group drawer if it was open so
  // the two are mutually exclusive (they share the backdrop + lock).
  function handleOpenShow(showId: string, trigger: HTMLElement | null) {
    lastFocusRef.current = trigger;
    setOpenGroupId(null);
    setOpenShowId(showId);
  }

  // Mirror of handleOpenShow for the column-header drawer. Mutually
  // exclusive with the show drawer for the same reasons.
  function handleOpenGroup(
    groupId: FormatGroup,
    trigger: HTMLElement | null,
  ) {
    lastFocusRef.current = trigger;
    setOpenShowId(null);
    setOpenGroupId(groupId);
  }

  // Close whichever drawer is open and restore focus. Used by Escape,
  // X button, and backdrop click — all share the same close path.
  function closeDrawer() {
    setOpenShowId(null);
    setOpenGroupId(null);
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

  // Derived current open show. We don't store the Show object directly
  // in state because that would go stale when the user mutates an
  // automation step — deriving from id-into-list means every render
  // sees the latest version of the show.
  const openShow: Show | null = openShowId
    ? shows.find((s) => s.id === openShowId) ?? null
    : null;

  // Same derivation for the format-group drawer. Groups are static
  // (seedPlatformGroups), so this is a simple lookup, but we keep the
  // pattern symmetric with openShow for clarity.
  const openGroup: PlatformGroup | null = openGroupId
    ? seedPlatformGroups.find((g) => g.id === openGroupId) ?? null
    : null;

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

      {/* Header: page title only.
          Per spec: title is 18px, weight 500, sentence case. */}
      <header className="mb-5">
        <h1 className="text-[18px] font-medium text-[var(--foreground)]">
          Media ecosystem
        </h1>
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
                <ColumnHeader
                  key={group}
                  group={group}
                  onOpenGroup={handleOpenGroup}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {shows.map((show) => (
              <ShowRow
                key={show.id}
                show={show}
                onOpenShow={handleOpenShow}
                hoveredCellKey={hoveredCellKey}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Platform settings panel */}
      <PlatformSettingsPanel />

      {/* Drawer overlay — only mounts while a show OR group is open.
          The dim backdrop and the drawer are siblings; both use
          `position: fixed` so they escape the page wrapper and stack
          above the matrix. z-index layering: backdrop=40, drawer=50,
          hover-promoted cell=41 (cell pops *through* the dim, but
          stays under the drawer). Show and group drawers are mutually
          exclusive (enforced in handleOpenShow / handleOpenGroup), so
          we only ever render one. */}
      {openShow || openGroup ? (
        <div
          className="fixed inset-0 z-[40] bg-black/35 backdrop-blur-[0.5px]"
          onClick={closeDrawer}
          aria-hidden
        />
      ) : null}
      {openShow ? (
        <ShowDrawer
          show={openShow}
          onClose={closeDrawer}
          hoveredCellKey={hoveredCellKey}
          setHoveredCellKey={setHoveredCellKey}
          onAddStep={(step) => handleAddStep(openShow.id, step)}
          onUpdateNotes={(notes) => handleUpdateNotes(openShow.id, notes)}
        />
      ) : null}
      {openGroup ? (
        <GroupDrawer group={openGroup} onClose={closeDrawer} />
      ) : null}
    </div>
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

function ColumnHeader({
  group,
  onOpenGroup,
}: {
  group: FormatGroup;
  // Called when the label button is clicked. The trigger element is
  // captured so the drawer can return keyboard focus to it on close.
  onOpenGroup: (groupId: FormatGroup, trigger: HTMLElement | null) => void;
}) {
  const groupConfig = seedPlatformGroups.find((g) => g.id === group);
  if (!groupConfig) return null;

  const mainPlatforms = groupConfig.platforms.filter((p) => !p.isExperimental);
  const experimentalPlatforms = groupConfig.platforms.filter(
    (p) => p.isExperimental,
  );

  return (
    <th className="text-left align-bottom px-3 py-3 border-b-[0.5px] border-[var(--border)]">
      {/* Group label is a button — opens the first-principles drawer.
          Hover tint reuses --terracotta-hover to match the show-name
          button below, keeping the page's hoverable-text vocabulary
          consistent. */}
      <button
        type="button"
        onClick={(e) => onOpenGroup(group, e.currentTarget)}
        className="text-[13px] font-medium text-[var(--foreground)] hover:text-[var(--terracotta-hover)] transition-colors text-left cursor-pointer"
      >
        {FORMAT_GROUP_LABELS[group]}
      </button>
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
  onOpenShow,
  hoveredCellKey,
}: {
  show: Show;
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
            />
          </td>
        );
      })}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Status cell — renders the right pill / em-dash for a Show × FormatGroup
// intersection. Read-only display; status is set in strategy-config.ts.
// ---------------------------------------------------------------------------

function StatusCell({
  source,
  status,
}: {
  source: Source;
  status: Status;
}) {
  if (status === "none") {
    return (
      <span className="text-[var(--overview-fg)]/35 text-[14px] leading-none">
        —
      </span>
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

  // active
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
// Show drawer — right-side overlay with two tabs (Creative Brief /
// Automation). Mounted by StrategyPage when openShowId is non-null.
//
// The drawer is its own focus realm:
//   - Body scroll is locked while open.
//   - Escape closes; Tab/Shift+Tab cycle focus within the drawer.
//   - Close button is auto-focused on mount so keyboard users land in a
//     sensible spot.
//   - The active tab indicator uses the show's source color, tying the
//     drawer visually to the matrix row.
// ---------------------------------------------------------------------------

type DrawerTab = "brief" | "automation";

const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: "brief", label: "Creative Brief" },
  { id: "automation", label: "Automation" },
];

interface ShowDrawerProps {
  show: Show;
  onClose: () => void;
  hoveredCellKey: string | null;
  setHoveredCellKey: (key: string | null) => void;
  onAddStep: (step: Omit<AutomationStep, "id">) => void;
  onUpdateNotes: (notes: string) => void;
}

// Shared body-scroll-lock + Escape + focus-trap behavior. Lives at
// module scope (instead of inside ShowDrawer) so GroupDrawer can reuse
// the same keyboard contract without copy-pasting ~40 lines that would
// drift apart over time. Caller passes refs for the drawer root and
// the initial-focus target (the X button).
function useDrawerKeyboard({
  drawerRef,
  closeBtnRef,
  onClose,
}: {
  drawerRef: React.RefObject<HTMLDivElement | null>;
  closeBtnRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
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
  }, [onClose, drawerRef, closeBtnRef]);
}

function ShowDrawer({
  show,
  onClose,
  setHoveredCellKey,
  onAddStep,
  onUpdateNotes,
}: ShowDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>("brief");
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  useDrawerKeyboard({ drawerRef, closeBtnRef, onClose });

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
        {tab === "brief" ? (
          <CreativeBriefTab show={show} onUpdateNotes={onUpdateNotes} />
        ) : null}
        {tab === "automation" ? (
          <AutomationTab
            show={show}
            onAddStep={onAddStep}
            setHoveredCellKey={setHoveredCellKey}
          />
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
// Drawer tabs — Creative Brief / Automation. Active tab's underline uses
// the show's source color (not the global theme accent) so the drawer's
// identity is tied to the row that opened it.
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
// Creative Brief tab.
//
// Two modes:
//   1. `show.briefUrl` set — render a link card pointing at the external
//      doc (Google Docs, Notion, etc.). No inline editing in this mode;
//      the canonical brief lives at the URL.
//   2. Otherwise — render a textarea bound via "commit on blur": typing
//      updates a local buffer, blur commits to the shared `shows` state.
//      The local-state reset effect depends only on `show.id` (not
//      `show.notes`) so external mutations don't clobber in-progress
//      typing; re-hydration happens only on show-identity change.
// ---------------------------------------------------------------------------

function CreativeBriefTab({
  show,
  onUpdateNotes,
}: {
  show: Show;
  onUpdateNotes: (notes: string) => void;
}) {
  const [value, setValue] = useState(show.notes ?? "");
  // Ref so we can auto-grow the textarea: reset height to 'auto' then
  // set to scrollHeight on every value change. This lets the whole
  // brief flow down the page (scrolling happens on the drawer body),
  // instead of getting trapped behind an inner scrollbar.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValue(show.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show.id]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  if (show.briefUrl) {
    return (
      <div className="p-6">
        <BriefLinkCard label="Open creative brief" url={show.briefUrl} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onUpdateNotes(value)}
        placeholder="Describe the show — voice, audience, creative direction, goals…"
        // Mono font so the structured briefs (numbered sections,
        // 4-space indents, ☐ checkboxes) line up the way they're
        // written. overflow-hidden + resize-none + JS auto-grow lets
        // the textarea expand vertically and pushes scroll up to the
        // drawer body — no inner scrollbar.
        className="block w-full font-mono text-[12px] bg-transparent border-[0.5px] rounded-[8px] px-3 py-2 text-[var(--foreground)] focus:outline-none focus:border-[var(--terracotta)] resize-none overflow-hidden leading-relaxed whitespace-pre"
        style={{ borderColor: "var(--border)" }}
      />
      {show.briefLinks && show.briefLinks.length > 0 ? (
        <section>
          <div className="text-[11px] font-medium text-[var(--muted-foreground)] mb-3">
            References
          </div>
          <div className="space-y-2">
            {show.briefLinks.map((link) => (
              <BriefLinkCard
                key={link.url}
                label={link.label}
                url={link.url}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// Shared link card used by the Creative Brief tab. Handles both the
// "brief lives entirely at this URL" case (Scale or Fail) and the
// list-of-references case (L1 Q&A). Source label on the right is
// derived from the URL's host so we don't have to hand-tag every link.
function BriefLinkCard({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 rounded-[8px] border-[0.5px] px-4 py-3 text-[13px] text-[var(--foreground)] hover:border-[var(--terracotta)] transition-colors"
      style={{
        backgroundColor: "var(--card)",
        borderColor: "var(--border)",
      }}
    >
      <span className="flex items-center gap-2 min-w-0">
        <ExternalLink className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-[11px] text-[var(--muted-foreground)] shrink-0">
        {getLinkSourceLabel(url)}
      </span>
    </a>
  );
}

// Maps a URL to a short host label ("Google Docs" / "Notion" / hostname
// fallback). Kept hand-rolled because the set of doc hosts we link to
// is tiny — a library would be overkill.
function getLinkSourceLabel(url: string): string {
  if (url.includes("docs.google.com")) return "Google Docs";
  if (url.includes("notion.so")) return "Notion";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
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
// Group drawer — right-side overlay that opens when a format-group
// column header (Long / Mid / Short / Written) is clicked. Mirrors the
// show drawer's structure (header / tabs / body) but only has a single
// tab ("First Principles") today. Kept as its own component instead of
// generalizing ShowDrawer — the two share the keyboard hook but their
// props and bodies have nothing in common.
// ---------------------------------------------------------------------------

function GroupDrawer({
  group,
  onClose,
}: {
  group: PlatformGroup;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  useDrawerKeyboard({ drawerRef, closeBtnRef, onClose });

  // Platform-count subtitle ("3 platforms"). Cheap derivation — doesn't
  // need useMemo since the array is tiny and the drawer mounts rarely.
  const platformCount = group.platforms.length;

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${group.label} first principles`}
      className="fixed top-0 right-0 h-screen w-full md:w-[60vw] md:max-w-[720px] bg-[var(--background)] z-[50] flex flex-col animate-in slide-in-from-right duration-200 border-l-[0.5px] border-[var(--border)]"
    >
      <header className="flex items-stretch gap-3 px-6 py-5 border-b-[0.5px] border-[var(--border)]">
        <div className="flex-1 min-w-0">
          <h2 className="text-[17px] font-medium text-[var(--foreground)] truncate">
            {group.label}
          </h2>
          <p className="text-[11px] text-[var(--overview-fg)]/35 mt-1">
            Format group · {platformCount}{" "}
            {platformCount === 1 ? "platform" : "platforms"}
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

      {/* Single-tab nav. We keep the tablist semantics + visual
          treatment even with only one tab so the drawer reads as
          consistent with the show drawer — and so dropping in a
          second tab later is a one-line change. Underline color uses
          --foreground (white) instead of a source color since groups
          don't belong to a source palette. */}
      <nav
        className="flex gap-6 px-6 border-b-[0.5px] border-[var(--border)]"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="py-3 text-[12px] font-medium uppercase tracking-[0.08em]"
          style={{
            color: "var(--foreground)",
            borderBottom: "2px solid var(--foreground)",
            marginBottom: "-0.5px",
          }}
        >
          First Principles
        </button>
      </nav>

      <div className="flex-1 overflow-y-auto">
        <FirstPrinciplesTab group={group} />
      </div>
    </aside>
  );
}

// Body of the First Principles tab. Read-only display — copy lives in
// strategy-config.ts on the PlatformGroup. Rendered in a monospace
// pre-formatted block so structured headings / bullet indentation
// (similar to the show briefs) line up exactly as authored. If no
// copy has been written yet, show a placeholder so the empty state
// is obvious rather than a blank panel.
function FirstPrinciplesTab({ group }: { group: PlatformGroup }) {
  if (!group.firstPrinciples) {
    return (
      <div className="p-6">
        <p className="text-[12px] text-[var(--muted-foreground)] italic">
          No first principles defined yet.
        </p>
      </div>
    );
  }
  return (
    <div className="p-6">
      <pre className="font-mono text-[12px] text-[var(--foreground)] leading-relaxed whitespace-pre-wrap">
        {renderFirstPrinciplesWithLinks(group.firstPrinciples)}
      </pre>
    </div>
  );
}

// Split the firstPrinciples copy on http(s) URLs and wrap matches in
// anchor tags so they're clickable. The surrounding <pre> still
// preserves whitespace because plain-text segments come back as raw
// strings. Kept inline here (rather than a separate utility) because
// it's only used by this one component.
function renderFirstPrinciplesWithLinks(text: string) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={key++}
        href={match[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--terracotta)] hover:underline"
      >
        {match[0]}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
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
