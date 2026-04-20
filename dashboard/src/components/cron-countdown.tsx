"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CRON_SCHEDULES,
  formatCountdownParts,
  getNextRun,
} from "@/lib/cron-schedule";
import { cn } from "@/lib/utils";

/**
 * Live-ticking countdown to the next cron run for a given platform.
 * Re-computes the target `nextRun` whenever the current value is reached
 * (so after a cron fires we immediately roll to the following day).
 */
export function CronCountdown({ platform }: { platform: string }) {
  const config = CRON_SCHEDULES[platform];

  // Tick every 30s — display granularity is a minute, so no need for 1Hz.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!config) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [config]);

  // Recompute target whenever the previous one has elapsed. Memo on the
  // minute bucket so we don't recompute 60× per minute.
  const minuteBucket = Math.floor(now / 60_000);
  const nextRun = useMemo(() => {
    return config ? getNextRun(config.schedule) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, minuteBucket]);

  if (!config || !nextRun) {
    return (
      <div className="text-sm">
        <span className="text-muted-foreground">Next run </span>
        <span className="text-muted-foreground">—</span>
      </div>
    );
  }

  const remainingMs = nextRun.getTime() - now;
  const { h, m } = formatCountdownParts(remainingMs);
  const urgent = remainingMs < 60 * 60 * 1000; // under 1h → accent color

  return (
    <div className="text-sm">
      <span className="text-muted-foreground">
        Next run: {config.description}, in{" "}
      </span>
      <span
        className={cn(
          "font-medium tabular-nums",
          urgent ? "text-[#ae5630]" : "text-foreground"
        )}
      >
        {h}h {m}m
      </span>
    </div>
  );
}
