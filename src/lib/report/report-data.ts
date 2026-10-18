import { isHumanCheck } from "@/lib/analysis/policy";
import type { CompanyConfiguration } from "@/lib/company/types";
import type { QcFile, QcRequirement, QcSession } from "@/lib/db/qc-sessions";
import { contentTypeLabel } from "@/lib/qc/content-types";
import { CATEGORIES, severityLabel, sortFindings, type Finding, type Severity } from "@/lib/qc/findings";
import { alsoCoversText, isGoldenRule, needsVerifying, ruleName } from "@/lib/qc/golden-rules-view";
import { findPlacement, findPlatform } from "@/lib/qc/platforms";
import { isCheckable, requirementTypeLabel } from "@/lib/qc/requirements";
import { possibleCriticalWarning, RESULT_DISPLAY_LABEL, RESULT_DISPLAY_SUMMARY, resultDisplay, scoreNote, settingsWarning, type QcResult, type Scoreboard } from "@/lib/qc/scoring";

/**
 * The QC report (Phase 8) as plain data — what the PDF shows, built from the
 * CURRENT session's findings and Phase 7 result. Never stored: the report is
 * made on download and only the designer keeps the file.
 */

export type ReportItem = {
  severity: string;
  category: string;
  title: string;
  expected?: string;
  detected?: string;
  explanation: string;
  fix?: string;
  file?: string;
  /** Golden Rules: "Mandatory" or "Optional". */
  marker?: string;
  /** Other checks this one also stands for ("Brief — CTA"), when they were the same issue. */
  alsoCovers?: string;
};


export type ReportData = {
  companyName: string;
  generatedAt: string;
  contentType: string;
  platform: string | null;
  files: string[];
  result: QcResult | null;
  resultLabel: string;
  resultSummary: string;
  score: number | null;
  issues: Record<Severity, number>;
  humanCheckCount: number;
  /** Of those, possible critical issues — the result is shown as CHECK BEFORE SENDING, never PASS. */
  possibleCriticalCount: number;
  /** Under the score while possible critical issues are open: it covers the confirmed checks only. */
  scoreNote: string | null;
  /** NEEDS REVISION with a possible critical issue: a warning that it must still be checked. */
  warning: string | null;
  /** Mandatory Golden Rules that couldn't be checked for want of their saved value (CHECK COMPANY SETTINGS). */
  settingsBlockerCount: number;
  /** Those rules, beside any other result: add the value on the company page. */
  settingsWarning: string | null;
  notVerifiedCount: number;
  answered: number;
  applicable: number;
  categories: { label: string; score: string; issues: string; notCounted: string }[];
  requirements: { type: string; value: string; mandatory: boolean; status: string }[];
  unconfirmedRequirements: number;
  /** Every counting issue, Golden Rules included (a Golden Rule carries its Mandatory / Optional marker). */
  issuesToFix: ReportItem[];
  /** What a person has to verify by eye (lib/qc/golden-rules-view.ts needsVerifying) — never counted. */
  humanChecks: ReportItem[];
  notVerified: ReportItem[];
  passedCount: number;
  /** Set when the results come from the labelled sample provider. */
  sampleData: boolean;
  /** "Local AI" when the local provider produced the results. */
  providerNote: string | null;
};

/** The same wording as the Start QC banner (lib/qc/scoring.ts). */
export const RESULT_SUMMARY: Record<QcResult, string> = {
  pass: RESULT_DISPLAY_SUMMARY.pass,
  needs_revision: RESULT_DISPLAY_SUMMARY.needs_revision,
  fail: RESULT_DISPLAY_SUMMARY.fail,
};

const categoryLabel = (value: string) => CATEGORIES.find((c) => c.value === value)?.label ?? value;

function item(f: Finding, severity = severityLabel(f.severity)): ReportItem {
  const golden = isGoldenRule(f);
  return {
    severity,
    category: categoryLabel(f.category),
    title: f.title,
    expected: f.expected,
    detected: f.detected,
    explanation: f.explanation,
    fix: f.suggestedFix,
    file: f.fileName,
    ...(golden ? { title: ruleName(f.title), marker: f.mandatory === false ? "Optional" : "Mandatory" } : {}),
    ...(f.alsoCovers?.length ? { alsoCovers: alsoCoversText(f, categoryLabel) ?? undefined } : {}),
  };
}

