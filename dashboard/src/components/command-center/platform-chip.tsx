"use client";

/*
 * Platform chip — 30×30 rounded square showing a platform glyph tinted with
 * the parent category color. Lives inside FormatCard's "Publishes to" row.
 *
 * Why a local icon map instead of reusing `components/platform-icon.tsx`?
 * That component carries a deliberate "single-accent rule" (all glyphs in
 * terracotta) so the dashboard reads as one coherent surface. The Command
 * Center page intentionally breaks that rule — it tints icons by category
 * so the four buckets feel distinct. We keep the rules separate by
 * duplicating the (tiny) icon map here. The cost is one extra import per
 * new platform; the win is that the global single-accent contract stays
 * intact.
 *
 * Also: `FaXTwitter` for X is only available in react-icons/fa6, which is
 * why this codebase doesn't render an X glyph elsewhere yet.
 */
import {
  FaYoutube,
  FaInstagram,
  FaTiktok,
  FaXTwitter,
  FaLinkedinIn,
  FaThreads,
  FaFacebookF,
  FaSnapchat,
} from "react-icons/fa6";
import type { IconType } from "react-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PlatformId } from "@/lib/command-center-config";

const PLATFORM_GLYPHS: Record<PlatformId, IconType> = {
  youtube: FaYoutube,
  instagram: FaInstagram,
  tiktok: FaTiktok,
  x: FaXTwitter,
  linkedin: FaLinkedinIn,
  threads: FaThreads,
  facebook: FaFacebookF,
  snapchat: FaSnapchat,
};

interface PlatformChipProps {
  platformId: PlatformId;
  platformName: string;
  // Category color in hex (e.g. "#16B68A"). The chip derives its
  // background, hover background, and icon color from this single value
  // via hex alpha suffixes — keeping all four tints in lockstep without
  // a JS color library.
  color: string;
}

export function PlatformChip({
  platformId,
  platformName,
  color,
}: PlatformChipProps) {
  const Glyph = PLATFORM_GLYPHS[platformId];
  if (!Glyph) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        data-action="filter-platform"
        data-platform={platformId}
        onClick={(e) => {
          // Card root has its own click handler ("open format detail");
          // stop propagation so clicking a chip doesn't also fire it.
          e.stopPropagation();
        }}
        className="group/chip relative grid h-[30px] w-[30px] place-items-center rounded-[7px] transition-all duration-150 hover:-translate-y-px"
        style={{
          backgroundColor: `${color}14`, // ~8% opacity
          // Move the deeper hover tint and brighter icon into CSS-var land
          // so the inline-style block stays static (no React re-render on
          // hover) — :hover swaps the vars via the second style tag below.
          // We can't easily express "hover background = color + alpha 18%"
          // in pure Tailwind without an arbitrary value per chip, so we
          // do it with a style attribute + inline :hover via group state.
          color: `${color}D9`, // ~85% — icon color via currentColor
        }}
      >
        {/* Hover overlay: deeper tint fades in on chip hover. Using an
            absolute overlay keeps the base background stable and avoids
            re-rendering inline styles via state. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[7px] opacity-0 transition-opacity duration-150 group-hover/chip:opacity-100"
          style={{ backgroundColor: `${color}1A` }} // additional ~10% → total ~18%
        />
        <Glyph
          className="relative h-[14px] w-[14px] transition-colors duration-150 group-hover/chip:[color:var(--chip-hover-color)]"
          style={{ ["--chip-hover-color" as never]: color }}
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{platformName}</TooltipContent>
    </Tooltip>
  );
}
