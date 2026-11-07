"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle } from "lucide-react";
import { analysisStatusAction, type AnalysisStatusView } from "@/lib/qc/actions";
import { expectedTime, progressLine } from "@/lib/qc/progress-text";
import { GEMINI_BADGE, LOCAL_BADGE, MOCK_BADGE } from "@/components/qc/analysis-panel";
import { cn } from "@/lib/utils";

const POLL_MS = 2_500;
const active = (s?: string) => s === "queued" || s === "processing";

/**
 * Shown in the result's place while the design is being checked: a teal card with what's happening, the
 * steps ticking off (as many as the check really has), a progress bar and how long it usually takes. It
 * asks for the run's progress every few seconds; when the run ends the page is rebuilt, so the result
 * (or why it didn't finish) appears here by itself. Display only — starting and stopping are elsewhere.
 */
export function CheckProgress({ sessionId, initial }: { sessionId: string; initial: AnalysisStatusView }) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const last = useRef(initial.status);
  const [, startRefresh] = useTransition();

  useEffect(() => {
    if (!active(run.status)) return;
    const timer = setInterval(async () => {
      const next = await analysisStatusAction(sessionId, "content").catch(() => null);
      if (!next) return;
      setRun(next);
      if (!active(next.status) && active(last.current)) startRefresh(() => router.refresh());
      last.current = next.status;
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run.status, sessionId, router]);

  const finishing = !active(run.status) || (run.total > 0 && run.done >= run.total);
  const percent = finishing ? 100 : run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const line = finishing ? "Preparing the result" : progressLine(run, "Checking the design");
  const provider = run.mock ? MOCK_BADGE : run.provider === "gemini" ? GEMINI_BADGE : run.provider === "local" ? LOCAL_BADGE : null;

  return (
    <section
      aria-label="Checking your design"
      aria-live="polite"
      className="rounded-3xl bg-[linear-gradient(135deg,#0a3644,#0e6377)] p-5 text-white shadow-[0_20px_50px_-30px_rgb(6_28_35/0.9)] sm:p-6"
    >
      <p className="text-xs font-semibold tracking-[0.14em] text-white/70 uppercase">Checking your design</p>
      <p className="display mt-1.5 text-2xl sm:text-3xl">{expectedTime("content", run.provider)}</p>
      <p className="mt-1.5 text-sm text-white/85">You can stay on this page — the result appears here by itself. You can also leave; it carries on.</p>

      {run.total > 0 && (
        <ol className="mt-5 flex flex-wrap gap-2" aria-label="Steps">
          {Array.from({ length: run.total }, (_, i) => {
            const state = finishing || i < run.done ? "done" : i === run.done ? "now" : "next";
            return (
              <li
                key={i}
                className={cn(
                  "flex items-center gap-2 rounded-2xl px-3 py-2 text-sm",
                  state === "done" && "bg-white/10 text-[#bbf7d0]",
                  state === "now" && "bg-white/[0.18] font-semibold",
                  state === "next" && "bg-white/[0.06] text-white/55"
                )}
              >
                {state === "done" ? (
                  <span className="grid size-5 place-items-center rounded-full bg-[#16a34a] text-white" aria-hidden>
                    <Check className="size-3" />
                  </span>
                ) : state === "now" ? (
                  <LoaderCircle className="size-5 animate-spin" aria-hidden />
                ) : (
                  <span className="size-5 rounded-full border-2 border-white/35" aria-hidden />
                )}
                Step {i + 1}
                {state === "now" && run.stage && !finishing ? `: ${run.stage}` : ""}
              </li>
            );
          })}
        </ol>
      )}

      <div
        className="mt-5 h-2 overflow-hidden rounded-full bg-white/15"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Check progress"
      >
        <div className="h-full rounded-full bg-[#fbd38d] transition-all" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-white/75">
        <span className="flex items-center gap-1.5">
          {finishing && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
          {line}
        </span>
        {provider && <span>{provider}</span>}
      </p>
    </section>
  );
}
