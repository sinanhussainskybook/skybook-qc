"use client";

import { useActionState, useState } from "react";
import { CircleCheck, RotateCcw } from "lucide-react";
import { markReadyAction, startOverAction } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";

/** Confirm & Run QC (confirms the requirements, marks the session Ready, analyses the content) and Start over (deletes it). */
export function SessionFooter({
  sessionId,
  status,
  problems,
}: {
  sessionId: string;
  status: "draft" | "ready";
  problems: string[];
}) {
  const [readyState, readyAction, saving] = useActionState(markReadyAction, {});
  const [overState, overAction, clearing] = useActionState(startOverAction, {});
  const [askStartOver, setAskStartOver] = useState(false);

  return (
    <div className="space-y-4">
      {status === "ready" ? (
        <div className="flex items-start gap-3 rounded-xl bg-pass-soft p-4 text-pass">
          <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Ready for QC</p>
            <p className="mt-0.5 text-sm text-foreground">
              The requirements are confirmed. The content is analysed in the background and the QC result appears below
              when it finishes. Any change you make sets this back to draft — press Confirm &amp; Run QC again to use it.
            </p>
          </div>
        </div>
      ) : (
        problems.length > 0 && (
          <ul className="space-y-1 rounded-xl bg-muted/60 p-4 text-sm">
            <li className="font-medium">Before you run QC:</li>
            {problems.map((problem) => (
              <li key={problem} className="text-muted-foreground">
                · {problem}
              </li>
            ))}
          </ul>
        )
      )}

      {(readyState.error || overState.error) && (
        <p role="alert" className="text-sm font-medium text-fail">
          {readyState.error ?? overState.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form action={readyAction}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <Button
            type="submit"
            disabled={saving || status === "ready"}
            className="h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background hover:bg-foreground/85"
          >
            {saving ? "Starting…" : status === "ready" ? "Confirmed" : "Confirm & Run QC"}
          </Button>
        </form>

        {askStartOver ? (
          <form action={overAction} className="flex flex-wrap items-center gap-1 rounded-full bg-fail-soft py-0.5 pr-0.5 pl-3">
            <input type="hidden" name="sessionId" value={sessionId} />
            <span className="text-xs font-medium text-fail">Delete this check&apos;s requirements and files?</span>
            <Button type="submit" size="sm" disabled={clearing} className="rounded-full bg-fail text-white hover:bg-fail/85">
              Yes, start over
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => setAskStartOver(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button type="button" variant="ghost" className="h-9 rounded-full px-4" onClick={() => setAskStartOver(true)}>
            <RotateCcw aria-hidden />
            Start over
          </Button>
        )}
      </div>
    </div>
  );
}
