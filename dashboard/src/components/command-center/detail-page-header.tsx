/*
 * DetailPageHeader — the shared hero header for every leaf page you reach by
 * clicking into a Command Center card (/snapchat, /posts, /leila/linkedin, …).
 *
 * It is the subpage counterpart to the home page's <PageHeader>: same voice,
 * same rhythm, so detail pages read as siblings of the home screen rather than
 * a different app. The pieces it mirrors, one-for-one, from page-header.tsx:
 *   - a mono eyebrow above the title,
 *   - a large display title with a trailing accent period,
 *   - an optional right-side cluster of stat counters (big tabular numerals +
 *     status pips + mono labels) — the same treatment as home's live/paused
 *     tally,
 *   - an animated full-width rule that closes the header block.
 *
 * The one knob that varies per page is `accent`: home is always terracotta, but
 * a detail page wears its own platform/category identity (Snapchat yellow, the
 * category colors). Every accent-tinted element (eyebrow, period, rule, pips)
 * reads from a single `--accent` CSS var so a page sets its color once and the
 * whole header follows. We also alias `--terracotta-hover` to the accent so the
 * shared `.cc-eyebrow` class (which is hard-wired to terracotta-hover) picks up
 * the page color without a bespoke style — the same trick the old /snapchat
 * header used inline.
 */
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

export interface HeaderStat {
  label: string;
  value: string | number;
  /**
   * "live" → pinging pip (use for counts that should read as actively running),
   * "static" → solid pip, "none" → no pip (the default; most counts are inert).
   */
  pip?: "live" | "static" | "none";
  /** Pip color; defaults to the header accent. Greens/reds read status. */
  pipColor?: string;
}

interface DetailPageHeaderProps {
  eyebrow: string;
  /** The title text; a trailing accent period is appended unless disabled. */
  title: string;
  titlePeriod?: boolean;
  subtitle?: React.ReactNode;
  /** Drives eyebrow, period, rule, and default pip color. Defaults to terracotta. */
  accent?: string;
  /** Optional platform glyph rendered left of the title block. */
  icon?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  /** Right-side counter cluster — the live/paused-style tally from home. */
  stats?: HeaderStat[];
  /** Right-side slot for buttons or a status pill (sits beside/below stats). */
  actions?: React.ReactNode;
  /** Animated divider under the header. On by default. */
  rule?: boolean;
}

export function DetailPageHeader({
  eyebrow,
  title,
  titlePeriod = true,
  subtitle,
  accent = "var(--terracotta)",
  icon,
  backHref = "/",
  backLabel = "Back to Command Center",
  stats,
  actions,
  rule = true,
}: DetailPageHeaderProps) {
  const hasRight = (stats && stats.length > 0) || actions;

  return (
    // Set the accent once here; everything below reads --accent, and aliasing
    // --terracotta-hover lets the shared .cc-eyebrow class wear the page color.
    <header
      style={
        {
          ["--accent" as never]: accent,
          ["--terracotta-hover" as never]: accent,
        } as React.CSSProperties
      }
    >
      {/* Back affordance — one consistent treatment across every detail page,
          replacing the per-page hand-rolled links. */}
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/40 transition-colors duration-150 hover:text-white/75"
      >
        <ArrowLeftIcon className="h-3 w-3" aria-hidden />
        {backLabel}
      </Link>

      <div className="mt-6 flex items-end justify-between gap-8 flex-wrap">
        <div className="flex items-start gap-3.5 min-w-0">
          {icon && <div className="mt-1 shrink-0">{icon}</div>}
          <div className="min-w-0">
            <div className="cc-eyebrow">{eyebrow}</div>
            <h1 className="mt-2 text-[44px] font-semibold leading-none tracking-[-0.025em] text-[#edeae0]">
              {title}
              {titlePeriod && <span style={{ color: "var(--accent)" }}>.</span>}
            </h1>
            {subtitle && (
              <p className="mt-2.5 text-[13px] leading-snug text-white/55">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {hasRight && (
          <div className="flex items-end gap-7">
            {stats?.map((s) => (
              <div key={s.label}>
                <div className="tabular flex items-center gap-2.5 text-[30px] font-bold leading-none text-[#edeae0]">
                  {s.pip && s.pip !== "none" && (
                    <span
                      className={s.pip === "live" ? "cc-pip cc-pip--live" : "cc-pip"}
                      style={
                        {
                          ["--pip-color" as never]: s.pipColor ?? "var(--accent)",
                          ...(s.pip === "static" ? { opacity: 0.7 } : {}),
                        } as React.CSSProperties
                      }
                    />
                  )}
                  {s.value}
                </div>
                <div
                  className="mt-[7px] font-mono text-[10.5px] uppercase"
                  style={{ letterSpacing: "0.18em", color: "rgba(237,234,224,0.58)" }}
                >
                  {s.label}
                </div>
              </div>
            ))}
            {actions}
          </div>
        )}
      </div>

      {rule && (
        <span
          className="cc-rule mt-7 block"
          style={{ ["--rule-color" as never]: accent } as React.CSSProperties}
          aria-hidden
        />
      )}
    </header>
  );
}