function statusOf(f: Finding | undefined): string {
  if (!f) return "Not checked";
  if (isHumanCheck(f)) return "Needs a human check";
  if (f.status === "failed") return `To fix (${severityLabel(f.severity)})`;
  return { passed: "Passed", unverified: "Not verified", not_applicable: "Not applicable", failed: "To fix" }[f.status];
}

/**
 * The finding that checked a confirmed requirement, by the requirement's id (never by comparing text:
 * the check may word the value differently, e.g. "1080 × 1080 px" for "1080x1080", and two
 * requirements can ask for the same value). A requirement merged into another finding (the same issue,
 * lib/qc/golden-rules-view.ts) is answered by that finding. Several findings — one per design — give the
 * most important status: to fix, then to verify, then passed.
 */
function findingFor(r: QcRequirement, findings: Finding[]): Finding | undefined {
  const about = findings.filter((f) => f.requirementId === r.id || f.alsoCovers?.some((c) => c.requirementId === r.id));
  return sortFindings(about)[0];
}


export function formatReportDate(date: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(date);
  }
}

export function buildReportData(input: {
  config: CompanyConfiguration;
  session: QcSession;
  requirements: QcRequirement[];
  files: QcFile[];
  findings: Finding[];
  board: Scoreboard;
  sampleData: boolean;
  provider: string | null;
  generatedAt: Date;
  timeZone: string;
}): ReportData {
  const { board, findings } = input;
  const platform = findPlatform(input.session.platform);
  const placement = findPlacement(platform, input.session.placement);
  const shown = resultDisplay(board);
  const confirmed = input.requirements.filter((r) => r.confirmed);
  return {
    companyName: input.config.company.name,
    generatedAt: formatReportDate(input.generatedAt, input.timeZone),
    contentType: contentTypeLabel(input.session.content_type),
    platform: platform ? [platform.label, placement?.label].filter(Boolean).join(" — ") : null,
    files: input.files.filter((f) => f.kind === "content").map((f) => f.file_name),
    result: board.result,
    resultLabel: shown ? RESULT_DISPLAY_LABEL[shown] : "NO RESULT YET",
    resultSummary: shown ? RESULT_DISPLAY_SUMMARY[shown] : "None of the checks could be verified, so there is no result.",
    score: board.score,
    issues: board.issues,
    humanCheckCount: board.humanChecks,
    possibleCriticalCount: board.possibleCriticals,
    scoreNote: scoreNote(board),
    warning: possibleCriticalWarning(board),
    settingsBlockerCount: board.settingsBlockers,
    settingsWarning: settingsWarning(board),
    notVerifiedCount: board.notVerified,
    answered: board.answered,
    applicable: board.applicable,
    categories: board.categories.map((c) => {
      const issues = (["critical", "major", "minor", "suggestion"] as const).filter((s) => c.issues[s] > 0);
      return {
        label: c.label,
        score: c.score === null ? "Not checked" : `${c.score}`,
        issues: issues.length ? issues.map((s) => `${c.issues[s]} ${severityLabel(s).toLowerCase()}`).join(", ") : "None",
        notCounted: [c.humanChecks ? `${c.humanChecks} to verify` : "", c.notVerified ? `${c.notVerified} not verified` : ""].filter(Boolean).join(", ") || "-",
      };
    }),
    requirements: confirmed.map((r) => ({
      type: requirementTypeLabel(r.type) + (r.label ? ` (${r.label})` : ""),
      value: r.expected_value,
      mandatory: r.mandatory,
      status: statusOf(findingFor(r, findings)),
    })),
    // Descriptive brief items (campaign, instructions…) are never checked on purpose — not "unused".
    unconfirmedRequirements: input.requirements.filter((r) => !r.confirmed && isCheckable(r)).length,
    issuesToFix: board.counting.map((f) => item(f)),
    humanChecks: findings.filter(needsVerifying).map((f) => item(f)),
    notVerified: findings.filter((f) => f.status === "unverified" && !needsVerifying(f)).map((f) => item(f, "Not verified")),
    passedCount: board.passed,
    sampleData: input.sampleData,
    providerNote: input.provider === "local" ? "Local AI (on this server)" : null,
  };
}
