"use client";

import { motion, AnimatePresence } from "framer-motion";

/** Simple fade + slide entrance for a single element */
export function FadeIn({
  children,
  className,
  direction = "up",
  duration = 0.3,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  direction?: "up" | "down" | "none";
  duration?: number;
  delay?: number;
}) {
  const y = direction === "up" ? 8 : direction === "down" ? -8 : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** AnimatePresence wrapper for conditional content with fade enter/exit */
export function FadeInPresence({
  children,
  show,
  className,
}: {
  children: React.ReactNode;
  show: boolean;
  className?: string;
}) {
  return (
    <AnimatePresence mode="wait">
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
