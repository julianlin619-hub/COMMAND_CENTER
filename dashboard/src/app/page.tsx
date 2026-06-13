/**
 * Dashboard home — Command Center.
 *
 * A format-centric view. Content formats (Reposts, Crosspost, Tweet Cards,
 * …) are grouped into length-based categories — Short, Written, Mid (see
 * CATEGORY_ORDER) — and rendered as a stack of CategorySections. Empty
 * categories collapse to a single dashed band at the bottom of the page.
 *
 * The data is currently static (see `dashboard/src/lib/command-center-config.ts`)
 * because there's no DB schema for formats yet — when there is, swap the
 * import for a Supabase fetch; the page shape doesn't need to change.
 *
 * Creator filter: a `?creator=alex|leila` URL param selects which
 * creator's formats are shown. The two creators are NEVER rendered on
 * the same page — the CreatorToggle navigates between filtered views by
 * pushing the URL param, and this server component reads the param and
 * filters before any rendering. Defaults to Alex when the param is
 * absent or unrecognised.
 */
import {
  FORMATS,
  CATEGORY_ORDER,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  parseCreatorParam,
  type CommandCenterCategory,
} from "@/lib/command-center-config";
import { fetchHealthCounts, buildHealthMap } from "@/lib/format-health";
import { getSupabaseClient } from "@/lib/supabase";
import { PageHeader } from "@/components/command-center/page-header";
import { CategorySection } from "@/components/command-center/category-section";
import { EmptyCategoryBand } from "@/components/command-center/empty-category-band";
import { CreatorToggle } from "@/components/command-center/creator-toggle";

// Always re-render — health pills should reflect the current 24h window
// on every load, not a build-time snapshot. The page was previously
// statically renderable because all data was hard-coded; the Supabase
// fetch makes it dynamic regardless, but the directive is explicit so
// caching surprises don't creep in later.
export const dynamic = "force-dynamic";

// Next 16 passes searchParams as a Promise so dynamic APIs can stream.
// Await it before reading any keys.
interface DashboardHomeProps {
  searchParams: Promise<{ creator?: string | string[] }>;
}

export default async function DashboardHome({ searchParams }: DashboardHomeProps) {
  const { creator: creatorParam } = await searchParams;
  const creator = parseCreatorParam(creatorParam);

  // Filter to the selected creator's formats *first*, then bucket. The
  // PageHeader's live/paused counts and the populated-category set also
  // need to reflect the filtered view, so we work off `visibleFormats`
  // everywhere instead of FORMATS directly.
  const visibleFormats = FORMATS.filter((f) => f.creator === creator);

  // One Supabase query covers every card on the page — see
  // lib/format-health.ts for why we don't fan out per-card. We compute
  // the map over `visibleFormats` only (rather than FORMATS) so we
  // don't pay to evaluate the other creator's cards on every load.
  const supabase = getSupabaseClient();
  const counts = await fetchHealthCounts(supabase);
  const healthMap = buildHealthMap(visibleFormats, counts);

  const byCategory: Record<CommandCenterCategory, typeof FORMATS> = {
    short: [],
    written: [],
    long: [],
    mid: [],
    graphics: [],
  };
  for (const f of visibleFormats) byCategory[f.category].push(f);

  const active = CATEGORY_ORDER.filter((c) => byCategory[c].length > 0);
  const empty = CATEGORY_ORDER.filter((c) => byCategory[c].length === 0);
  const liveCount = visibleFormats.filter((f) => f.status === "live").length;
  const pausedCount = visibleFormats.length - liveCount;

  return (
    // No opaque background here — the global .app-atmosphere (warm radial +
    // grain, see layout.tsx) shows through so the home page shares the same
    // ambient surface as every other route. Container width + paddings match
    // the refined-terracotta mock (max-w 1100, ~56px top padding).
    <div className="relative min-h-screen" style={{ color: "var(--foreground)" }}>
      <div className="mx-auto max-w-[1100px] px-7 pb-24 pt-14">
        <div className="cc-reveal">
          <PageHeader liveCount={liveCount} pausedCount={pausedCount} />
        </div>

        {/* Creator toggle sits directly below the header so it reads as a
            page-level navigator rather than a per-section control. */}
        <div className="cc-reveal mt-[34px]" style={{ animationDelay: "0.06s" }}>
          <CreatorToggle current={creator} />
        </div>

        <div className="mt-[52px] space-y-[52px]">
          {active.map((c, i) => (
            <div
              key={c}
              className="cc-reveal"
              // Stagger each category section in after the header so the
              // page assembles top-to-bottom rather than all at once.
              style={{ animationDelay: `${0.12 + i * 0.07}s` }}
            >
              <CategorySection
                label={CATEGORY_LABELS[c]}
                color={CATEGORY_COLORS[c]}
                formats={byCategory[c]}
                healthMap={healthMap}
              />
            </div>
          ))}
        </div>

        {empty.length > 0 && (
          <div className="mt-[34px] space-y-2.5">
            {empty.map((c) => (
              <EmptyCategoryBand
                key={c}
                category={c}
                label={CATEGORY_LABELS[c]}
                color={CATEGORY_COLORS[c]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
