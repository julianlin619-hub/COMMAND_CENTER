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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left cursor-pointer"
      >
        {children}
      </button>
      <IgPipelineDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
