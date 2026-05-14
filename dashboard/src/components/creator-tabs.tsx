"use client";

import Link from "next/link";
import { useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { CronTestRunButton } from "@/components/cron-test-run-button";
import { PlatformOverviewCard } from "@/components/overview/platform-overview-card";
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
  bufferQueue: number | null;
  bufferQueueLabel: string | undefined;
  href?: string;
}

const CREATORS: Record<CreatorKey, { label: string }> = {
  alex: { label: "Alex" },
  leila: { label: "Leila" },
};

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

  const liveCount = visible.filter((s) => s.status === "healthy").length;
  const pausedCount = visible.filter((s) => s.status === "paused").length;
  const pendingCount = visible.filter((s) => s.status === "pending").length;
  const failingCount = visible.filter((s) => s.status === "failing").length;

  const statusLine = [
    `${liveCount} live`,
    pausedCount > 0 ? `${pausedCount} paused` : null,
    pendingCount > 0 ? `${pendingCount} pending` : null,
    failingCount > 0 ? `${failingCount} failing` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <header className="flex items-start justify-between mb-12">
        <div>
          {/* Top row: Command Center brand mark + Strategy peer-nav link
              sitting tightly to its right. The status subtitle below is
              intentionally attached to Command Center only — Strategy is
              a separate destination, not a status target. */}
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 w-fit">
              <span className="text-[12px] font-semibold tracking-[0.22em] uppercase text-[var(--overview-fg)]/90">
                Command Center
              </span>
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{ backgroundColor: "var(--terracotta)" }}
              />
            </Link>
            <Link
              href="/strategy"
              className="text-[12px] font-semibold tracking-[0.22em] uppercase text-[var(--overview-fg)]/55 hover:text-[var(--overview-fg)] transition-colors"
            >
              Strategy →
            </Link>
          </div>
          <div className="flex items-center gap-2 mt-2 text-[11px] text-[var(--overview-fg)]/45 font-mono">
            <span className="inline-block h-[7px] w-[7px] rounded-full relative bg-[var(--overview-fg)]/70">
              <span
                className="anim-heartbeat absolute inset-0 rounded-full bg-[var(--overview-fg)]/70"
                style={{ animation: "heartbeat 4.5s ease-out infinite" }}
              />
            </span>
            <span>{statusLine}</span>
          </div>
        </div>

        <UserButton />
      </header>

      <div className="flex items-center gap-4 mb-6">
        <span className="text-[11px] font-medium tracking-[0.18em] uppercase text-[var(--overview-fg)]/40">
          Creator
        </span>
        <div
          className="inline-flex items-center gap-1 p-1 rounded-lg"
          style={{ backgroundColor: "rgba(255,255,255,0.03)" }}
        >
          {creatorKeys.map((key) => {
            const isSelected = selected === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(key)}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors"
                style={
                  isSelected
                    ? {
                        backgroundColor: "var(--overview-fg)",
                        color: "var(--overview-bg)",
                      }
                    : {
                        backgroundColor: "#27272a",
                        color: "var(--overview-fg)",
                      }
                }
              >
                {CREATORS[key].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-end justify-between mb-6">
        <SectionLabel tone="primary">Platforms</SectionLabel>
        <CronTestRunButton
          triggerLabel="Run all crons"
          triggerClassName="gap-1.5 text-white border-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-transform duration-100 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
          triggerStyle={{
            backgroundImage:
              "linear-gradient(180deg, var(--terracotta-hover), var(--terracotta))",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.15), 0 6px 16px -8px rgba(174,86,48,0.55), 0 2px 4px -2px rgba(0,0,0,0.3)",
          }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {visible.map((s, i) => (
          <Link key={s.key} href={s.href ?? `/${s.key}`} className="block">
            <PlatformOverviewCard
              platformKey={s.key}
              label={s.label}
              description={s.description}
              status={s.status}
              scheduleDescription={s.scheduleDescription}
              cronExpression={s.cronExpression}
              paused={s.paused}
              bufferQueue={s.bufferQueue}
              bufferQueueLabel={s.bufferQueueLabel}
              index={i}
            />
          </Link>
        ))}
      </div>
    </>
  );
}

function SectionLabel({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "primary" | "muted";
}) {
  const primary = tone === "primary";
  return (
    <div className="flex items-center gap-3">
      <span
        className="h-5 w-[3px] rounded-full"
        style={{
          backgroundColor: "var(--terracotta)",
          opacity: primary ? 1 : 0.35,
        }}
      />
      <span
        className={`text-[11px] font-medium tracking-[0.18em] uppercase ${
          primary
            ? "text-[var(--overview-fg)]/75"
            : "text-[var(--overview-fg)]/40"
        }`}
      >
        {children}
      </span>
    </div>
  );
}
