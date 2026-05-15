"use client";

/*
 * Format card — one tile per content format inside a CategorySection.
 *
 * Anatomy (top-to-bottom):
 *   1. Pulse bar (2px, top edge). Live → animated shimmer. Paused → static
 *      muted bar. Thickens to 3px on card hover.
 *   2. Header row: name + subtitle on the left, ↗ arrow on the right (fades
 *      in on hover only — keeps the card surface calm at rest).
 *   3. Flex spacer pushes the chip row to the bottom of the card so all
 *      cards in a row align their footers regardless of subtitle length.
 *   4. "Publishes to" eyebrow + row of PlatformChips.
 *
 * Click model:
 *   The root is a <button> with data-action="open-format" so future code can
 *   wire navigation by listening for the data-action attribute (instead of
 *   threading onClick props through every component). For now the onClick
 *   is a no-op — the format detail view doesn't exist yet.
 *
 *   Chips are independent click targets and stop propagation so they don't
 *   also fire the card's open handler. See platform-chip.tsx.
 */
import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { PlatformChip } from "./platform-chip";
import type { Format } from "@/lib/command-center-config";

interface FormatCardProps {
  format: Format;
  color: string;
}

export function FormatCard({ format, color }: FormatCardProps) {
  const isLive = format.status === "live";
  const router = useRouter();

  // A format is "disabled" when it has no detail destination wired up yet.
  // Rather than render a card that looks identical to its siblings but
  // does nothing on click, we grey the surface out so the missing
  // affordance is honest. Any format gains its normal active styling the
  // moment we set an `href` on it in command-center-config.ts.
  const isDisabled = !format.href;

  // Programmatic navigation (not a wrapping <Link>) because the card root
  // is already role="button" and contains nested chip <button>s. Using
  // router.push keeps the existing keyboard + click handlers identical for
  // both states (no href => no-op, href => navigate).
  const open = () => {
    if (format.href) router.push(format.href);
  };

  return (
    // Card root is a <div role="button"> rather than a <button>. The card
    // contains chip <button>s (platform tooltip triggers), and HTML
    // disallows nesting interactive elements inside a <button>. The
    // accessibility tradeoff is acceptable here because chips need to be
    // independent click targets — wrapping the whole card in a button
    // would force tooltips and chips into a single hit zone.
    //
    // When disabled the role/tabIndex are dropped so AT users don't get a
    // "button" announcement that wouldn't activate, and the cursor /
    // active scale / focus ring all switch off.
    <div
      role={isDisabled ? undefined : "button"}
      tabIndex={isDisabled ? undefined : 0}
      aria-disabled={isDisabled || undefined}
      data-action="open-format"
      data-format-id={format.id}
      onClick={isDisabled ? undefined : open}
      onKeyDown={
        isDisabled
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
      }
      className={`format-card group relative flex min-h-[140px] flex-col overflow-hidden rounded-xl text-left transition-all duration-150 outline-none ${
        isDisabled
          ? "cursor-default opacity-45"
          : "cursor-pointer focus-visible:ring-2 focus-visible:ring-white/20 active:scale-[0.995]"
      }`}
      style={{
        backgroundColor: "#161513",
        border: "0.5px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Pulse bar — flush to top edge, full width. The animated variant
          uses a CSS gradient sweep defined in globals.css (.pulse-sweep).
          The paused variant is a flat muted bar with no animation. */}
      <span
        aria-hidden
        className={`pulse-bar absolute inset-x-0 top-0 h-[2px] transition-[height] duration-150 group-hover:h-[3px] ${
          isLive ? "pulse-sweep" : ""
        }`}
        style={
          isLive
            ? ({ ["--pulse-color" as never]: color } as React.CSSProperties)
            : { backgroundColor: `${color}40` } // ~25% opacity for paused
        }
      />

      <div className="flex flex-1 flex-col gap-3 px-4 pb-4 pt-5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium leading-tight text-[#edeae0]">
              {format.name}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-white/55">
              {format.subtitle}
            </div>
          </div>
          {!isDisabled && (
            <ArrowUpRight
              aria-hidden
              className="h-4 w-4 shrink-0 text-white/40 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            />
          )}
        </div>

        {/* Flex spacer — pushes chip row to bottom */}
        <div className="flex-1" />

        {/* Platform section */}
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-white/40">
            Publishes to
          </div>
          <div className="flex flex-wrap gap-1.5">
            {format.platforms.map((p) => (
              <PlatformChip
                key={p.id}
                platformId={p.id}
                platformName={p.name}
                color={color}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Hover state for the surface — implemented as an absolute overlay
          so we don't need to swap inline styles (which would cause
          per-hover React re-renders). globals.css applies the border
          warming via .format-card:hover. Skipped when disabled so the
          greyed-out card never lights up on hover. */}
      {!isDisabled && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{
            backgroundColor: "rgba(255,255,255,0.015)",
            boxShadow: `inset 0 0 0 0.5px ${color}40`,
          }}
        />
      )}
    </div>
  );
}
