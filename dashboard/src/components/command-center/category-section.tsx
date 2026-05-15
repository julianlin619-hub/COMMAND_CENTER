/*
 * CategorySection — a populated category. Renders the category band
 * (small colored rail + label + count) above a responsive grid of
 * FormatCards.
 *
 * Grid: `repeat(auto-fit, minmax(220px, 1fr))`. The `auto-fit` keyword
 * means a single card in a category will stretch to fill the row width
 * (rather than sitting at 220px on the left with empty space) — verifies
 * in the Written section, which currently has one card.
 */
import { FormatCard } from "./format-card";
import type { Format } from "@/lib/command-center-config";

interface CategorySectionProps {
  label: string;
  color: string;
  formats: Format[];
}

export function CategorySection({
  label,
  color,
  formats,
}: CategorySectionProps) {
  const count = formats.length;

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        {/* 3px × 14px colored rail — flush left of the label. */}
        <span
          aria-hidden
          className="h-[14px] w-[3px] rounded-sm"
          style={{ backgroundColor: color }}
        />
        <span
          className="text-[14px] font-medium"
          style={{ color }}
        >
          {label}
        </span>
        <span className="text-[12px] text-white/40">
          {count} {count === 1 ? "format" : "formats"}
        </span>
      </div>

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        {formats.map((f) => (
          <FormatCard key={f.id} format={f} color={color} />
        ))}
      </div>
    </section>
  );
}
