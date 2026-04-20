import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* Top navigation bar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-8">
          <Link href="/" className="text-base font-semibold tracking-tight">
            Command Center
          </Link>
          <UserButton />
        </div>
      </header>

      {/* Page content */}
      <main className="mx-auto max-w-7xl px-8 py-8">{children}</main>
    </div>
  );
}
