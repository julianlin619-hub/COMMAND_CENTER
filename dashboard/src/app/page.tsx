/**
 * Dashboard home — Command Center.
 *
 * A format-centric view. Content formats (Reposts, Crosspost, Tweet Cards,
 * …) are grouped into four length-based categories — Short, Written, Long,
 * Mid — and rendered as a stack of CategorySections. Empty categories
 * collapse to a single dashed band at the bottom of the page.
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
  type FormatGroup,
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

  const byCategory: Record<FormatGroup, typeof FORMATS> = {
    short: [],
    written: [],
    long: [],
    mid: [],
  };
  for (const f of visibleFormats) byCategory[f.category].push(f);

  const active = CATEGORY_ORDER.filter((c) => byCategory[c].length > 0);
  const empty = CATEGORY_ORDER.filter((c) => byCategory[c].length === 0);
  const populated = new Set(active);
  const liveCount = visibleFormats.filter((f) => f.status === "live").length;
  const pausedCount = visibleFormats.length - liveCount;

  return (
    <div
      className="relative min-h-screen"
      style={{
        color: "var(--foreground)",
        backgroundColor: "var(--background)",
      }}
    >
      <div className="mx-auto max-w-[1100px] px-6 py-10">
        <PageHeader
          liveCount={liveCount}
          pausedCount={pausedCount}
          populatedCategories={populated}
        />

        {/* Creator toggle sits directly below the header so it reads as a
            page-level navigator rather than a per-section control. */}
        <div className="mt-5">
          <CreatorToggle current={creator} />
        </div>

        <div className="mt-10 space-y-10">
          {active.map((c) => (
            <CategorySection
              key={c}
              label={CATEGORY_LABELS[c]}
              color={CATEGORY_COLORS[c]}
              formats={byCategory[c]}
              healthMap={healthMap}
            />
          ))}
        </div>

        {empty.length > 0 && (
          <div className="mt-10 space-y-2">
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
