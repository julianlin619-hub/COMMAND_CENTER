"use client";

/*
 * Format card — one tile per content format inside a CategorySection.
 *
 * Anatomy (top-to-bottom) — matches the refined-terracotta mock:
 *   1. Header row: name + subtitle on the left, HealthPill on the right.
 *   2. Flex spacer pushes the chip row to the bottom of the card so all
 *      cards in a row align their footers regardless of subtitle length.
 *   3. A row of plain text platform chips (no icons, no "Publishes to"
 *      eyebrow).
 *   The surface itself (gradient + warm border + hover lift + left accent
 *   rail) is the shared .cc-surface / .cc-surface--interactive treatment;
 *   there is no top pulse-bar or hover arrow.
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
 *   Chips are now non-interactive text spans, so the card root is the
 *   single click target (no nested interactive elements to coordinate).
 */
import { useRouter } from "next/navigation";
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
  // suspended at the infra layer but the detail page still works.
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
    // Card root is a <div role="button"> rather than a <button>. (Kept as a
    // div for parity with the rest of the grid and so future nested
    // affordances don't require restructuring.) When disabled the
    // role/tabIndex are dropped so AT users don't get a "button"
    // announcement that wouldn't activate, and the cursor / focus ring
    // switch off.
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
      className={`format-card cc-surface group relative flex min-h-[152px] flex-col overflow-hidden text-left outline-none ${
        isDisabled
          ? "cursor-default opacity-45"
          : `cc-surface--interactive cursor-pointer focus-visible:ring-2 focus-visible:ring-white/20 ${
              // Muted = paused-with-href. Dim the surface enough to read
              // as inactive, but stay above the fully-disabled opacity
              // (45%) so the user can still tell the card is reachable.
              isMuted ? "opacity-60" : ""
            }`
      }`}
      // The category color drives the left accent rail that the
      // .cc-surface--interactive hover reveals — keeps each bucket's
      // identity present even on the shared card chrome. borderRadius is
      // pinned to the mock's 18px (overriding cc-surface's default radius).
      style={
        {
          ["--accent-rail" as never]: color,
          borderRadius: "18px",
        } as React.CSSProperties
      }
    >
      {/* Padding + vertical rhythm match the mock card (20px sides /
          18px bottom, 16px internal gap). The hover lift + left accent
          rail come from .cc-surface--interactive (driven by --accent-rail
          above) — there's no top pulse-bar or hover arrow here, matching
          the refined-terracotta sample exactly. */}
      <div className="flex flex-1 flex-col gap-4 px-5 pb-[18px] pt-5">
        {/* Header row: name + subtitle on the left, health pill top-right. */}
        <div className="flex items-start justify-between gap-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-[#edeae0]">
              {format.name}
            </div>
            <div className="mt-[3px] text-[13px] leading-snug text-[rgba(237,234,224,0.58)]">
              {format.subtitle}
            </div>
          </div>
          <HealthPill status={health} />
        </div>

        {/* Flex spacer — pushes the chip row to the bottom so footers
            align across cards of differing subtitle length. */}
        <div className="flex-1" />

        {/* Platform chips — plain text labels (no icons, no "Publishes to"
            eyebrow), matching the mock. Hidden entirely when a format has
            no destinations yet (placeholder cards like L1 Q&A) so we don't
            render an empty row. Chips are non-interactive spans now, so the
            card root is the only click target. */}
        {format.platforms.length > 0 && (
          <div className="flex flex-wrap gap-[7px]">
            {format.platforms.map((p) => (
              <span
                key={p.id}
                className="rounded-lg border px-2.5 py-1 text-[11.5px] font-medium text-[rgba(237,234,224,0.58)]"
                style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  borderColor: "var(--surface-border)",
                }}
              >
                {p.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
