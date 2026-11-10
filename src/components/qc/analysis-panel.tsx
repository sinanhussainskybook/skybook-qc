"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Cpu, FlaskConical, LoaderCircle, Sparkles } from "lucide-react";
import { analysisStatusAction, startAnalysisAction, type AnalysisStatusView, type QcFormState } from "@/lib/qc/actions";
import type { RunKind } from "@/lib/db/analysis-runs";
import { BRIEF_UNCLEAR_MESSAGE } from "@/lib/qc/requirements";
import { BRIEF_FILES_CHANGED_MESSAGE, isOversizedBriefReason } from "@/lib/qc/brief-length";
import { expectedTime, progressLine } from "@/lib/qc/progress-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const MOCK_BADGE = "Sample data — not real AI";
export const LOCAL_BADGE = "Local AI — runs on this server";
export const LOCAL_SLOW = "Local AI can take several minutes per design.";
export const GEMINI_BADGE = "Gemini (Google AI Studio)";
/** The way forward once a check's analysis runs are used up. */
export const RUNS_USED_UP =
  "This check has used all its analysis runs. To check again, press Start over (next to Check Design): it deletes this check's brief, design and result (your company details stay), then upload them again.";
const POLL_MS = 2_500;
const active = (s?: string) => s === "queued" || s === "processing";

/**
 * One plain status line per step. `again` is offered only when the files
 * changed after a run (stale) — otherwise Check Design is the one button.
 */
const WORDING = {
  content: {
    working: "Checking the design",
    finishing: "Preparing the result",
    notYet: "Not checked yet. Press Check Design.",
    noFiles: "Upload the design to check it.",
    /** No start button: Check Design starts the check. */
    start: null,
    again: null,
    done: "Design checked — the result is below.",
    stale: "The design has changed since it was checked — press Check Design to check it again.",
  },
  information: {
    working: "Reading the brief",
    finishing: "Reading the brief",
    // The brief is read by itself on upload; this only shows if that couldn't start.
    notYet: "The brief hasn't been read yet.",
    noFiles: "Upload or type the client brief.",
    start: "Read the brief",
    again: "Read again",
    done: "Brief read.",
    stale: "A brief was added or removed since it was read — read it again to include it.",
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
  found,
}: {
  kind?: RunKind;
  sessionId: string;
  configured: boolean;
  hasContent: boolean;
  initial: AnalysisStatusView | null;
  stale: boolean;
  /** Design analysis runs left; omitted for brief reading, which has no run limit. */
  runsLeft?: number;
  /** Brief only: how many requirements it gave that can be checked against the design. */
  found?: number;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [state, formAction, pending] = useActionState<QcFormState, FormData>(startAnalysisAction, {});
  const last = useRef(initial?.status);
  // The run can finish before the page has its result: the page is rebuilt on the
  // server after the run ends. Until that refresh arrives, say the result is being
  // prepared — not "done" above a section that still shows the old state.
  const [refreshing, startRefresh] = useTransition();

  useEffect(() => {
    if (!active(run?.status)) return;
    const timer = setInterval(async () => {
      const next = await analysisStatusAction(sessionId, kind).catch(() => null);
      if (!next) return;
      setRun(next);
      if (!active(next.status) && active(last.current)) startRefresh(() => router.refresh());
      last.current = next.status;
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run?.status, sessionId, kind, router]);

  if (!configured) {
    return <p className="text-sm text-muted-foreground">Content analysis isn&apos;t set up on this server, so checks that need it show as not verified.</p>;
  }

  const words = WORDING[kind];
  const percent = run && run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const runButton = (label: string | null) =>
    label && hasContent && (runsLeft === undefined || runsLeft > 0) ? (
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

      {run && !active(run.status) && refreshing && (
        <p className="flex items-center gap-2 text-sm font-medium" role="status">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          {words.finishing}…
        </p>
      )}

      {run && active(run.status) && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-medium">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {words.working}…
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Analysis progress">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {progressLine(run, words.working)} · {expectedTime(kind, run.provider)} You can leave this page; it carries on.
          </p>
        </div>
      )}

      {run?.status === "done" &&
        !refreshing &&
        (stale ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-revision">{words.stale}</p>
            {runButton(words.again)}
          </div>
        ) : kind === "information" && found === 0 ? (
          <p role="alert" className="flex items-center gap-2 text-sm font-medium text-fail">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {BRIEF_UNCLEAR_MESSAGE}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium text-pass">
            <CircleCheck className="size-4" aria-hidden />
            {words.done}
          </p>
        ))}

      {(run?.status === "failed" || run?.status === "cancelled") && !refreshing && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="flex items-center gap-2 text-sm font-medium text-fail">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {kind === "information"
              ? // A brief too long for Local AI: its own message (which files, the limit, what to do).
                isOversizedBriefReason(run.reason)
                ? stale
                  ? words.stale
                  : run.reason
                : // The brief changed while it was read: its own message (read the updated brief again).
                  run.reason === BRIEF_FILES_CHANGED_MESSAGE
                  ? run.reason
                  : `${BRIEF_UNCLEAR_MESSAGE} (${run.reason ?? "it couldn't be read"})`
              : `${run.status === "failed" ? "The check didn't finish" : "The check was stopped"}: ${run.reason ?? "unknown reason"}`}
          </p>
          {/* Reading the same long file again can't help: shorten or split it (a new upload is read by itself).
              Once the brief files have changed (stale), it can be read again. */}
          {kind === "information" && isOversizedBriefReason(run.reason)
            ? stale && runButton(words.again)
            : runButton("Try again")}
        </div>
      )}

      {state.error && (
        <p role="alert" className="text-sm font-medium text-fail">
          {state.error}
        </p>
      )}
      {runsLeft === 0 && <p className="text-xs text-muted-foreground">{RUNS_USED_UP}</p>}
    </div>
  );
}
