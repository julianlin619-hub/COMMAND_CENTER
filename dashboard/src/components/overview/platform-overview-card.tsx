"use client";

/**
 * Overview page — platform card.
 *
 * Visual direction: warm near-black surface + terracotta accent strip + three
 * zones (identity → description → next-run), with a deeper-tint footer drawer
 * for the Buffer queue count. Hover raises the card and glows terracotta.
 *
 * Data flows in from the server page — this component is presentational plus
 * a live minute-tick for the countdown.
 */

import { ChevronRight } from "lucide-react";
import {
  FaFacebookF,
  FaInstagram,
  FaThreads,
  FaTiktok,
  FaYoutube,
} from "react-icons/fa6";
import { NextRunCountdown } from "./next-run-countdown";
import { StatusPill, type OverviewStatus } from "./status-pill";

/* Platform-key → react-icons mapping. Only covers active platforms; inactive
   (YouTube, LinkedIn) are rendered by a separate card component below. */
const ACTIVE_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  threads: FaThreads,
  "instagram-2nd": FaInstagram,
  tiktok: FaTiktok,
  facebook: FaFacebookF,
  instagram: FaInstagram,
  "youtube-second": FaYoutube,
};

interface PlatformOverviewCardProps {
  platformKey: string;
  label: string;
  description: string;
  status: OverviewStatus;
  scheduleDescription: string | null;
  cronExpression: string | null;
  bufferQueue: number | null;
  bufferQueueLabel?: string;
  index: number;
}

export function PlatformOverviewCard({
  platformKey,
  label,
  description,
  status,
  scheduleDescription,
  cronExpression,
  bufferQueue,
  bufferQueueLabel = "Scheduled to Buffer",
  index,
}: PlatformOverviewCardProps) {
  const Icon = ACTIVE_ICONS[platformKey] ?? FaInstagram;

  return (
    <div
      className="card-shell group relative overflow-hidden rounded-xl border transition-transform duration-200 ease-out hover:-translate-y-0.5"
      style={{
        backgroundColor: "var(--card-warm-bg)",
        borderColor: "var(--card-warm-border)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 24px -16px rgba(0,0,0,0.5)",
      }}
    >
      {/* Terracotta accent strip — draws in left→right on mount, staggered by index. */}
      <div
        aria-hidden
        className="anim-accent-draw absolute inset-x-0 top-0 h-[2px] origin-left"
        style={{
          backgroundColor: "var(--terracotta)",
          animation: `accent-draw 500ms cubic-bezier(0.16, 1, 0.3, 1) ${
            350 + index * 50
          }ms backwards`,
          transform: "scaleX(0)",
        }}
      />

      {/* Hover glow overlay — pure CSS so it fires even inside a <Link>. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          boxShadow:
            "0 16px 40px -16px rgba(174,86,48,0.55), 0 0 0 1px rgba(174,86,48,0.22)",
        }}
      />

      {/* Body */}
      <div className="px-5 pt-4 pb-4 relative">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex items-center justify-center h-7 w-7 rounded-lg border"
              style={{
                backgroundColor: "rgba(174,86,48,0.09)",
                borderColor: "rgba(174,86,48,0.19)",
              }}
            >
              <Icon
                className="h-[14px] w-[14px]"
                style={{ color: "var(--terracotta)" }}
              />
            </span>
            <h3 className="text-[16px] font-semibold tracking-[-0.01em] leading-none text-[var(--overview-fg)]">
              {label}
            </h3>
          </div>
          <StatusPill status={status} />
        </div>

        <p className="text-[13px] leading-[1.65] text-[var(--overview-fg)]/50 whitespace-pre-line mb-4">
          {description}
        </p>

        <div className="flex items-baseline gap-3">
          <span className="text-[10px] font-medium tracking-[0.14em] uppercase text-[var(--overview-fg)]/40 shrink-0">
            Next run
          </span>
          {cronExpression && scheduleDescription ? (
            <div
              className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono"
            >
              <span className="text-[12px] text-[var(--overview-fg)]/55">
                {scheduleDescription}
              </span>
              <NextRunCountdown cronExpression={cronExpression} />
            </div>
          ) : (
            <span className="text-[13px] text-[var(--overview-fg)]/30">—</span>
          )}
        </div>
      </div>

      {/* Footer drawer — deeper tint + top border, Buffer queue + chevron. */}
      <div
        className="flex items-center justify-between px-5 py-3 border-t relative"
        style={{
          backgroundColor: "var(--drawer-bg)",
          borderColor: "var(--drawer-border)",
        }}
      >
        {bufferQueue !== null ? (
          <div className="flex items-center gap-2 text-[12px] text-[var(--overview-fg)]/55">
            <span>{bufferQueueLabel}</span>
            <span
              className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-md text-[11px] font-medium font-mono"
              style={{
                backgroundColor: "rgba(174,86,48,0.13)",
                color: "var(--terracotta)",
              }}
            >
              {bufferQueue}
            </span>
          </div>
        ) : (
          <span />
        )}
        <ChevronRight
          className="h-[15px] w-[15px] text-[var(--overview-fg)]/30 transition-transform duration-150 group-hover:translate-x-[3px]"
        />
      </div>
    </div>
  );
}

