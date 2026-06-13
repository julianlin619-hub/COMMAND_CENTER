"use client";

/*
 * EmptyCategoryBand — a single-row affordance for a category that has no
 * formats yet. Lives at the bottom of the page, below all populated
 * sections. The whole row is the click target so hovering anywhere on
 * the band gives feedback, and clicking opens the "add format" flow
 * (stubbed for now).
 *
 * Marked "use client" because the row needs an onClick handler; without
 * it, Next.js refuses to pass function props from the server tree.
 */
import { Plus } from "lucide-react";
import type { CommandCenterCategory } from "@/lib/command-center-config";

interface EmptyCategoryBandProps {
  category: CommandCenterCategory;
  label: string;
  color: string;
}

export function EmptyCategoryBand({
  category,
  label,
  color,
}: EmptyCategoryBandProps) {
  return (
    <button
      type="button"
      data-action="add-format"
      data-category={category}
      onClick={() => {
        // Stub: add-format flow not built yet. data-action is the
        // future wiring point.
      }}
      className="group flex w-full items-center justify-between gap-4 rounded-[16px] px-6 py-[22px] text-left transition-all duration-150 hover:bg-white/[0.02]"
      style={{
        border: "1px dashed var(--surface-border-hi)",
        backgroundColor: "rgba(255,255,255,0.012)",
      }}
    >
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden
          className="h-[9px] w-[9px] rounded-full"
          style={{ backgroundColor: color, opacity: 0.7 }}
        />
        <span
          className="text-[13px] font-bold uppercase tracking-[0.18em]"
          style={{ color }}
        >
          {label}
        </span>
        <span className="font-mono text-[11px] tracking-[0.08em] text-white/35">
          No formats configured
        </span>
      </div>

      <span
        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] text-white/40 transition-colors duration-150 group-hover:text-white/75"
        style={{
          border: "0.5px solid rgba(255,255,255,0.10)",
        }}
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add format
      </span>
    </button>
  );
}
