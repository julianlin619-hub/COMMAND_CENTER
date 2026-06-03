"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

// Top-level nav groups. Each group has a label and a list of pages.
// Clicking the group label navigates to the first page in that group.
const NAV_ITEMS = [
  { label: "Home", href: "/" },
  { label: "Manual Upload", href: "/manual-upload" },
  { label: "Posts", href: "/posts" },
  { label: "YouTube", href: "/youtube" },
] as const;

/**
 * Shell for every detail page. Matches the home page's header language:
 * wordmark + terracotta dot on the left, nav links in the middle,
 * UserButton on the right.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      className="min-h-screen relative"
      style={{ backgroundColor: "var(--overview-bg)", color: "var(--overview-fg)" }}
    >
      {/* Ambient terracotta radial — same pattern as the home page. */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 1400px 700px at 50% -10%, rgba(174,86,48,0.08), transparent 60%), radial-gradient(ellipse 800px 500px at 90% 10%, rgba(174,86,48,0.03), transparent 55%)",
        }}
      />

      <header
        className="sticky top-0 z-50 border-b"
        style={{
          borderColor: "var(--card-warm-border)",
          backgroundColor: "rgba(24,19,15,0.85)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-8">
          {/* Wordmark */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-[12px] font-semibold tracking-[0.22em] uppercase text-[var(--overview-fg)]/90">
              Command Center
            </span>
            <span
              className="h-[5px] w-[5px] rounded-full"
              style={{ backgroundColor: "var(--terracotta)" }}
            />
          </Link>

          {/* Nav links */}
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map(({ label, href }) => {
              // Mark active when the pathname starts with the href (except
              // "/" which only matches exactly so it doesn't highlight on
              // every page).
              const active =
                href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className="rounded-md px-3 py-1.5 text-[12px] transition-colors duration-150"
                  style={{
                    color: active
                      ? "var(--overview-fg)"
                      : "rgba(237,234,224,0.45)",
                    backgroundColor: active
                      ? "rgba(174,86,48,0.12)"
                      : "transparent",
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          <UserButton />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-8 py-8">{children}</main>
    </div>
  );
}
