/*
 * PageHeader — Command Center title row.
 *
 * Matches the refined-terracotta mock exactly:
 *   - a mono eyebrow ("Media · Command Center") with a *subtle* Strategy
 *     link tucked to the far right of the eyebrow row (present for
 *     navigation, but low-emphasis so it never competes with the title),
 *   - a 50px display title with a terracotta period,
 *   - a live/paused tally with big tabular numerals and status pips.
 *
 * The four-color category legend that used to sit under the title was
 * removed to match the mock — category identity now reads from the
 * colored section rules further down the page instead.
 */
import Link from "next/link";
import { ArrowUpRight, Compass, ScrollText } from "lucide-react";

interface PageHeaderProps {
  liveCount: number;
  pausedCount: number;
}

export function PageHeader({ liveCount, pausedCount }: PageHeaderProps) {
  return (
    <header>
      {/* Eyebrow row: brand label on the left, faint secondary-surface links
          on the right. Posts (the publishing log) and Strategy (the planning
          surface) each live on their own page but stay reachable here —
          rendered small and muted so the title carries the visual weight.
          They share the exact same treatment so they read as a matched pair. */}
      <div className="flex items-center justify-between gap-4">
        <span
          className="font-mono text-[11px] uppercase"
          style={{ letterSpacing: "0.28em", color: "var(--terracotta-hover)" }}
        >
          Media · Command Center
        </span>
        <div className="flex items-center gap-5">
          <Link
            href="/posts"
            className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/35 transition-colors duration-150 hover:text-white/70"
          >
            {/* ScrollText reads as a log/ledger — fits the publishing-log
                nature of the Posts page. */}
            <ScrollText className="h-3 w-3" aria-hidden />
            Posts
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
          <Link
            href="/strategy"
            className="inline-flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/35 transition-colors duration-150 hover:text-white/70"
          >
            {/* Compass glyph identifies this as the planning/strategy surface
                at a glance — leads the label so the link reads as more than a
                generic "go elsewhere" arrow. */}
            <Compass className="h-3 w-3" aria-hidden />
            Strategy
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </div>

      <div className="mt-3.5 flex items-end justify-between gap-8 flex-wrap">
        <h1 className="text-[50px] font-semibold leading-none tracking-[-0.025em] text-[#edeae0]">
          Command Center<span style={{ color: "var(--terracotta)" }}>.</span>
        </h1>

        {/* Live / paused tally — big tabular numerals; the live count gets a
            pinging green pip, the paused count a static terracotta pip. */}
        <div className="flex items-end gap-7">
          <div>
            <div className="tabular flex items-center gap-2.5 text-[34px] font-bold leading-none text-[#edeae0]">
              <span
                className="cc-pip cc-pip--live"
                style={{ ["--pip-color" as never]: "var(--pill-ok-fg)" } as React.CSSProperties}
              />
              {liveCount}
            </div>
            <div
              className="mt-[7px] font-mono text-[10.5px] uppercase"
              style={{ letterSpacing: "0.18em", color: "rgba(237,234,224,0.58)" }}
            >
              Live
            </div>
          </div>
          <div>
            <div className="tabular flex items-center gap-2.5 text-[34px] font-bold leading-none text-[#edeae0]">
              <span
                className="cc-pip"
                style={{ ["--pip-color" as never]: "var(--terracotta)", opacity: 0.7 } as React.CSSProperties}
              />
              {pausedCount}
            </div>
            <div
              className="mt-[7px] font-mono text-[10.5px] uppercase"
              style={{ letterSpacing: "0.18em", color: "rgba(237,234,224,0.58)" }}
            >
              Paused
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
