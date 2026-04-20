"use client";

/**
 * Overview page — status pill.
 *
 * Three states: healthy (solid dot, neutral), pending (breathing, dimmer),
 * failing (dimmest, no animation). Kept neutral on purpose — terracotta is
 * the single accent on the overview page, so status is communicated via
 * opacity + motion rather than color.
 */

export type OverviewStatus = "healthy" | "pending" | "failing";

export function StatusPill({ status }: { status: OverviewStatus }) {
  if (status === "healthy") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-[3px] rounded-full tracking-[0.04em] text-[var(--overview-fg)] bg-white/[0.08] border border-white/[0.12]">
        <span className="h-[5px] w-[5px] rounded-full bg-[var(--overview-fg)]" />
        Healthy
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span
        className="anim-pending-pulse inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-[3px] rounded-full tracking-[0.04em] text-[var(--overview-fg)]/55 bg-white/[0.04] border border-white/[0.08]"
        style={{ animation: "pending-pulse 2.2s ease-in-out infinite" }}
      >
        <span
          className="anim-pending-dot h-[5px] w-[5px] rounded-full bg-[var(--overview-fg)]/40"
          style={{ animation: "pending-dot 2.2s ease-in-out -0.4s infinite" }}
        />
        Pending
      </span>
    );
  }

  // failing — dimmest neutral, no motion. Deliberate: breathing would signal
  // "waiting," but this state needs "something is wrong" without shouting.
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-[3px] rounded-full tracking-[0.04em] text-[var(--overview-fg)]/40 bg-white/[0.03] border border-white/[0.06]">
      <span className="h-[5px] w-[5px] rounded-full bg-[var(--overview-fg)]/30" />
      Failing
    </span>
  );
}
