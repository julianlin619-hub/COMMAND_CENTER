import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PlatformIcon } from "@/components/platform-icon";

export const dynamic = "force-dynamic";

export default function LeilaLinkedInPage() {
  return (
    <AppShell>
      <div className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Overview
        </Link>
        <div className="flex items-center gap-3">
          <PlatformIcon platform="linkedin" className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Leila — LinkedIn</h1>
            <p className="text-sm text-muted-foreground">
              Pipeline coming soon
            </p>
          </div>
        </div>
      </div>

      <div
        className="rounded-xl border px-5 py-6 text-[13px] text-[var(--overview-fg)]/55"
        style={{
          backgroundColor: "var(--card-warm-bg)",
          borderColor: "var(--card-warm-border)",
        }}
      >
        Leila&apos;s LinkedIn workflow hasn&apos;t been wired up yet. Pathways will land here.
      </div>
    </AppShell>
  );
}
