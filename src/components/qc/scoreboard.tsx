import type { ReactNode } from "react";
import { ChevronDown, FileDown, TriangleAlert } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CATEGORIES, severityLabel, type Finding, type Severity } from "@/lib/qc/findings";
import { alsoCoversText, alsoNote, isGoldenRule, needsVerifying, NOT_CHECKED, ruleName, splitNotChecked, verifyNote } from "@/lib/qc/golden-rules-view";
import { issuesToFix } from "@/lib/qc/issue-markers";
import { categoryScoreText, possibleCriticalWarning, RESULT_DISPLAY_LABEL, RESULT_DISPLAY_SUMMARY, resultDisplay, scoreNote, settingsWarning, type ResultDisplay, type Scoreboard as Board } from "@/lib/qc/scoring";
import { cn } from "@/lib/utils";

// The result's colour on the teal strip: light green, amber or light red (each readable on the teal).
const RESULT_TONE: Record<ResultDisplay, string> = {
  pass: "#86efac",
  // A pass that still has "Needs a human check" items: amber, so it isn't read as a clean pass.
  pass_human_check: "#fbd38d",
  // A possible critical issue the AI couldn't confirm: never shown as a pass.
  check_before_sending: "#fbd38d",
  // A mandatory Golden Rule couldn't be checked (approved value missing or invalid): a settings gap, not a pass.
  check_company_settings: "#fbd38d",
  needs_revision: "#fbd38d",
  fail: "#fca5a5",
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
/** What a check records when something the brief asks for isn't in the content. */
const NOT_FOUND = "Not found";
/** Keeps every line short in the summary (the full text stays in "All checks in detail"). */
const short = (text: string | undefined, max = 140) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The QC result (Phase 7) in two parts, display only — the findings, scoring and result are computed
 * elsewhere and unchanged; every check's full detail stays in "All checks in detail" further down the page.
 *
 * ResultSummary: a teal strip across the top — the score ring, the result in large type, one line on what
 * it means, the three counts and the PDF download — with any warning as its own bar below.
 * ResultChecks: one table of the checks — Check · Brief / rule says · Design shows · Status — issues to
 * fix first (numbered like the circles on the design, each with its fix; a broken Golden Rule is one of
 * them, marked Mandatory / Optional), then the items to verify by eye, then the passed checks (folded;
 * followed Golden Rules aren't listed). On a phone each row stacks, with its labels.
 */
export function Scoreboard(props: {
  board: Board;
  findings?: Finding[];
  mock?: boolean;
  reportHref?: string;
  /** Shown under the issues to fix when there is something to fix: how to check the fixed design. */
  nextStep?: ReactNode;
}) {
  if (!resultDisplay(props.board)) return <NoResult />;
  return (
    <div className="space-y-8">
      <ResultSummary {...props} />
      <ResultChecks {...props} />
    </div>
  );
}

function NoResult() {
  return <p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">No result yet: none of the checks could be verified.</p>;
}

/** The teal summary strip: score ring, result, what it means, the counts, the PDF — and any warning below it. */
export function ResultSummary({
  board,
  findings = [],
  mock = false,
  reportHref,
}: {
  board: Board;
  findings?: Finding[];
  mock?: boolean;
  reportHref?: string;
}) {
  const shown = resultDisplay(board);
  if (!shown) return <NoResult />;
  const tone = RESULT_TONE[shown];
  const note = scoreNote(board);
  const warning = possibleCriticalWarning(board);
  const settings = settingsWarning(board);
  const toFix = issuesToFix(board);
  const toVerify = findings.filter(needsVerifying);
  const passed = findings.filter((f) => f.status === "passed");

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-500" role="status" aria-label={`QC result: ${RESULT_DISPLAY_LABEL[shown]}`}>
      <div className="grid items-center gap-6 rounded-3xl bg-[linear-gradient(135deg,#0a3644,#0e6377)] p-5 text-white shadow-[0_20px_50px_-30px_rgb(6_28_35/0.9)] sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="flex min-w-0 items-center gap-5">
          {board.score !== null && (
            <span
              className="grid size-24 shrink-0 place-items-center rounded-full"
              style={{ background: `conic-gradient(${tone} ${board.score}%, rgb(255 255 255 / 0.16) 0)` }}
              aria-hidden
            >
              <span className="grid size-[4.75rem] place-items-center rounded-full bg-[#0b4553] text-3xl font-bold tabular-nums">{board.score}</span>
            </span>
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.14em] text-white/70 uppercase">
              Result{board.score !== null && <> · Score {board.score} / 100</>}
            </p>
            <p className="display mt-1 text-3xl break-words sm:text-4xl" style={{ color: tone }}>
              {RESULT_DISPLAY_LABEL[shown]}
            </p>
            <p className="mt-1.5 max-w-xl text-sm text-white/85">{RESULT_DISPLAY_SUMMARY[shown]}</p>
            {note && <p className="mt-1 max-w-xl text-xs text-white/70">{note}</p>}
          </div>
        </div>

        <ul className="grid grid-cols-3 gap-2 text-sm" aria-label="At a glance">
          <Count n={toFix.length} label="Issues to fix" />
          <Count n={toVerify.length} label="To verify" />
          <Count n={passed.length} label={passed.length === 1 ? "Check passed" : "Checks passed"} />
        </ul>

        {reportHref && (
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <a href={reportHref} download className={cn(
                buttonVariants(),
                "h-11 gap-2 rounded-full bg-white px-5 text-sm font-semibold text-[#0b4f67] shadow-[0_10px_24px_-12px_rgb(0_0_0/0.5)] hover:bg-[#e4f1f3]"
              )}>
              <FileDown className="size-4" aria-hidden />
              Download QC report (PDF)
            </a>
            <p className="max-w-[15rem] text-xs text-white/65 lg:text-right">Made from this check when you download it. It isn&apos;t saved anywhere — keep the file.</p>
          </div>
        )}
      </div>

      {warning && (
        <p className="flex items-start gap-2 rounded-2xl bg-fail-soft px-4 py-3 text-sm font-semibold text-fail">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {warning}
        </p>
      )}
      {settings && (
        <p className="flex items-start gap-2 rounded-2xl bg-revision-soft px-4 py-3 text-sm font-semibold text-revision">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {settings}
        </p>
      )}
      {mock && (
        <p className="rounded-2xl bg-revision-soft px-4 py-3 text-sm font-medium text-revision">Sample data — not real AI. This is not a real QC result.</p>
      )}
    </div>
  );
}

/** The table of checks: issues to fix, items to verify, passed (folded), and what couldn't be checked. */
export function ResultChecks({
  board,
  findings = [],
  nextStep,
}: {
  board: Board;
  findings?: Finding[];
  nextStep?: ReactNode;
}) {
  if (!resultDisplay(board)) return null;
  const toFix = issuesToFix(board);
  const suggestions = board.counting.filter((f) => f.severity === "suggestion");
  const toVerify = findings.filter(needsVerifying);
  const passed = findings.filter((f) => f.status === "passed");
  // Followed Golden Rules are counted as passed, not listed.
  const passedList = passed.filter((f) => !isGoldenRule(f));
  // What couldn't be checked: missing company settings, and design checks that couldn't be confirmed.
  const unchecked = splitNotChecked(findings.filter((f) => f.status === "unverified" && !needsVerifying(f)));

  return (
    <div className="space-y-6">
      <section aria-labelledby="issues-to-fix">
        <Heading id="issues-to-fix" count={toFix.length}>
          Issues to fix
        </Heading>
        {toFix.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No issues to fix.</p>
        ) : (
          <Rows>
            {toFix.map((f, i) => (
              <Row
                key={`${f.ruleId}-${f.fileId ?? ""}-${i}`}
                tint="bg-[#fffaf1]"
                check={<CheckName f={f} />}
                expected={f.expected}
                shows={f.detected === NOT_FOUND ? "Not on the design" : short(f.detected)}
                extra={
                  <>
                    {(f.suggestedFix || f.expected) && (
                      <p className="mt-1.5">
                        <span className="font-semibold text-primary">Fix </span>
                        <span className="font-medium">{short(f.suggestedFix ?? `Make it: ${f.expected}`)}</span>
                      </p>
                    )}
                    <AlsoNote f={f} />
                  </>
                }
                status={
                  <Status tone="text-[#9a3412]" icon="bg-[#b45309]" label="Fix">
                    {/* Shown at every width: it matches the numbered circle on the design. */}
                    {i + 1}
                  </Status>
                }
              />
            ))}
          </Rows>
        )}
        {toFix.length > 0 && nextStep}
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

      {toVerify.length > 0 && (
        <section aria-labelledby="items-to-verify">
          <Heading id="items-to-verify" count={toVerify.length}>
            Items to verify
          </Heading>
          <p className="mt-1 text-sm text-muted-foreground">Please check these by eye before sending. They don&apos;t count for or against the result.</p>
          <Rows>
            {toVerify.map((f, i) => (
              <Row
                key={`${f.ruleId}-${i}`}
                tint="bg-[#fffdf3]"
                check={<CheckName f={f} />}
                expected={f.expected && f.expected !== ruleName(f.title) ? short(f.expected) : undefined}
                shows={f.detected && f.detected !== "Not checked" ? short(f.detected) : undefined}
                extra={
                  <>
                    <p className="mt-1.5">
                      <span className="font-semibold text-revision">Check </span>
                      {verifyNote(f)}
                    </p>
                    <AlsoNote f={f} toVerify />
                  </>
                }
                status={
                  <Status tone="text-revision" icon="bg-[#d19a2a]" label="Verify">
                    ?
                  </Status>
                }
              />
            ))}
          </Rows>
        </section>
      )}

      <section aria-labelledby="passed-checks">
        <Heading id="passed-checks" count={passed.length}>
          Passed
        </Heading>
        {passed.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No checks passed yet.</p>
        ) : (
          <Collapsed summary={`✓ ${passed.length} check${passed.length === 1 ? "" : "s"} passed`} summaryClass="text-pass">
            <Rows>
              {passedList.map((f, i) => (
                <Row
                  key={`${f.ruleId}-${f.fileId ?? ""}-${i}`}
                  check={
                    <span className="font-medium">
                      <span className="font-normal text-muted-foreground">{categoryLabel(f.category)} · </span>
                      {f.title}
                    </span>
                  }
                  expected={short(f.expected)}
                  shows={f.detected === NOT_FOUND ? undefined : short(f.detected)}
                  status={
                    <Status tone="text-pass" icon="bg-pass" label="Match">
                      ✓
                    </Status>
                  }
                />
              ))}
            </Rows>
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

// The table's columns: Check · Brief / rule says · Design shows · Status. On a phone each row stacks.
const COLUMNS = "md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1.35fr)_6.5rem] md:gap-4";

/** The table frame, with its column headings (wide screens). */
function Rows({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
      <div className={cn(COLUMNS, "hidden bg-[#f1f6f7] px-4 py-2.5 text-xs font-semibold text-muted-foreground")} aria-hidden>
        <span>Check</span>
        <span>Brief / rule says</span>
        <span>Design shows</span>
        <span>Status</span>
      </div>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

/** One check: its name, what the brief or rule asks for, what the design shows (plus its fix or what to check), and its status. */
function Row({
  check,
  expected,
  shows,
  extra,
  status,
  tint,
}: {
  check: ReactNode;
  expected?: string;
  shows?: string;
  extra?: ReactNode;
  status: ReactNode;
  tint?: string;
}) {
  return (
    <li className={cn(COLUMNS, "grid gap-1.5 px-4 py-3.5 text-sm", tint)}>
      <div className="min-w-0">{check}</div>
      <div className="min-w-0 break-words">
        <span className="text-xs text-muted-foreground md:hidden">Brief / rule says </span>
        {expected || <span className="text-muted-foreground">—</span>}
      </div>
      <div className="min-w-0 break-words">
        <span className="text-xs text-muted-foreground md:hidden">Design shows </span>
        {shows || <span className="text-muted-foreground">—</span>}
        {extra}
      </div>
      <div>{status}</div>
    </li>
  );
}

/** The check's name with its severity, where it comes from, and Mandatory / Optional for a Golden Rule. */
function CheckName({ f }: { f: Finding }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-semibold">{nameOf(f)}</span>
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", SEVERITY_STYLE[f.severity])}>{severityLabel(f.severity)}</span>
      <span className="text-xs text-muted-foreground">{whereOf(f)}</span>
      <Marker f={f} />
    </div>
  );
}

/** The status cell: a small coloured circle (the issue's number, ? or ✓) and a word. */
function Status({ tone, icon, label, children }: { tone: string; icon: string; label: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", tone)}>
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white tabular-nums", icon)} aria-hidden>
        {children}
      </span>
      {label}
    </span>
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

/**
 * Score by category, small: one line per category that was scored — its name, a bar and the score
 * (amber below 100) — for the column under the design. Categories without a score of their own are
 * left out here; the full table is in "All checks in detail".
 */
export function CategoryScoreCard({ board }: { board: Board }) {
  const scored = board.categories.filter((c) => c.score !== null);
  if (scored.length === 0) return null;
  return (
    <section aria-labelledby="score-by-category" className="rounded-2xl bg-card p-4 shadow-sm ring-1 ring-border">
      <h3 id="score-by-category" className="text-sm font-semibold">
        Score by category
      </h3>
      <ul className="mt-3 space-y-2.5">
        {scored.map((c) => (
          <li key={c.category} className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-3 gap-y-1 text-sm">
            <span className="min-w-0 truncate">{c.label}</span>
            <span className={cn("text-right font-semibold tabular-nums", c.score === 100 ? "text-pass" : "text-revision")}>{c.score}</span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className={cn("block h-full rounded-full", c.score === 100 ? "bg-pass" : "bg-[#d19a2a]")} style={{ width: `${c.score}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
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

function Count({ n, label }: { n: number; label: string }) {
  return (
    <li className="min-w-0 rounded-2xl bg-white/10 px-3 py-2.5 sm:min-w-[6.5rem] sm:px-3.5">
      <span className="block text-2xl font-bold tabular-nums">{n}</span>
      <span className="text-white/80">{label}</span>
    </li>
  );
}

function Heading({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-lg font-semibold tracking-tight">
      {children}
      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground tabular-nums">{count}</span>
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
