import { isHumanCheck } from "@/lib/analysis/policy";
import { CATEGORIES, type Category, type Finding, type Severity } from "@/lib/qc/findings";
import { missingCompanySetting, needsVerifying } from "@/lib/qc/golden-rules-view";

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
  /**
   * Other categories where this category's checks are shown, because a finding of theirs was the same
   * issue and stands for it (lib/qc/consolidate.ts, alsoCovers) — e.g. Brand's font check merged into a
   * Golden Rule. Display only: such a category ran, even when it has no score of its own.
   */
  seeAlso: string[];
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
  /** Of those, "possible critical issue": a CRITICAL the evidence couldn't confirm (lib/analysis/policy.ts). Never counted. */
  possibleCriticals: number;
  /** Mandatory Golden Rules that can't be checked until the company saves their approved value. Never counted. */
  settingsBlockers: number;
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

/**
 * A possible CRITICAL issue only a person can settle — never counted, but never a PASS either:
 *   - "Needs a human check — possible critical issue": a critical the evidence couldn't confirm;
 *   - a MANDATORY Golden Rule written only in words ("logo rule", "other"), or one the analysis couldn't
 *     check (e.g. colours not measured): it can only be checked by eye.
 * All are what lib/qc/golden-rules-view.ts marks "Please verify" (needsVerifying), at CRITICAL.
 */
export const isPossibleCritical = (f: Finding): boolean => f.severity === "critical" && needsVerifying(f);

/**
 * A MANDATORY Golden Rule that couldn't be checked because of the company's settings: no approved value
 * saved ("No approved value is saved for this rule…"), or one that can't be used ("The colour saved for
 * this rule (…) isn't a colour code…"). A company-settings gap, not a design mistake: never counted, but
 * the design can't be called a PASS while a mandatory rule went unchecked.
 */
export const isUnconfiguredMandatoryRule = (f: Finding): boolean =>
  f.category === "golden_rules" && f.mandatory === true && f.status === "unverified" && missingCompanySetting(f);

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
      seeAlso: [
        ...new Set(
          findings
            .filter((f) => f.category !== value && f.alsoCovers?.some((c) => c.category === value))
            .map((f) => CATEGORIES.find((c) => c.value === f.category)?.label ?? f.category)
        ),
      ],
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
    possibleCriticals: findings.filter(isPossibleCritical).length,
    settingsBlockers: findings.filter(isUnconfiguredMandatoryRule).length,
    notApplicable,
    answered: passed + failed,
    applicable: findings.length - notApplicable,
    categories,
    counting: findings.filter((f) => f.status === "failed").sort((a, b) => ORDER[a.severity] - ORDER[b.severity]),
  };
}

/**
 * A category's score as the score table shows it: the score; or, with none of its own, where its checks
 * are shown when they were merged into another category's finding ("Checked — see Golden Rules"); or
 * "Not checked". The same words on the website and in the report.
 */
export function categoryScoreText(c: Pick<CategoryScore, "score" | "seeAlso">): string {
  if (c.score !== null) return `${c.score}`;
  return c.seeAlso.length ? `Checked — see ${c.seeAlso.join(", ")}` : "Not checked";
}

export const RESULT_LABEL: Record<QcResult, string> = { pass: "PASS", needs_revision: "NEEDS REVISION", fail: "FAIL" };

/**
 * How the result is SHOWN (banner and PDF). Display only: the result itself
 * (resultOf) is unchanged and human checks still never count.
 *   - A PASS with a possible critical issue to check by eye is shown as
 *     "CHECK BEFORE SENDING" — never as a PASS: a critical issue may be there,
 *     only the AI couldn't confirm it (e.g. a mandatory price it didn't read).
 *   - A PASS with other "Needs a human check" items is "PASS — PLEASE VERIFY",
 *     so it can't be mistaken for a clean pass.
 * NEEDS REVISION and FAIL are shown as they are.
 */
export type ResultDisplay = QcResult | "pass_human_check" | "check_before_sending" | "check_company_settings";

