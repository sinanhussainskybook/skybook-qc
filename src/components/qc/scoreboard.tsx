import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CATEGORIES, severityLabel, type Severity } from "@/lib/qc/findings";
import { RESULT_DISPLAY_LABEL, RESULT_DISPLAY_SUMMARY, resultDisplay, type ResultDisplay, type Scoreboard as Board } from "@/lib/qc/scoring";
import { cn } from "@/lib/utils";

const RESULT_STYLE: Record<ResultDisplay, { icon: typeof CircleCheck; box: string; text: string }> = {
  pass: { icon: CircleCheck, box: "bg-pass-soft ring-pass/30", text: "text-pass" },
  // A pass that still has "Needs a human check" items: amber, so it isn't read as a clean pass.
  pass_human_check: { icon: CircleCheck, box: "bg-revision-soft ring-revision/30", text: "text-revision" },
  needs_revision: { icon: TriangleAlert, box: "bg-revision-soft ring-revision/30", text: "text-revision" },
  fail: { icon: CircleX, box: "bg-fail-soft ring-fail/30", text: "text-fail" },
};
const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "bg-fail-soft text-fail",
  major: "bg-revision-soft text-revision",
  minor: "bg-muted text-foreground",
  suggestion: "bg-muted text-muted-foreground",
};
const categoryLabel = (value: string) => CATEGORIES.find((c) => c.value === value)?.label ?? value;

/**
 * The QC result (Phase 7): the PASS / NEEDS REVISION / FAIL banner, the score,
 * issue counts by severity and category, and the issues that count. Not
 * verified checks and "Needs a human check" are listed but never count.
 * Built from the current session each time — nothing is stored.
 */
export function Scoreboard({ board, mock = false }: { board: Board; mock?: boolean }) {
  const shown = resultDisplay(board);
  if (!shown) {
    return <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No result yet: none of the checks could be verified.</p>;
  }
  const style = RESULT_STYLE[shown];
  const Icon = style.icon;
  const uncounted = board.notVerified + board.humanChecks;
  return (
    <div className="space-y-4">
      <div className={cn("flex flex-wrap items-center gap-4 rounded-2xl px-5 py-4 ring-1", style.box)} role="status" aria-label={`QC result: ${RESULT_DISPLAY_LABEL[shown]}`}>
        <Icon className={cn("size-10 shrink-0", style.text)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("text-2xl font-bold tracking-tight", style.text)}>{RESULT_DISPLAY_LABEL[shown]}</p>
          <p className="text-sm">{RESULT_DISPLAY_SUMMARY[shown]}</p>
        </div>
        {board.score !== null && (
          <p className="text-right">
            <span className="text-3xl font-semibold tabular-nums">{board.score}</span>
            <span className="text-sm text-muted-foreground"> / 100</span>
          </p>
        )}
      </div>

      {mock && (
        <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">
          Sample data — not real AI. This is not a real QC result.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        Based on {board.answered} of {board.applicable} checks that could be answered.
        {uncounted > 0 && (
          <>
            {" "}
            {board.humanChecks > 0 && (
              <>
                <strong className="text-foreground">{board.humanChecks} need a human check</strong>
                {board.notVerified > 0 ? " and " : ""}
              </>
            )}
            {board.notVerified > 0 && <>{board.notVerified} couldn&apos;t be verified</>} — they don&apos;t count for or against the result. Look at them before sending the content.
          </>
        )}
      </p>

      <ul className="flex flex-wrap gap-2" aria-label="Issues by severity">
        {(["critical", "major", "minor", "suggestion"] as const).map((s) => (
          <li key={s} className={cn("rounded-full px-3 py-1 text-xs font-medium", SEVERITY_STYLE[s])}>
            {board.issues[s]} {severityLabel(s).toLowerCase()}
          </li>
        ))}
        <li className="rounded-full bg-revision-soft px-3 py-1 text-xs font-medium text-revision">{board.humanChecks} need a human check</li>
        <li className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">{board.notVerified} not verified</li>
      </ul>

      <div className="overflow-x-auto rounded-xl ring-1 ring-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Score by category</caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Category</th>
              <th scope="col" className="px-4 py-2 font-medium">Score</th>
              <th scope="col" className="px-4 py-2 font-medium">Issues</th>
              <th scope="col" className="px-4 py-2 font-medium">Not counted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {board.categories.map((c) => {
              const issues = (["critical", "major", "minor", "suggestion"] as const).filter((s) => c.issues[s] > 0);
              return (
                <tr key={c.category}>
                  <th scope="row" className="px-4 py-2 text-left font-medium">{c.label}</th>
                  <td className="px-4 py-2 tabular-nums">{c.score === null ? <span className="text-muted-foreground">Not checked</span> : c.score}</td>
                  <td className="px-4 py-2">{issues.length ? issues.map((s) => `${c.issues[s]} ${severityLabel(s).toLowerCase()}`).join(", ") : <span className="text-muted-foreground">None</span>}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {[c.humanChecks ? `${c.humanChecks} need a human check` : "", c.notVerified ? `${c.notVerified} not verified` : ""].filter(Boolean).join(", ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {board.counting.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">What to fix</h3>
          <ul className="space-y-2">
            {board.counting.map((f, i) => (
              <li key={`${f.ruleId}-${i}`} className="rounded-lg bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", SEVERITY_STYLE[f.severity])}>{severityLabel(f.severity)}</span>
                  <Badge variant="outline">{categoryLabel(f.category)}</Badge>
                  <span className="font-medium">{f.title}</span>
                </div>
                {f.expected && <p className="mt-1 text-muted-foreground">Expected: {f.expected}</p>}
                {f.detected && <p className="mt-1 text-muted-foreground">Detected: {f.detected}</p>}
                {f.suggestedFix && <p className="mt-1">Suggested fix: {f.suggestedFix}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Why there's no result yet, in plain words (shown instead of the scoreboard). */
export function resultWaitingText(state: string | undefined): string {
  switch (state) {
    case "pending":
      return "The result appears when the analysis finishes.";
    case "failed":
    case "unsupported":
      return "No result: the analysis didn't finish. Try again in Analysis above.";
    case "not_configured":
      return "No result: content analysis isn't set up on this server.";
    default:
      return "The result appears after the content is analysed.";
  }
}
