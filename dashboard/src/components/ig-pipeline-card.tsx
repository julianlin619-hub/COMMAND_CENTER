"use client";

/**
 * Wraps the Instagram platform card to make it clickable. Opens the
 * IG Pipeline Dialog for step-by-step debugging of the automated
 * tweet-to-Instagram posting flow.
 */

import { useState } from "react";
import { IgPipelineDialog } from "@/components/ig-pipeline-dialog";

export function IgPipelineCard({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(true); }}
        className="w-full text-left cursor-pointer"
      >
        {children}
      </div>
      <IgPipelineDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
