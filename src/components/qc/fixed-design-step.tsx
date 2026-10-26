"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The id of the folded "Files and Check Design" box beside the result, and of the design step inside it. */
export const FILES_BOX_ID = "files-and-check";
const DESIGN_STEP_ID = "content";

/**
 * What to do when there are issues to fix: fix them in the design file, then replace the design and check
 * it again. The button opens the folded files box and brings the design step into view.
 */
export function FixedDesignStep() {
  function openDesignStep() {
    const box = document.getElementById(FILES_BOX_ID);
    if (box instanceof HTMLDetailsElement) box.open = true;
    const step = document.getElementById(DESIGN_STEP_ID) ?? box;
    step?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-secondary px-4 py-3 text-sm">
      <p className="min-w-0 flex-1 text-secondary-foreground">
        <strong>Next:</strong> fix these in your design file, then replace the design with the fixed one and press Check Design.
      </p>
      <Button type="button" variant="outline" className="btn-white rounded-full" onClick={openDesignStep}>
        <RefreshCw aria-hidden />
        Check a fixed design
      </Button>
    </div>
  );
}
