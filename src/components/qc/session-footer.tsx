"use client";

import { useActionState, useState } from "react";
import { CircleCheck, RotateCcw } from "lucide-react";
import { markReadyAction, startOverAction } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";

/** Save and continue (marks the session Ready) and Start over (deletes it). */
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
              Everything for this check is saved. The content is analysed in the background and the checks below update
              when it finishes, with the QC result. Any change you make sets this back to draft.
            </p>
          </div>
        </div>
      ) : (
        problems.length > 0 && (
          <ul className="space-y-1 rounded-xl bg-muted/60 p-4 text-sm">
            <li className="font-medium">Before you continue:</li>
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
            {saving ? "Saving…" : status === "ready" ? "Saved" : "Save and continue"}
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
