import { ChevronDown, CircleCheck, CircleX, FileDown, TriangleAlert } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { isHumanCheck } from "@/lib/analysis/policy";
import { CATEGORIES, severityLabel, type Finding, type Severity } from "@/lib/qc/findings";
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
/** Keeps every line short in the summary (the full text stays in "All checks in detail"). */
const short = (text: string | undefined, max = 140) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The QC result (Phase 7), as a short checklist: the result and score, then
 * what to fix (issue · severity · what was found · what to fix), the items
 * that need a human check, and how many checks passed (details collapsed),
 * with the PDF download. Display only — the findings, scoring and result are
 * computed elsewhere and unchanged; every check's full detail stays in
 * "All checks in detail" further down the page.
 */
export function Scoreboard({ board, findings = [], mock = false, reportHref }: { board: Board; findings?: Finding[]; mock?: boolean; reportHref?: string }) {
  const shown = resultDisplay(board);
  if (!shown) {
    return <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No result yet: none of the checks could be verified.</p>;
  }
  const style = RESULT_STYLE[shown];
  const Icon = style.icon;
  const toFix = board.counting.filter((f) => f.severity !== "suggestion");
  const suggestions = board.counting.filter((f) => f.severity === "suggestion");
  const human = findings.filter(isHumanCheck);
  const passed = findings.filter((f) => f.status === "passed");

  return (
    <div className="space-y-6">
      {/* 1 — the result */}
      <div className={cn("flex flex-wrap items-center gap-4 rounded-2xl px-5 py-5 ring-1", style.box)} role="status" aria-label={`QC result: ${RESULT_DISPLAY_LABEL[shown]}`}>
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

      {/* At a glance: three equal cards */}
      <ul className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="At a glance">
        <Tile n={toFix.length} label="Issues to fix" tone={toFix.length ? "bg-fail-soft text-fail" : "bg-muted/60 text-muted-foreground"} />
        <Tile n={human.length} label={human.length === 1 ? "Human check" : "Human checks"} tone={human.length ? "bg-revision-soft text-revision" : "bg-muted/60 text-muted-foreground"} />
        <Tile n={passed.length} label={passed.length === 1 ? "Check passed" : "Checks passed"} tone="bg-pass-soft text-pass" />
      </ul>

      {/* 2 — issues to fix */}
      <section aria-labelledby="issues-to-fix" className="space-y-3">
        <Heading id="issues-to-fix">Issues to fix</Heading>
        {toFix.length === 0 ? (
          <p className="text-sm text-muted-foreground">No issues to fix.</p>
        ) : (
          <ul className="grid gap-3">
            {toFix.map((f, i) => (
              <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="rounded-xl bg-card p-4 ring-1 ring-border">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", SEVERITY_STYLE[f.severity])}>{severityLabel(f.severity)}</span>
                  <span className="font-semibold">{f.title}</span>
                  <span className="text-xs text-muted-foreground">{categoryLabel(f.category)}</span>
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[7rem_1fr]">
                  {f.detected && (
                    <>
                      <dt className="text-muted-foreground">Found</dt>
                      <dd className="min-w-0 break-words">{short(f.detected)}</dd>
                    </>
                  )}
                  {(f.suggestedFix || f.expected) && (
                    <>
                      <dt className="text-muted-foreground">Fix</dt>
                      <dd className="min-w-0 break-words">{short(f.suggestedFix ?? `Make it: ${f.expected}`)}</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
        {suggestions.length > 0 && (
          <Collapsed summary={`${suggestions.length} optional suggestion${suggestions.length === 1 ? "" : "s"}`}>
            <ul className="space-y-1.5 text-sm">
              {suggestions.map((f, i) => (
                <li key={`${f.ruleId}-${i}`}>
                  <span className="font-medium">{f.title}</span>
                  {f.suggestedFix && <span className="text-muted-foreground"> — {short(f.suggestedFix, 110)}</span>}
                </li>
              ))}
            </ul>
          </Collapsed>
        )}
      </section>

      {/* 3 — human checks */}
      {human.length > 0 && (
        <section aria-labelledby="human-checks" className="space-y-3">
          <Heading id="human-checks">Human checks</Heading>
          <p className="text-sm text-muted-foreground">The AI wasn&apos;t sure about these. They don&apos;t count for or against the result — look at each one before sending.</p>
          <ul className="grid gap-3">
            {human.map((f, i) => (
              <li key={`${f.ruleId}-${i}`} className="rounded-xl bg-revision-soft/50 p-4 ring-1 ring-revision/25">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", f.severity === "critical" ? "bg-fail-soft text-fail" : "bg-revision-soft text-revision")}>
                    {f.severity === "critical" ? "Possible critical" : severityLabel(f.severity)}
                  </span>
                  <span className="font-semibold">{f.title}</span>
                  <span className="text-xs text-muted-foreground">{categoryLabel(f.category)}</span>
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[7rem_1fr]">
                  {f.expected && (
                    <>
                      <dt className="text-muted-foreground">Should be</dt>
                      <dd className="min-w-0 break-words">{short(f.expected)}</dd>
                    </>
                  )}
                  {f.detected && (
                    <>
                      <dt className="text-muted-foreground">AI read</dt>
                      <dd className="min-w-0 break-words">{short(f.detected)}</dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 4 — passed checks */}
      <section aria-labelledby="passed-checks" className="space-y-2">
        <Heading id="passed-checks">Passed</Heading>
        {passed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checks passed yet.</p>
        ) : (
          <Collapsed summary={`✓ ${passed.length} check${passed.length === 1 ? "" : "s"} passed`} summaryClass="text-pass">
            <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {passed.map((f, i) => (
                <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="min-w-0 truncate">
                  <span className="text-muted-foreground">{categoryLabel(f.category)} · </span>
                  {f.title}
                </li>
              ))}
            </ul>
          </Collapsed>
        )}
      </section>

      {/* 5 — the report */}
      {reportHref && (
        <div className="flex flex-wrap items-center gap-3 border-t pt-5">
          <a href={reportHref} download className={buttonVariants({ size: "lg", className: "gap-2 rounded-full" })}>
            <FileDown className="size-4" aria-hidden />
            Download QC report (PDF)
          </a>
          <p className="text-xs text-muted-foreground">Made from this check when you download it. It isn&apos;t saved anywhere — keep the file.</p>
        </div>
      )}
    </div>
  );
}

/** Score by category — moved out of the summary into "All checks in detail". */
export function CategoryScores({ board }: { board: Board }) {
  return (
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
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <li className={cn("min-w-0 rounded-xl px-3 py-3 sm:px-4 sm:py-4", tone)}>
      <p className="text-2xl font-semibold tabular-nums leading-none sm:text-3xl">{n}</p>
      <p className="mt-2 text-xs font-medium text-foreground sm:text-sm">{label}</p>
    </li>
  );
}

function Heading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="border-t pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function Collapsed({ summary, summaryClass, children }: { summary: string; summaryClass?: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl bg-muted/40 px-4 py-3">
      <summary className={cn("flex cursor-pointer list-none items-center gap-2 text-sm font-medium", summaryClass)}>
        <span className="flex-1">{summary}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
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
