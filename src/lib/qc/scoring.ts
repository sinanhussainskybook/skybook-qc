import { isHumanCheck } from "@/lib/analysis/policy";
import { CATEGORIES, type Category, type Finding, type Severity } from "@/lib/qc/findings";

/**
 * Score and result (Phase 7). Reads the findings the frozen Phase 5 rules
 * produce, AFTER the confidence policy (6.9) — it never re-judges them.
 *
 * Only FAILED findings count. A not-verified finding (including "Needs a
 * human check") and a not-applicable one never count for or against — so AI
 * uncertainty can't fail a design: the policy already turned it into
 * "unverified". Severity decides the result; the score only informs it:
 *   1. any counting CRITICAL            → FAIL (whatever the score)
 *   2. otherwise any MAJOR or MINOR      → NEEDS REVISION
 *   3. otherwise                         → PASS (suggestions never block)
 * When no check could be answered at all there is no result yet — a PASS
 * would claim checks that never ran.
 *
 * Score (plan proposal, D7 to confirm): each category with at least one
 * answered check starts at 100 and loses 40 / 15 / 5 / 0 per counting
 * critical / major / minor / suggestion (never below 0); the overall score
 * is the average of those categories, rounded.
 */

export const SCORE_WEIGHTS: Record<Severity, number> = { critical: 40, major: 15, minor: 5, suggestion: 0 };

export type QcResult = "pass" | "needs_revision" | "fail";

export type SeverityCounts = Record<Severity, number>;

export type CategoryScore = {
  category: Category;
  label: string;
  /** null when the category had no answered (passed / failed) check. */
  score: number | null;
  /** Counting (failed) findings by severity. */
  issues: SeverityCounts;
  passed: number;
  notVerified: number;
  humanChecks: number;
  notApplicable: number;
};

export type Scoreboard = {
  /** null = no result yet (nothing could be checked). */
  result: QcResult | null;
  /** 0–100, or null when no category had an answered check. */
  score: number | null;
  issues: SeverityCounts;
  passed: number;
  /** Not verified for any reason other than a human check (missing information, not analysed…). */
  notVerified: number;
  /** "Needs a human check" — uncertain readings or AI judgements; never counted. */
  humanChecks: number;
  notApplicable: number;
  /** Checks with an answer (passed + failed) out of all checks that apply. */
  answered: number;
  applicable: number;
  categories: CategoryScore[];
  /** The counting issues, most serious first. */
  counting: Finding[];
};

const emptyCounts = (): SeverityCounts => ({ critical: 0, major: 0, minor: 0, suggestion: 0 });
const ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, suggestion: 3 };

export function categoryScore(issues: SeverityCounts): number {
  const lost = (Object.keys(SCORE_WEIGHTS) as Severity[]).reduce((sum, s) => sum + SCORE_WEIGHTS[s] * issues[s], 0);
  return Math.max(0, 100 - lost);
}

export function resultOf(issues: SeverityCounts): QcResult {
  if (issues.critical > 0) return "fail";
  if (issues.major > 0 || issues.minor > 0) return "needs_revision";
  return "pass";
}

export function scoreFindings(findings: Finding[]): Scoreboard {
  const categories: CategoryScore[] = CATEGORIES.map(({ value, label }) => {
    const own = findings.filter((f) => f.category === value);
    const issues = emptyCounts();
    for (const f of own) if (f.status === "failed") issues[f.severity]++;
    const passed = own.filter((f) => f.status === "passed").length;
    const failed = own.filter((f) => f.status === "failed").length;
    const humanChecks = own.filter(isHumanCheck).length;
    return {
      category: value,
      label,
      score: passed + failed > 0 ? categoryScore(issues) : null,
      issues,
      passed,
      notVerified: own.filter((f) => f.status === "unverified").length - humanChecks,
      humanChecks,
      notApplicable: own.filter((f) => f.status === "not_applicable").length,
    };
  });

  const issues = emptyCounts();
  for (const c of categories) for (const s of Object.keys(issues) as Severity[]) issues[s] += c.issues[s];
  const scored = categories.filter((c) => c.score !== null);
  const sum = (pick: (c: CategoryScore) => number) => categories.reduce((n, c) => n + pick(c), 0);
  const passed = sum((c) => c.passed);
  const failed = issues.critical + issues.major + issues.minor + issues.suggestion;
  const notApplicable = sum((c) => c.notApplicable);

  return {
    result: passed + failed > 0 ? resultOf(issues) : null,
    score: scored.length ? Math.round(scored.reduce((n, c) => n + (c.score ?? 0), 0) / scored.length) : null,
    issues,
    passed,
    notVerified: sum((c) => c.notVerified),
    humanChecks: sum((c) => c.humanChecks),
    notApplicable,
    answered: passed + failed,
    applicable: findings.length - notApplicable,
    categories,
    counting: findings.filter((f) => f.status === "failed").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]),
  };
}

export const RESULT_LABEL: Record<QcResult, string> = { pass: "PASS", needs_revision: "NEEDS REVISION", fail: "FAIL" };

/**
 * How the result is SHOWN (banner and PDF). Display only: the result itself
 * (resultOf) is unchanged and human checks still never count. A PASS with one
 * or more "Needs a human check" items is shown as "PASS — HUMAN CHECK REQUIRED",
 * so it can't be mistaken for a clean pass.
 */
export type ResultDisplay = QcResult | "pass_human_check";

export function resultDisplay(board: { result: QcResult | null; humanChecks: number }): ResultDisplay | null {
  if (!board.result) return null;
  return board.result === "pass" && board.humanChecks > 0 ? "pass_human_check" : board.result;
}

export const RESULT_DISPLAY_LABEL: Record<ResultDisplay, string> = { ...RESULT_LABEL, pass_human_check: "PASS — HUMAN CHECK REQUIRED" };

export const RESULT_DISPLAY_SUMMARY: Record<ResultDisplay, string> = {
  pass: "No issues to fix in the checks that could be verified.",
  pass_human_check: "No issues to fix in the checks that could be verified — but some items need a human check before it goes to the client.",
  needs_revision: "Fix the issues below before sending it to the client.",
  fail: "There is at least one critical issue. Don't send it until it's fixed.",
};
