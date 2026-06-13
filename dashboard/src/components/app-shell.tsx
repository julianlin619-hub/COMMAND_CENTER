import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

/**
 * Shell for every detail page (the surfaces you reach by clicking into a
 * Command Center card — /tweet-cards, /leila/linkedin, /posts, etc.).
 *
 * The header is intentionally minimal: just the wordmark on the left and
 * the Clerk UserButton on the right. There is no nav row — detail pages
 * are leaf surfaces, so the top bar should orient ("you're inside Command
 * Center") and let you back out, not advertise sibling routes. The
 * wordmark doubles as the way home (it links to "/"); Manual Upload and
 * the other formats are reachable from the home page cards.
 *
 * The home page itself does NOT use this shell — it renders its own
 * PageHeader — so removing the nav here doesn't touch the home layout.
 *
 * Column width matches the home page (max-w-[1100px], px-7) so a detail page
 * sits in the exact same column as home and reads as a sibling surface. The
 * `maxWidth` prop is an opt-out for the few genuinely wide pages (data tables
 * like /posts and /youtube-second) that need more room than the home column.
 */
export function AppShell({
  children,
  maxWidth = "1100px",
}: {
  children: React.ReactNode;
  maxWidth?: string;
}) {
  return (
    // The warm radial + grain now live globally (see layout.tsx
    // .app-atmosphere), so this shell no longer paints its own background
    // wash — it just sets the text color and lets the body bg show through.
    <div className="min-h-screen relative" style={{ color: "var(--overview-fg)" }}>
      <header
        className="sticky top-0 z-50 border-b"
        style={{
          borderColor: "var(--surface-border)",
          backgroundColor: "rgba(24,19,15,0.72)",
          backdropFilter: "blur(12px) saturate(1.2)",
          WebkitBackdropFilter: "blur(12px) saturate(1.2)",
        }}
      >
        <div
          className="mx-auto flex h-14 items-center justify-between px-7"
          style={{ maxWidth }}
        >
          {/* Wordmark — a small terracotta pip leads the mark, with the
              name in a tracked uppercase mono-adjacent voice. Doubles as
              the link back to the Command Center home. */}
          <Link href="/" className="group flex items-center gap-2.5 shrink-0">
            <span
              className="h-[7px] w-[7px] rounded-full transition-shadow duration-200"
              style={{
                backgroundColor: "var(--terracotta)",
                boxShadow: "var(--glow-terra)",
              }}
            />
            <span className="text-[12px] font-semibold tracking-[0.24em] uppercase text-[var(--overview-fg)]/90 transition-colors group-hover:text-[var(--overview-fg)]">
              Command Center
            </span>
          </Link>

          <UserButton />
        </div>
      </header>

      <main className="mx-auto px-7 pt-12 pb-24" style={{ maxWidth }}>
        {children}
      </main>
    </div>
  );
}
