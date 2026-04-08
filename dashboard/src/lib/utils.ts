import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * `cn()` — a utility for merging Tailwind CSS class names intelligently.
 *
 * It combines two libraries:
 *   1. `clsx` — conditionally joins class names together (handles strings,
 *      objects, arrays, falsy values, etc.)
 *   2. `twMerge` — resolves Tailwind class conflicts so the last one wins.
 *      For example: cn("p-2", "p-4") => "p-4" (not "p-2 p-4")
 *      Without twMerge, both classes would apply and the result would depend
 *      on CSS source order, which is unpredictable with Tailwind.
 *
 * Usage examples:
 *   cn("px-4 py-2", isActive && "bg-blue-500")  // conditional class
 *   cn("text-sm", className)                      // merge with prop
 *   cn("p-2", "p-4")                             // conflict resolved to "p-4"
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
