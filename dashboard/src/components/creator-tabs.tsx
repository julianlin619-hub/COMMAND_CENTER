"use client";

/**
 * Command Center home — grid of platform queue cards.
 *
 * Each card surfaces "how much content is staged" via a tank-style row of
 * 8 vertical bars (filled vs dimmed), plus a textual count. A 2px pulse
 * accent bar at the top of every live card shimmers left→right via
 * framer-motion; paused cards render the bar as a static muted strip and
 * dim the whole card to ~45% opacity.
 *
 * Click a card → its detail page (where full timestamps, next-run
 * countdown, and pathway history live). Cards themselves are intentionally
 * action-free surfaces.
 */

import Link from "next/link";
import { useState } from "react";
import { motion } from "framer-motion";
import { UserButton } from "@clerk/nextjs";
import {
  FaFacebookF,
  FaInstagram,
  FaLinkedinIn,
  FaThreads,
  FaTiktok,
  FaYoutube,
} from "react-icons/fa6";
import { CronTestRunButton } from "@/components/cron-test-run-button";
import type { OverviewStatus } from "@/components/overview/status-pill";

type CreatorKey = "alex" | "leila";

export interface PlatformSummary {
  key: string;
  creator: CreatorKey;
  label: string;
  description: string;
  status: OverviewStatus;
  scheduleDescription: string | null;
  cronExpression: string | null;
  paused: boolean;
  /** Number of posts currently queued / recently sent to Buffer in the
   *  last 24h. Drives the card's tank-bar visualization. */
  queueCount: number;
  href?: string;
}

const CREATORS: Record<CreatorKey, { label: string }> = {
  alex: { label: "Alex" },
  leila: { label: "Leila" },
};

/* Platform key → brand icon. fa6 ships solid glyphs, so we render them
   small (16px) and in the muted-foreground color to read as quiet line
   marks rather than chrome. */
const PLATFORM_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  threads: FaThreads,
  tiktok: FaTiktok,
  facebook: FaFacebookF,
  linkedin: FaLinkedinIn,
  instagram: FaInstagram,
  "instagram-2nd": FaInstagram,
  youtube: FaYoutube,
  "youtube-second": FaYoutube,
  "leila-threads": FaThreads,
  "leila-linkedin": FaLinkedinIn,
};

/* Per-platform accent color — pulled from the Strategy page's source
   palette (coral/purple/teal/gray) plus the dashboard's terracotta
   primary. Grouping rationale:
     - Coral  → short-form video pipelines (TikTok, Instagram reels)
     - Purple → text-social repost (Threads, both creators)
     - Teal   → business-text repost (LinkedIn, both creators)
     - Gray   → quote-card derivatives (Facebook)
     - Terracotta → long-form video (YouTube)
   This gives the card grid a calm-but-distinct palette where each
   creator's column visually telegraphs the kind of content shipping. */
const PLATFORM_ACCENTS: Record<string, string> = {
  threads: "#7F77DD",          // Purple
  "leila-threads": "#7F77DD",  // Purple
  tiktok: "#D85A30",           // Coral
  instagram: "#D85A30",        // Coral
  "instagram-2nd": "#D85A30",  // Coral
  facebook: "#888780",         // Gray
  linkedin: "#1D9E75",         // Teal
  "leila-linkedin": "#1D9E75", // Teal
  youtube: "var(--terracotta)",
  "youtube-second": "var(--terracotta)",
};

/* Resolves an accent for the given platform, falling back to terracotta
   if a new entry shows up before we've mapped it. */
function getAccent(key: string): string {
  return PLATFORM_ACCENTS[key] ?? "var(--terracotta)";
}

/* Extracts an inline tag from labels like "Instagram (main)" →
   { name: "Instagram", tag: "main" }. Falls back to no-tag when the
   label has no parenthetical. */
function splitLabel(label: string): { name: string; tag: string | null } {
  const m = label.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!m) return { name: label, tag: null };
  return { name: m[1].trim(), tag: m[2].trim() };
}

