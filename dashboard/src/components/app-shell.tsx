"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/cron-logs", label: "Cron Jobs" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen">
      {/* Top navigation bar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Command Center
            </Link>
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "relative rounded-md px-3 py-1.5 text-sm transition-colors",
                      isActive
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="nav-active-indicator"
                        className="absolute inset-0 rounded-md bg-muted"
                        transition={{ type: "spring", stiffness: 500, damping: 35 }}
                      />
                    )}
                    <span className="relative z-10">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
          <UserButton />
        </div>
      </header>

      {/* Page content */}
      <main className="px-6 py-6">{children}</main>
    </div>
  );
}
