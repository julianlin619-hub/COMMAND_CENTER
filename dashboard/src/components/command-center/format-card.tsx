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
 *   The root is a role="button" <div> with data-action="open-format". When
 *   `format.href` is set, click/Enter/Space navigate via router.push (see
 *   `open()` below). When `href` is absent the card is fully disabled — no
 *   handler, no button role, no focus ring — so AT users aren't told they
 *   can activate something that does nothing. The data-action attribute
 *   is preserved so any future event delegation can still pick up the
 *   card without threading onClick props through every wrapper.
 *
 *   Chips are independent click targets and stop propagation so they don't
 *   also fire the card's open handler. See platform-chip.tsx.
 */
import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { PlatformChip } from "./platform-chip";
import { HealthPill } from "./health-pill";
import type { Format, FormatHealth } from "@/lib/command-center-config";

interface FormatCardProps {
  format: Format;
  color: string;
  // Resolved at request-time on the home page from a single 24h posts
  // query — see lib/format-health.ts. Required so every card on the
  // page renders a pill (the absence of a pill would itself read as a
  // signal, which we don't want).
  health: FormatHealth;
}

export function FormatCard({ format, color, health }: FormatCardProps) {
  const isLive = format.status === "live";
  const router = useRouter();

  // A format is "disabled" when it has no detail destination wired up yet.
  // Rather than render a card that looks identical to its siblings but
  // does nothing on click, we grey the surface out so the missing
  // affordance is honest. Any format gains its normal active styling the
  // moment we set an `href` on it in command-center-config.ts.
  const isDisabled = !format.href;

  // A format is "muted" when its underlying cron is intentionally
  // suspended at the infra layer but the detail page still works — e.g.
  // the youtube-second-cron is commented out in render.yaml but
  // /youtube-second still renders the last batch the cron scheduled.
  // We want the card to read as inactive (lower opacity) while staying
  // clickable, which is different from fully disabled (no href, no
  // click). Live and href-less formats both bypass this state.
  const isMuted = !isLive && !isDisabled;

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
          : `cursor-pointer focus-visible:ring-2 focus-visible:ring-white/20 active:scale-[0.995] ${
              // Muted = paused-with-href. Dim the surface enough to read
              // as inactive, but stay above the fully-disabled opacity
              // (45%) so the user can still tell the card is reachable.
              isMuted ? "opacity-60" : ""
            }`
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
          {/* Right-edge cluster: health pill sits always-visible at the
              top-right corner, with the hover arrow tucked to its left
              for clickable cards. The arrow keeps fading in on hover
              (existing affordance) and the pill anchors the corner so
              the layout doesn't jump as the arrow appears. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {!isDisabled && (
              <ArrowUpRight
                aria-hidden
                className="h-4 w-4 text-white/40 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              />
            )}
            <HealthPill status={health} />
          </div>
        </div>

        {/* Flex spacer — pushes chip row to bottom */}
        <div className="flex-1" />

        {/* Platform section — hidden entirely when a format has no
            destinations yet (placeholder cards like L1 Q&A). Rendering
            the "PUBLISHES TO" eyebrow above an empty chip row reads as
            broken rather than aspirational, so we just drop the block. */}
        {format.platforms.length > 0 && (
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
        )}
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
