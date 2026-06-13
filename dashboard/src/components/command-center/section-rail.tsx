/*
 * SectionRail — the section divider used between blocks on a page.
 *
 * Lifted verbatim from the home page's category-section header (see the
 * category header in app/page.tsx): a bold uppercase label tinted to the
 * section accent, an animated .cc-rule that sweeps, and an optional
 * right-aligned mono meta string (a count or note). Detail pages previously
 * hand-rolled this with slightly different weights/tracking on each page —
 * routing them all through this component keeps the rails identical to home.
 */

interface SectionRailProps {
  label: string;
  /** Tints the label and the rule. Defaults to terracotta. */
  accent?: string;
  /** Optional right-aligned mono metadata (e.g. a count or short note). */
  meta?: React.ReactNode;
}

export function SectionRail({
  label,
  accent = "var(--terracotta)",
  meta,
}: SectionRailProps) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className="text-[13px] font-bold uppercase tracking-[0.2em]"
        style={{ color: accent }}
      >
        {label}
      </span>
      <span
        className="cc-rule"
        style={{ ["--rule-color" as never]: accent } as React.CSSProperties}
        aria-hidden
      />
      {meta && (
        <span className="font-mono text-[11px] tracking-[0.08em] text-white/40">
          {meta}
        </span>
      )}
    </div>
  );
}
