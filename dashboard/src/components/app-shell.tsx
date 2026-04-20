import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/**
 * Shell for every detail page. Matches the home page's header language:
 * wordmark + terracotta dot on the left, UserButton on the right, on a
 * warm near-black surface. No backdrop blur — we want the same solid warm
 * background for every screen.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen relative"
      style={{ backgroundColor: "var(--overview-bg)", color: "var(--overview-fg)" }}
    >
      {/* Ambient terracotta radial — same pattern as the home page so
          navigating between / and detail screens feels continuous. */}
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
          <Link href="/" className="flex items-center gap-2 w-fit">
            <span className="text-[12px] font-semibold tracking-[0.22em] uppercase text-[var(--overview-fg)]/90">
              Command Center
            </span>
            <span
              className="h-[5px] w-[5px] rounded-full"
              style={{ backgroundColor: "var(--terracotta)" }}
            />
          </Link>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-8 py-8">{children}</main>
    </div>
  );
}
