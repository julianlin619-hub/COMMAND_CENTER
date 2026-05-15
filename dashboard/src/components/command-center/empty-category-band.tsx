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
import type { FormatGroup } from "@/lib/command-center-config";

interface EmptyCategoryBandProps {
  category: FormatGroup;
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
      className="group flex w-full items-center justify-between gap-4 rounded-[10px] px-4 py-3 text-left transition-all duration-150 hover:bg-white/[0.015]"
      style={{
        border: "0.5px dashed rgba(255,255,255,0.08)",
        backgroundColor: "rgba(255,255,255,0.005)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="h-[14px] w-[3px] rounded-sm"
          style={{ backgroundColor: color, opacity: 0.5 }}
        />
        <span
          className="text-[14px] font-medium"
          style={{ color: `${color}B3` }} // ~70% opacity
        >
          {label}
        </span>
        <span className="text-[12px] text-white/35">
          No formats configured
        </span>
      </div>

      <span
        className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] text-white/50 transition-colors duration-150 group-hover:text-white/80"
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
