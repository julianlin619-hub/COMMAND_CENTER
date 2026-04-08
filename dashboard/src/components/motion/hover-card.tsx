"use client";

import { motion } from "framer-motion";

/** Subtle hover lift + scale for cards */
export function HoverCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -2, scale: 1.01 }}
      transition={{ type: "tween", duration: 0.15 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
