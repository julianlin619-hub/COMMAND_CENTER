/*
 * PageHeader — Command Center title row + legend.
 *
 * The legend uses the same four CATEGORY_COLORS as the rest of the page.
 * Categories without any formats are dimmed to ~50% opacity so the user
 * can see "this bucket exists but is empty" at a glance, matching the
 * dimmed-then-collapsed pattern of the empty bands at the bottom.
 *
 * The "Old UI" link in the header is temporary — it lets us A/B the new
 * Command Center against the previous platform-centric view at /overview
 * while the new design is being trialed. Remove the link (and the
 * /overview route) once the new UI is the canonical home.
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type FormatGroup,
} from "@/lib/command-center-config";

interface PageHeaderProps {
  liveCount: number;
  pausedCount: number;
  populatedCategories: Set<FormatGroup>;
}

export function PageHeader({
  liveCount,
  pausedCount,
  populatedCategories,
}: PageHeaderProps) {
  return (
    <header>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[24px] font-medium tracking-tight text-[#edeae0]">
          Command Center
        </h1>
        <div className="flex items-center gap-4">
          <div className="text-[12px] text-white/45">
            {liveCount} live · {pausedCount} paused
          </div>
          {/* Strategy lives on its own page (/strategy) — a planning /
              architecture view rather than a daily-ops surface. The link
              used to sit on the legacy /overview UI; moved here so the
              Command Center is the only home users need to know about. */}
          <Link
            href="/strategy"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/55 transition-colors duration-150 hover:border-white/25 hover:text-white/85"
          >
            Strategy
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
          {/* Temporary toggle to the legacy platform-centric home. */}
          <Link
            href="/overview"
            className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/55 transition-colors duration-150 hover:border-white/25 hover:text-white/85"
          >
            Old UI
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-white/55">
        {CATEGORY_ORDER.map((c) => {
          const isPopulated = populatedCategories.has(c);
          return (
            <div
              key={c}
              className="flex items-center gap-1.5 transition-opacity duration-150"
              style={{ opacity: isPopulated ? 1 : 0.5 }}
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: CATEGORY_COLORS[c] }}
              />
              <span>{CATEGORY_LABELS[c]}</span>
            </div>
          );
        })}
      </div>
    </header>
  );
}
