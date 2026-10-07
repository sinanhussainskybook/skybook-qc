"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Cpu, FlaskConical, LoaderCircle, Sparkles } from "lucide-react";
import { analysisStatusAction, startAnalysisAction, type AnalysisStatusView, type QcFormState } from "@/lib/qc/actions";
import type { RunKind } from "@/lib/db/analysis-runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const MOCK_BADGE = "Sample data — not real AI";
export const LOCAL_BADGE = "Local AI — runs on this server";
export const LOCAL_SLOW = "Local AI can take several minutes per design.";
export const GEMINI_BADGE = "Gemini (Google AI Studio)";
const POLL_MS = 2_500;
const active = (s?: string) => s === "queued" || s === "processing";

const WORDING = {
  content: {
    notYet: "Not analysed yet. The content is analysed when you save and continue.",
    noFiles: "Upload the content to analyse it.",
    start: "Analyse now",
    again: "Analyse again",
    done: "Analysed. The results are in the checks below.",
    stale: "Analysed — but the files have changed since.",
  },
  information: {
    notYet: "The requirements in these files can be found for you to review.",
    noFiles: "Upload information files to find requirements in them.",
    start: "Find requirements in these files",
    again: "Look again",
    done: "Done. Anything found was added to Requirements above as unconfirmed — review each one; nothing is used until you confirm it.",
    stale: "Done.",
  },
} as const;

/**
 * The analysis status for this session (Phase 6, 6.10 / 6.7): waiting /
 * working with progress (polled), finished, or failed with a plain reason
 * and Try again. Results from the mock provider are always labelled.
 */
export function AnalysisPanel({
  kind = "content",
  sessionId,
  configured,
  hasContent,
  initial,
  stale,
  runsLeft,
}: {
  kind?: RunKind;
  sessionId: string;
  configured: boolean;
  hasContent: boolean;
  initial: AnalysisStatusView | null;
  stale: boolean;
  runsLeft: number;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(startAnalysisAction, {});
  const last = useRef(initial?.status);

  useEffect(() => {
    if (!active(run?.status)) return;
    const timer = setInterval(async () => {
      const next = await analysisStatusAction(sessionId, kind).catch(() => null);
      if (!next) return;
      setRun(next);
      if (!active(next.status) && active(last.current)) router.refresh();
      last.current = next.status;
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run?.status, sessionId, kind, router]);

  if (!configured) {
    return <p className="text-sm text-muted-foreground">Content analysis isn&apos;t set up on this server, so checks that need it show as not verified.</p>;
  }

  const words = WORDING[kind];
  const percent = run && run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const runButton = (label: string) =>
    hasContent && runsLeft > 0 ? (
      <form action={formAction}>
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="kind" value={kind} />
        <Button type="submit" variant="outline" size="sm" disabled={pending} className="rounded-full">
          {pending ? "Starting…" : label}
        </Button>
      </form>
    ) : null;

  return (
    <div className="space-y-3" aria-live="polite">
      {run?.mock && (
        <Badge className="gap-1 bg-revision-soft text-revision">
          <FlaskConical className="size-3.5" aria-hidden />
          {MOCK_BADGE}
        </Badge>
      )}
      {run?.provider === "gemini" && (
        <Badge variant="outline" className="gap-1">
          <Sparkles className="size-3.5" aria-hidden />
          {GEMINI_BADGE}
        </Badge>
      )}
      {run?.provider === "local" && (
        <Badge variant="outline" className="gap-1">
          <Cpu className="size-3.5" aria-hidden />
          {LOCAL_BADGE}
        </Badge>
      )}

      {!run && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {hasContent ? words.notYet : words.noFiles}
          </p>
          {runButton(words.start)}
        </div>
      )}

      {run && active(run.status) && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {run.status === "queued" ? "Waiting to start…" : `${run.stage ?? "Working"}…`}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Analysis progress">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {run.total > 0 ? `${run.done} of ${run.total} steps` : "Preparing"} · you can leave this page; the analysis carries on.
            {run.provider === "local" ? ` ${LOCAL_SLOW}` : ""}
          </p>
        </div>
      )}

      {run?.status === "done" && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-sm font-medium text-pass">
            <CircleCheck className="size-4" aria-hidden />
            {stale ? words.stale : words.done}
          </p>
          {runButton(words.again)}
        </div>
      )}

      {(run?.status === "failed" || run?.status === "cancelled") && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="flex items-center gap-2 text-sm font-medium text-fail">
            <CircleAlert className="size-4" aria-hidden />
            {run.status === "failed" ? "The analysis didn't finish" : "The analysis was stopped"}: {run.reason ?? "unknown reason"}
          </p>
          {runButton("Try again")}
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}
      {runsLeft === 0 && <p className="text-xs text-muted-foreground">This session has used all its analysis runs.</p>}
    </div>
  );
}