type DisplayInput = { result: QcResult | null; humanChecks: number; possibleCriticals: number; settingsBlockers: number };

/**
 * …and a PASS while a mandatory Golden Rule couldn't be checked for want of its saved value is
 * "CHECK COMPANY SETTINGS": not a design failure, but not a pass either. A possible critical issue on the
 * design comes first (CHECK BEFORE SENDING); the settings gap is then a warning line (settingsWarning).
 */
export function resultDisplay(board: DisplayInput): ResultDisplay | null {
  if (!board.result) return null;
  if (board.result !== "pass") return board.result;
  if (board.possibleCriticals > 0) return "check_before_sending";
  if (board.settingsBlockers > 0) return "check_company_settings";
  return board.humanChecks > 0 ? "pass_human_check" : "pass";
}

export const RESULT_DISPLAY_LABEL: Record<ResultDisplay, string> = {
  ...RESULT_LABEL,
  pass_human_check: "PASS — PLEASE VERIFY",
  check_before_sending: "CHECK BEFORE SENDING",
  check_company_settings: "CHECK COMPANY SETTINGS",
};

export const RESULT_DISPLAY_SUMMARY: Record<ResultDisplay, string> = {
  pass: "No issues to fix in the checks that could be verified.",
  pass_human_check: "No issues found — but please verify the items marked below before sending it to the client.",
  check_before_sending: "A possible critical issue couldn't be confirmed automatically. Check the items marked below by eye — don't send it to the client until you have.",
  check_company_settings: "No issues found in the checks that ran, but a mandatory Golden Rule couldn't be checked because its approved value is missing or invalid. Fix it on the company page, then check the design again before sending it to the client.",
  needs_revision: "Fix the issues below before sending it to the client.",
  fail: "There is at least one critical issue. Don't send it until it's fixed.",
};

const possibleCriticalText = (n: number) => (n === 1 ? "1 possible critical issue" : `${n} possible critical issues`);
const blockerText = (n: number) => (n === 1 ? "1 mandatory Golden Rule" : `${n} mandatory Golden Rules`);

/**
 * Shown under the score while possible critical issues or unchecked mandatory Golden Rules are open
 * (CHECK BEFORE SENDING, CHECK COMPANY SETTINGS…): the score covers the confirmed checks only — those
 * items don't count — so a high score isn't a verified one. Display only: the score itself is unchanged.
 */
export function scoreNote(board: { score: number | null; possibleCriticals: number; settingsBlockers: number }): string | null {
  if (board.score === null || (board.possibleCriticals === 0 && board.settingsBlockers === 0)) return null;
  const open = [
    board.possibleCriticals ? `${possibleCriticalText(board.possibleCriticals)} still to check by eye` : "",
    board.settingsBlockers ? `${blockerText(board.settingsBlockers)} not checked (approved value missing or invalid)` : "",
  ].filter(Boolean);
  return `Confirmed checks only — ${open.join("; ")}.`;
}

/**
 * A mandatory Golden Rule went unchecked for want of a usable saved value, and the result is something other
 * than CHECK COMPANY SETTINGS (which says so itself): say so beside it, so it isn't missed.
 */
export function settingsWarning(board: DisplayInput): string | null {
  if (board.settingsBlockers === 0 || resultDisplay(board) === "check_company_settings" || !board.result) return null;
  const n = board.settingsBlockers;
  return `${blockerText(n)} couldn't be checked because ${n === 1 ? "its approved value is" : "their approved values are"} missing or invalid — fix ${n === 1 ? "it" : "them"} on the company page.`;
}

/**
 * NEEDS REVISION with a possible critical issue: the label says "revise", so it also warns that a critical
 * item still has to be checked — if it's confirmed, the design fails. (FAIL already says don't send;
 * CHECK BEFORE SENDING says it in its own summary.)
 */
export function possibleCriticalWarning(board: DisplayInput): string | null {
  if (resultDisplay(board) !== "needs_revision" || board.possibleCriticals === 0) return null;
  return `Also check ${possibleCriticalText(board.possibleCriticals)} marked below by eye before sending — if confirmed, this design fails.`;
}
