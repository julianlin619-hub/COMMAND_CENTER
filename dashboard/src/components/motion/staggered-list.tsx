"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const containerVariants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.05,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: "easeOut" as const },
  },
};

/** Staggered entrance container for card grids — renders as a div */
export function StaggeredContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** Staggered entrance item for card grids — renders as a div */
export function StaggeredItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div variants={itemVariants} className={className}>
      {children}
    </motion.div>
  );
}

/** Staggered entrance container for tables — renders as a tbody */
export function StaggeredTableBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.tbody
      data-slot="table-body"
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className={cn("[&_tr:last-child]:border-0", className)}
    >
      {children}
    </motion.tbody>
  );
}

/** Staggered entrance item for tables — renders as a tr */
export function StaggeredTableRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.tr
      data-slot="table-row"
      variants={itemVariants}
      className={cn(
        "border-b transition-colors hover:bg-muted/50",
        className
      )}
    >
      {children}
    </motion.tr>
  );
}
