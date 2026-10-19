import { ChevronDown, FileDown } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CATEGORIES, severityLabel, type Finding, type Severity } from "@/lib/qc/findings";
import { alsoCoversText, alsoNote, isGoldenRule, needsVerifying, NOT_CHECKED, ruleName, splitNotChecked, verifyNote } from "@/lib/qc/golden-rules-view";
import { categoryScoreText, possibleCriticalWarning, RESULT_DISPLAY_LABEL, RESULT_DISPLAY_SUMMARY, resultDisplay, scoreNote, settingsWarning, type ResultDisplay, type Scoreboard as Board } from "@/lib/qc/scoring";
import { cn } from "@/lib/utils";

const RESULT_STYLE: Record<ResultDisplay, { text: string; dot: string }> = {
  pass: { text: "text-pass", dot: "bg-pass" },
  // A pass that still has "Needs a human check" items: amber, so it isn't read as a clean pass.
  pass_human_check: { text: "text-revision", dot: "bg-revision" },
  // A possible critical issue the AI couldn't confirm: never shown as a pass.
  check_before_sending: { text: "text-revision", dot: "bg-revision" },
  // A mandatory Golden Rule couldn't be checked (approved value missing or invalid): a settings gap, not a pass.
  check_company_settings: { text: "text-revision", dot: "bg-revision" },
  needs_revision: { text: "text-revision", dot: "bg-revision" },
  fail: { text: "text-fail", dot: "bg-fail" },
};
const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "bg-fail-soft text-fail",
  major: "bg-revision-soft text-revision",
  minor: "bg-secondary text-secondary-foreground",
  suggestion: "bg-muted text-muted-foreground",
};
const categoryLabel = (value: string) => CATEGORIES.find((c) => c.value === value)?.label ?? value;
/** "Required text: Required Text" → "Required text": a label that only repeats its type is said once. */
const titleOf = (title: string) => {
  const [head, ...rest] = title.split(": ");
  return rest.length && rest.join(": ").trim().toLowerCase() === head.trim().toLowerCase() ? head : title;
};
/** Keeps every line short in the summary (the full text stays in "All checks in detail"). */
const short = (text: string | undefined, max = 140) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The QC result (Phase 7), readable in seconds: the result in large type and
 * the score, one line of counts, the PDF download, then what to fix (each
 * issue: what's wrong → how to fix it; a broken Golden Rule is one of them,
 * marked Mandatory / Optional), the items to verify by eye, and the passed
 * checks (collapsed; followed Golden Rules aren't listed). Display only — the findings, scoring and
 * result are computed elsewhere and unchanged; every check's full detail stays
 * in "All checks in detail" further down the page.
 */
export function Scoreboard({ board, findings = [], mock = false, reportHref }: { board: Board; findings?: Finding[]; mock?: boolean; reportHref?: string }) {
  const shown = resultDisplay(board);
  if (!shown) {
    return <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No result yet: none of the checks could be verified.</p>;
  }
  const style = RESULT_STYLE[shown];
  const note = scoreNote(board);
  const warning = possibleCriticalWarning(board);
  const settings = settingsWarning(board);
  const toFix = board.counting.filter((f) => f.severity !== "suggestion");
  const suggestions = board.counting.filter((f) => f.severity === "suggestion");
  const toVerify = findings.filter(needsVerifying);
  const passed = findings.filter((f) => f.status === "passed");
  // Followed Golden Rules are counted as passed, not listed.
  const passedList = passed.filter((f) => !isGoldenRule(f));
  // What couldn't be checked: missing company settings, and design checks that couldn't be confirmed.
  const unchecked = splitNotChecked(findings.filter((f) => f.status === "unverified" && !needsVerifying(f)));

  return (
    <div className="space-y-10">
      {/* 1 — the result, the score, the counts, the report */}
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500" role="status" aria-label={`QC result: ${RESULT_DISPLAY_LABEL[shown]}`}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <p className="eyebrow">Result</p>
            <p className={cn("display mt-2 text-5xl break-words sm:text-7xl", style.text)}>{RESULT_DISPLAY_LABEL[shown]}</p>
            <p className="mt-3 max-w-xl text-base">{RESULT_DISPLAY_SUMMARY[shown]}</p>
            {warning && <p className="mt-2 max-w-xl text-base font-semibold text-fail">{warning}</p>}
            {settings && <p className="mt-2 max-w-xl text-base font-semibold text-revision">{settings}</p>}
          </div>
          {board.score !== null && (
            <p className="shrink-0 text-right">
              <span className="eyebrow block">Score</span>
              <span className="display text-6xl tabular-nums sm:text-7xl">{board.score}</span>
              <span className="text-lg text-muted-foreground"> / 100</span>
              {note && <span className="mt-1 block max-w-[16rem] text-sm text-muted-foreground">{note}</span>}
            </p>
          )}
        </div>

        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="At a glance">
          <Count n={toFix.length} label="Issues to fix" dot={toFix.length ? style.dot : "bg-border"} />
          <Count n={toVerify.length} label="To verify" dot={toVerify.length ? "bg-revision" : "bg-border"} />
          <Count n={passed.length} label={passed.length === 1 ? "Check passed" : "Checks passed"} dot="bg-pass" />
        </ul>

        {reportHref && (
          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
            <a href={reportHref} download className={buttonVariants({ className: "btn-glossy h-12 gap-2 rounded-full px-6 text-base font-semibold" })}>
              <FileDown className="size-4" aria-hidden />
              Download QC report (PDF)
            </a>
            <p className="text-xs text-muted-foreground">Made from this check when you download it. It isn&apos;t saved anywhere — keep the file.</p>
          </div>
        )}
      </div>

      {mock && (
        <p className="rounded-xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">
          Sample data — not real AI. This is not a real QC result.
        </p>
      )}

      {/* 2 — what to fix */}
      <section aria-labelledby="issues-to-fix">
        <Heading id="issues-to-fix">Issues to fix</Heading>
        {toFix.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No issues to fix.</p>
        ) : (
          <ol className="mt-2 divide-y divide-border">
            {toFix.map((f, i) => (
              <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="grid gap-x-4 py-4 sm:grid-cols-[2rem_1fr]">
                <span className="hidden text-lg font-bold text-primary tabular-nums sm:block" aria-hidden>
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", SEVERITY_STYLE[f.severity])}>{severityLabel(f.severity)}</span>
                    <span className="font-semibold">{nameOf(f)}</span>
                    <span className="text-xs text-muted-foreground">{whereOf(f)}</span>
                    <Marker f={f} />
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[4.5rem_1fr]">
                    {f.detected && (
                      <>
                        <dt className="text-muted-foreground">Found</dt>
                        <dd className="min-w-0 break-words">{short(f.detected)}</dd>
                      </>
                    )}
                    {(f.suggestedFix || f.expected) && (
                      <>
                        <dt className="font-medium text-primary">Fix</dt>
                        <dd className="min-w-0 font-medium break-words">{short(f.suggestedFix ?? `Make it: ${f.expected}`)}</dd>
                      </>
                    )}
                  </dl>
                  <AlsoNote f={f} />
                </div>
              </li>
            ))}
          </ol>
        )}
        {suggestions.length > 0 && (
          <Collapsed summary={`${suggestions.length} optional suggestion${suggestions.length === 1 ? "" : "s"}`}>
            <ul className="space-y-1.5 text-sm">
              {suggestions.map((f, i) => (
                <li key={`${f.ruleId}-${i}`}>
                  <span className="font-medium">{nameOf(f)}</span>
                  {f.suggestedFix && <span className="text-muted-foreground"> — {short(f.suggestedFix, 110)}</span>}
                </li>
              ))}
            </ul>
          </Collapsed>
        )}
      </section>

      {/* 3 — items to verify by eye */}
      {toVerify.length > 0 && (
        <section aria-labelledby="items-to-verify">
          <Heading id="items-to-verify">Items to verify</Heading>
          <p className="mt-2 text-sm text-muted-foreground">Please check these by eye before sending. They don&apos;t count for or against the result.</p>
          <ul className="mt-2 divide-y divide-border">
            {toVerify.map((f, i) => (
              <li key={`${f.ruleId}-${i}`} className="py-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", SEVERITY_STYLE[f.severity])}>{severityLabel(f.severity)}</span>
                  <span className="rounded-full bg-revision-soft px-2.5 py-0.5 text-xs font-semibold text-revision">Please verify</span>
                  <span className="font-semibold">{nameOf(f)}</span>
                  <span className="text-xs text-muted-foreground">{whereOf(f)}</span>
                  <Marker f={f} />
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[4.5rem_1fr]">
                  {f.expected && f.expected !== ruleName(f.title) && (
                    <>
                      <dt className="text-muted-foreground">Expected</dt>
                      <dd className="min-w-0 break-words">{short(f.expected)}</dd>
                    </>
                  )}
                  {f.detected && f.detected !== "Not checked" && (
                    <>
                      <dt className="text-muted-foreground">Found</dt>
                      <dd className="min-w-0 break-words">{short(f.detected)}</dd>
                    </>
                  )}
                  <dt className="font-medium text-revision">Check</dt>
                  <dd className="min-w-0 break-words">{verifyNote(f)}</dd>
                </dl>
                <AlsoNote f={f} toVerify />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 4 — passed checks */}
      <section aria-labelledby="passed-checks">
        <Heading id="passed-checks">Passed</Heading>
        {passed.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No checks passed yet.</p>
        ) : (
          <Collapsed summary={`✓ ${passed.length} check${passed.length === 1 ? "" : "s"} passed`} summaryClass="text-pass">
            <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {passedList.map((f, i) => (
                <li key={`${f.ruleId}-${f.fileId ?? ""}-${i}`} className="min-w-0 truncate">
                  <span className="text-muted-foreground">{categoryLabel(f.category)} · </span>
                  {f.title}
                </li>
              ))}
            </ul>
          </Collapsed>
        )}
        {(["settings", "auto"] as const).map((kind) =>
          unchecked[kind].length ? (
            <p key={kind} className="mt-3 text-sm">
              <span className="font-semibold">
                {NOT_CHECKED[kind].label} ({unchecked[kind].length}):
              </span>{" "}
              {unchecked[kind].map((f) => `${nameOf(f)}${isGoldenRule(f) ? " (Golden Rule)" : ""}`).join(" · ")}
              <span className="text-muted-foreground"> — {NOT_CHECKED[kind].note}</span>
            </p>
          ) : null
        )}
      </section>
    </div>
  );
}

/** A Golden Rule by its rule ("Always use Book now"); anything else by its title. */
const nameOf = (f: Finding) => (isGoldenRule(f) ? ruleName(f.title) : titleOf(f.title));
/** "Golden Rule" for a company rule, otherwise the check's category. */
const whereOf = (f: Finding) => (isGoldenRule(f) ? "Golden Rule" : categoryLabel(f.category));

/** A merged finding's one line — the same words as the PDF ("Also required by the brief — counted once."). */
function AlsoNote({ f, toVerify = false }: { f: Finding; toVerify?: boolean }) {
  const also = alsoCoversText(f, categoryLabel);
  return also ? <p className="mt-2 text-sm text-muted-foreground">{alsoNote(also, toVerify)}</p> : null;
}

/** Mandatory / Optional, for a Golden Rule. */
function Marker({ f }: { f: Finding }) {
  if (!isGoldenRule(f) || f.mandatory === undefined) return null;
  return <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{f.mandatory ? "Mandatory" : "Optional"}</span>;
}

/** Score by category — moved out of the summary into "All checks in detail". */
export function CategoryScores({ board }: { board: Board }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
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
                <td className="px-4 py-2 tabular-nums">{c.score === null ? <span className="text-muted-foreground">{categoryScoreText(c)}</span> : c.score}</td>
                <td className="px-4 py-2">{issues.length ? issues.map((s) => `${c.issues[s]} ${severityLabel(s).toLowerCase()}`).join(", ") : <span className="text-muted-foreground">None</span>}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {[c.humanChecks ? `${c.humanChecks} to verify` : "", c.notVerified ? `${c.notVerified} not verified` : ""].filter(Boolean).join(", ") || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Count({ n, label, dot }: { n: number; label: string; dot: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      <span className="font-semibold tabular-nums">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

function Heading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-lg font-semibold tracking-tight">
      {children}
    </h3>
  );
}

function Collapsed({ summary, summaryClass, children }: { summary: string; summaryClass?: string; children: React.ReactNode }) {
  return (
    <details className="group mt-3 rounded-xl bg-muted/60 px-4 py-3">
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
      return "No result: the check didn't finish. Use Try again under Check design above.";
    case "not_configured":
      return "No result: content analysis isn't set up on this server.";
    default:
      return "The result appears after the design is checked.";
  }
}
