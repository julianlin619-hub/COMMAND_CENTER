/*
 * CategorySection — a populated category. Renders the category band
 * (small colored rail + label + count) above a responsive grid of
 * FormatCards.
 *
 * Grid (flat mode): `repeat(auto-fit, minmax(280px, 1fr))`. The 280px
 * floor is tuned to the page's 1100px max-width container (1052px of
 * content after horizontal padding): three 280px tracks + two 12px gaps
 * = 864px fits comfortably, but a fourth track would need 1156px and
 * cannot fit, so cards wrap to a second row at 4+ items. Narrower
 * viewports collapse further (3 → 2 → 1) via auto-fit. `auto-fit` also
 * makes single-card categories stretch to fill the row instead of
 * sitting at 280px on the left with empty space — verifies in the Mid
 * section, which currently has one card.
 *
 * Subgrouped mode: when a category contains formats tagged with 2+
 * distinct `subgroup` values (today only Alex's Short, split into
 * Creation vs Distribution), we render one grid with full-width sub-
 * headers between groups. The grid uses `auto-fill` instead of
 * `auto-fit` so empty tracks are preserved — that keeps cards aligned
 * column-wise across both sub-groups (otherwise the 2 Creation cards
 * would stretch wider than the 3 Distribution cards, since `auto-fit`
 * collapses unused tracks). Headers span all columns via
 * `grid-column: 1 / -1`, forcing the next set of cards onto a fresh
 * row.
 */
import { Fragment } from "react";
import { FormatCard } from "./format-card";
import {
  SUBGROUP_LABELS,
  SUBGROUP_ORDER,
  type Format,
  type FormatHealth,
  type FormatSubgroup,
} from "@/lib/command-center-config";

interface CategorySectionProps {
  label: string;
  color: string;
  formats: Format[];
  // Per-format health, resolved on the home page. We accept a Map
  // (vs. embedding health on Format) so the config stays purely static
  // and Supabase reads stay confined to the page component.
  healthMap: Map<string, FormatHealth>;
}

// Defensive default — if a format somehow doesn't appear in the map
// (e.g. a new format was added but the home page wasn't re-rendered),
// show it as paused rather than crashing. Same rationale as
// getFormatHealth's "no platforms" fallback.
const DEFAULT_HEALTH: FormatHealth = "paused";

export function CategorySection({
  label,
  color,
  formats,
  healthMap,
}: CategorySectionProps) {
  const count = formats.length;

  // Determine which subgroups (if any) are populated in this category.
  // We only switch to the subgrouped layout when 2+ subgroups are
  // present — a single subgroup with one card (e.g. Leila's Short, if
  // only one of her formats was tagged) would render the same as flat,
  // so we skip the sub-header noise in that case.
  const subgroupsPresent: FormatSubgroup[] = SUBGROUP_ORDER.filter((sg) =>
    formats.some((f) => f.subgroup === sg),
  );
  const useSubgroups = subgroupsPresent.length >= 2;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        {/* 3px × 14px colored rail — flush left of the label. */}
        <span
          aria-hidden
          className="h-[14px] w-[3px] rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span
          className="text-[14px] font-medium"
          style={{ color }}
        >
          {label}
        </span>
        <span className="text-[12px] text-white/40">
          {count} {count === 1 ? "format" : "formats"}
        </span>
      </div>

      {useSubgroups ? (
        <div
          className="grid gap-3"
          style={{
            // auto-fill (not auto-fit) so the empty 3rd track in the
            // Creation row stays as a placeholder — keeps card widths
            // identical across both sub-rows.
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {subgroupsPresent.map((sg, idx) => {
            const items = formats.filter((f) => f.subgroup === sg);
            return (
              <Fragment key={sg}>
                <div
                  // Faint section divider — minor type, tight tracking,
                  // muted color so the Category band reads as primary
                  // and these read as secondary structure. `mt-2` on
                  // every header except the first creates breathing
                  // room between sub-groups without doubling the gap.
                  className={`text-[10px] font-medium uppercase tracking-[0.2em] text-white/35 ${
                    idx > 0 ? "mt-2" : ""
                  }`}
                  style={{ gridColumn: "1 / -1" }}
                >
                  {SUBGROUP_LABELS[sg]}
                </div>
                {items.map((f) => (
                  <FormatCard
                    key={f.id}
                    format={f}
                    color={color}
                    health={healthMap.get(f.id) ?? DEFAULT_HEALTH}
                  />
                ))}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          }}
        >
          {formats.map((f) => (
            <FormatCard
              key={f.id}
              format={f}
              color={color}
              health={healthMap.get(f.id) ?? DEFAULT_HEALTH}
            />
          ))}
        </div>
      )}
    </section>
  );
}