// How many bars the tank displays. 8 is enough to show meaningful
// gradation for a daily-cron-sized batch (most pipelines produce 1-24
// posts/day); past 8 we just cap the visual and let the integer count
// carry the truth.
const MAX_BARS = 8;
// Below this, the queue gets a "· low" hint — gentle nudge that the
// operator should think about feeding the pipeline.
const LOW_THRESHOLD = 3;

interface CreatorTabsProps {
  summaries: PlatformSummary[];
  defaultCreator?: CreatorKey;
}

export function CreatorTabs({
  summaries,
  defaultCreator,
}: CreatorTabsProps) {
  const creatorKeys = Object.keys(CREATORS) as CreatorKey[];
  const [selected, setSelected] = useState<CreatorKey>(
    defaultCreator ?? "alex",
  );

  const visible = summaries.filter((s) => s.creator === selected);

  // Active cards first, paused at the bottom. Paused recede via opacity
  // on the card itself — the sort just ensures the eye lands on live
  // pipelines first when scanning top-to-bottom.
  const activeRows = visible.filter((s) => !s.paused);
  const pausedRows = visible.filter((s) => s.paused);

  const liveCount = activeRows.filter((s) => s.status === "healthy").length;
  const pausedCount = pausedRows.length;

  return (
    <>
      {/* Top utility row — kept tiny so the main header below can match
          the spec's "title + status + toggle + run-all" shape exactly.
          The Strategy link that used to live here was moved to the new
          Command Center home (/) since this /overview view is being
          deprecated. */}
      <div className="flex items-center justify-end mb-6">
        <UserButton />
      </div>

      {/* Main header — title + inline status summary on the left; creator
          toggle and Run all on the right. */}
      <header className="flex items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-[18px] font-medium text-[var(--foreground)]">
            Command Center
          </h1>
          {/* Tiny static indicator — the per-card pulse bars handle the
              live/animation signal, so this stays a quiet dot. Color is
              terracotta (the dashboard primary) to match the strategy
              page's palette — no green elsewhere on the page. */}
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--foreground)]">
            <span
              className="h-[6px] w-[6px] rounded-full"
              style={{ backgroundColor: "var(--terracotta)" }}
            />
            <span>{liveCount} live</span>
          </span>
          <span aria-hidden className="text-[var(--muted-foreground)]">
            ·
          </span>
          <span className="text-[12px] text-[var(--muted-foreground)]">
            {pausedCount} paused
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="inline-flex items-center gap-1 p-[3px] rounded-[6px] border-[0.5px]"
            style={{
              backgroundColor: "var(--card)",
              borderColor: "var(--border)",
            }}
          >
            {creatorKeys.map((key) => {
              const isSelected = selected === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  className="px-2.5 py-[3px] rounded-[4px] text-[11px] font-medium transition-colors"
                  style={
                    isSelected
                      ? {
                          backgroundColor: "var(--foreground)",
                          color: "var(--background)",
                        }
                      : {
                          backgroundColor: "transparent",
                          color: "var(--muted-foreground)",
                        }
                  }
                >
                  {CREATORS[key].label}
                </button>
              );
            })}
          </div>

          <CronTestRunButton
            triggerLabel="Run all"
            triggerClassName="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--foreground)] rounded-[6px] border-[0.5px] px-2.5 h-[28px] hover:opacity-90 transition-opacity disabled:opacity-50"
            triggerStyle={{
              borderColor: "var(--border)",
              backgroundColor: "var(--card)",
            }}
          />
        </div>
      </header>

      {/* Card grid — 3 cols desktop, 2 tablet, 1 mobile, 10px gap. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[10px]">
        {[...activeRows, ...pausedRows].map((s) => (
          <PlatformCard key={s.key} summary={s} />
        ))}
      </div>
    </>
  );
}

function PlatformCard({ summary }: { summary: PlatformSummary }) {
  const Icon = PLATFORM_ICONS[summary.key] ?? FaInstagram;
  const { name, tag } = splitLabel(summary.label);
  const href = summary.href ?? `/${summary.key}`;
  const isPaused = summary.paused;
  const queueCount = summary.queueCount;
  const accent = getAccent(summary.key);

  const filledBars = Math.min(queueCount, MAX_BARS);
  const isEmpty = queueCount === 0;
  const isLow = !isEmpty && queueCount < LOW_THRESHOLD;

  // Coral (#D85A30) — same hue used by the Strategy page's "Live" source —
  // serves as our "needs attention" tone when the queue is empty. Keeps
  // the palette to the same five colors and reads as a soft warning
  // without introducing amber/red from outside the system.
  const warningColor = "#D85A30";

  return (
    <Link
      href={href}
      className="relative flex flex-col rounded-[8px] border-[0.5px] overflow-hidden transition-colors hover:bg-white/[0.02]"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--card)",
        minHeight: "130px",
        opacity: isPaused ? 0.45 : 1,
      }}
    >
      {/* Pulse accent — flush to top edge, full width. Live cards get a
          shimmer that loops 2.4s in the platform's accent color; paused
          cards get a static muted strip. */}
      <PulseBar paused={isPaused} color={accent} />

      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        {/* Header — icon takes the platform's accent at low opacity (so
            the brand reads as a quiet tint rather than full-saturation
            chrome), name uses foreground, optional tag pill is muted.
            The icon is wrapped in a span because react-icons types only
            expose className; the SVG glyph inherits color from the
            wrapping span via currentColor. */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex shrink-0"
            style={{ color: accent, opacity: 0.85 }}
          >
            <Icon className="h-[16px] w-[16px]" />
          </span>
          <span className="text-[13px] font-medium text-[var(--foreground)] truncate">
            {name}
          </span>
          {tag ? (
            <span
              className="text-[10px] font-medium px-1.5 py-[1px] rounded-[3px] shrink-0"
              style={{
                backgroundColor: "var(--muted)",
                color: "var(--muted-foreground)",
              }}
            >
              {tag}
            </span>
          ) : null}
        </div>

        {/* Queue tank — 8 vertical bars. Filled bars use the platform's
            accent at 85% opacity; empty slots use muted-foreground at
            28% so they recede without disappearing. */}
        <div className="flex items-end gap-[3px]">
          {Array.from({ length: MAX_BARS }).map((_, i) => {
            const filled = i < filledBars;
            return (
              <span
                key={i}
                className="rounded-[1px]"
                style={{
                  width: "5px",
                  height: "18px",
                  backgroundColor: filled ? accent : "var(--muted-foreground)",
                  opacity: filled ? 0.85 : 0.28,
                }}
              />
            );
          })}
        </div>

        {/* Count + state hint. Empty queue flips the count to coral
            (palette-internal warning tone) with a "needs content" nudge;
            sub-threshold gets a quieter "· low" nudge in muted text. */}
        <div className="flex items-baseline gap-1.5">
          <span
            className="text-[15px] font-medium"
            style={{
              color: isEmpty ? warningColor : "var(--foreground)",
            }}
          >
            {queueCount}
          </span>
          <span className="text-[12px] text-[var(--muted-foreground)]">
            queued
          </span>
          {isLow && (
            <span className="text-[12px] text-[var(--muted-foreground)]">
              · low
            </span>
          )}
          {isEmpty && (
            <span
              className="text-[12px]"
              style={{ color: warningColor, opacity: 0.75 }}
            >
              · needs content
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

/* The 2px top-of-card accent. Live cards softly breathe — the whole bar
   fades between ~50% and ~90% opacity on a slow ease-in-out loop. No
   traveling highlight; an opacity-only pulse reads as "alive" without
   competing for the eye the way a moving shimmer did. Paused cards
   render the same height bar in muted-foreground at low static opacity. */
function PulseBar({ paused, color }: { paused: boolean; color: string }) {
  if (paused) {
    return (
      <div
        className="h-[2px] w-full"
        style={{
          backgroundColor: "var(--muted-foreground)",
          opacity: 0.3,
        }}
      />
    );
  }
  return (
    <motion.div
      className="h-[2px] w-full"
      style={{ backgroundColor: color }}
      // Three keyframes (mid-low-mid) give a soft "in-out" breath rather
      // than the abrupt restart you'd get from a 2-keyframe loop. 3.6s is
      // slow enough to read as ambient — fast enough to register as alive.
      animate={{ opacity: [0.85, 0.45, 0.85] }}
      transition={{
        duration: 3.6,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}
