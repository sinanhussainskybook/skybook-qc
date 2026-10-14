"use client";

import { useActionState, useState } from "react";
import { RotateCcw, ScanSearch } from "lucide-react";
import { markReadyAction, startOverAction } from "@/lib/qc/actions";
import { Button } from "@/components/ui/button";

/**
 * Check Design — the one button: it confirms what was read from the brief,
 * marks the session Ready and checks the design (markReadyAction) — and
 * Start over (deletes the session). Until it can run, it says plainly why.
 */
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
  const blocked = status === "draft" && problems.length > 0;

  return (
    <div className="space-y-4">
      {blocked && (
        <ul className="space-y-1 text-sm">
          {problems.map((problem) => (
            <li key={problem} className="text-muted-foreground">
              · {problem}
            </li>
          ))}
        </ul>
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
            disabled={saving || blocked || status === "ready"}
            className="btn-glossy h-12 rounded-full px-7 text-base font-semibold"
          >
            <ScanSearch aria-hidden />
            {saving ? "Starting…" : "Check Design"}
          </Button>
        </form>

        {askStartOver ? (
          <form action={overAction} className="flex flex-wrap items-center gap-1 rounded-full bg-fail-soft py-0.5 pr-0.5 pl-3">
            <input type="hidden" name="sessionId" value={sessionId} />
            <span className="text-xs font-medium text-fail">Delete this check&apos;s brief and design?</span>
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
