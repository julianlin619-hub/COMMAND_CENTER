"use client";

/**
 * Live mono countdown for the overview page platform cards.
 *
 * Computes next cron fire via `getNextRun()` once the component mounts
 * (avoids hydration mismatch — server doesn't know the user's clock). Ticks
 * every 60s; digits crossfade on minute change via framer-motion so the
 * value doesn't flip abruptly.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getNextRun } from "@/lib/cron-schedule";

export function NextRunCountdown({ cronExpression }: { cronExpression: string }) {
  const [now, setNow] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  useEffect(() => {
    const compute = () => {
      setNow(Date.now());
      setTarget(getNextRun(cronExpression).getTime());
    };
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, [cronExpression]);

  if (now === null || target === null) {
    // Placeholder keeps card layout stable during SSR → client hydration.
    return <span className="text-[13px] font-medium tabular-nums opacity-0">—</span>;
  }

  const diff = Math.max(0, target - now);
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const text = `${hours}h ${String(minutes).padStart(2, "0")}m`;

  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[11px] text-[var(--muted-foreground)]">in</span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          // Monochrome to match the Strategy page — terracotta was the
          // home page's old single accent, dropped during the redesign so
          // the two pages read in the same calm vocabulary.
          className="text-[13px] font-medium tabular-nums"
          style={{ color: "var(--foreground)" }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
