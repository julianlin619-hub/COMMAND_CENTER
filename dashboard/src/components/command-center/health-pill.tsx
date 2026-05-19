/*
 * Health pill — small status indicator rendered on every FormatCard.
 *
 * Sizing is intentionally tight (10px text, 5px dot, 2px vertical
 * padding) so the pill doesn't compete with the format name for
 * attention in the card header.
 *
 * Colors come from .claude/rules/dashboard.md: green-500 for success,
 * amber-500 for failing (reads as "attention" without the alarm of
 * red). Paused uses a double-bar glyph instead of a dot so
 * operator-disabled isn't visually conflated with "broken" — the
 * double-bar reads as a play-pause icon.
 */
import type { FormatHealth } from "@/lib/command-center-config";

interface HealthPillProps {
  status: FormatHealth;
}

export function HealthPill({ status }: HealthPillProps) {
  if (status === "healthy") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-[2px] text-[10px] font-medium tracking-[0.02em] text-white/70">
        <span
          aria-hidden
          className="h-[5px] w-[5px] rounded-full"
          style={{ backgroundColor: "#22c55e" }}
        />
        Healthy
      </span>
    );
  }

  if (status === "failing") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-[2px] text-[10px] font-medium tracking-[0.02em] text-white/75">
        <span
          aria-hidden
          className="h-[5px] w-[5px] rounded-full"
          style={{ backgroundColor: "#f59e0b" }}
        />
        Failing
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-[2px] text-[10px] font-medium tracking-[0.02em] text-white/40">
      <span aria-hidden className="inline-flex items-center gap-[2px]">
        <span className="h-[6px] w-[1.5px] rounded-[0.5px] bg-white/40" />
        <span className="h-[6px] w-[1.5px] rounded-[0.5px] bg-white/40" />
      </span>
      Paused
    </span>
  );
}
