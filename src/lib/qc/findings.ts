import type { ContentType } from "@/lib/qc/content-types";

/**
 * The QC engine's shared vocabulary (plan 5.1) and rule format (5.2).
 * Every rule — platform / size now, content, brand, Golden Rules and the
 * rest in later rounds — reports in this one shape.
 *
 * Scoring and PASS / NEEDS REVISION / FAIL are Phase 7 (lib/qc/scoring.ts)
 * and read these findings; nothing here decides a result.
 */

/** The nine QC categories (plan 5.4–5.12). */
export const CATEGORIES = [
  { value: "content", label: "Content" },
  { value: "brand", label: "Brand" },
  { value: "golden_rules", label: "Golden Rules" },
  { value: "design_layout", label: "Design & Layout" },
  { value: "accessibility", label: "Accessibility" },
  { value: "image_asset", label: "Image & Asset" },
  { value: "brief", label: "Brief" },
  { value: "platform_size", label: "Platform / Size" },
  { value: "legal", label: "Legal & Compliance" },
] as const;
export type Category = (typeof CATEGORIES)[number]["value"];

/**
 * How serious a failed check is. ONLY findings with status "failed" count
 * towards the result (Phase 7): a passed, unverified or not-applicable
 * finding still carries the severity it WOULD have, for display, but never
 * counts — e.g. a mandatory requirement not yet verified is "critical" +
 * "unverified", and must not turn the result into FAIL.
 */
export const SEVERITIES = ["critical", "major", "minor", "suggestion"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * passed / failed — the check ran and has an answer;
 * unverified — something it needs is missing (approved information or a
 *   detection), so there is no answer — never a guess (plan 5.13);
 * not_applicable — the check doesn't apply here.
 */
export type FindingStatus = "passed" | "failed" | "unverified" | "not_applicable";

/** fact — measured / compared objectively; judgement — a recommendation (worded as one). */
export type FindingKind = "fact" | "judgement";

export type Finding = {
  ruleId: string;
  category: Category;
  title: string;
  severity: Severity;
  status: FindingStatus;
  kind: FindingKind;
  expected?: string;
  detected?: string;
  explanation: string;
  suggestedFix?: string;
  /** 0–1. Deterministic measurements are 1. */
  confidence: number;
  /** Which uploaded file the finding is about, when it is about one. */
  fileId?: string;
  fileName?: string;
  source?: { label: string; url: string };
  /** Golden Rules: whether the company marked the rule mandatory. */
  mandatory?: boolean;
  /** The confirmed brief requirement this finding checks (brief and legal checks) — how the report links them. */
  requirementId?: string;
  /** Other checks this finding also stands for, when they were the same issue (lib/qc/golden-rules-view.ts). */
  alsoCovers?: { ruleId: string; category: Category; title: string; requirementId?: string }[];
};

/** A rule definition (plan 5.2): what it is, where it applies, what it needs. */
export type Rule<Context> = {
  id: string;
  category: Category;
  appliesTo: readonly ContentType[];
  /** What the rule needs; when missing it reports UNVERIFIED. Documentation for now. */
  needs: readonly string[];
  defaultSeverity: Severity;
  mandatory: boolean;
  run(context: Context): Finding[];
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, suggestion: 3 };
const STATUS_ORDER: Record<FindingStatus, number> = { failed: 0, unverified: 1, passed: 2, not_applicable: 3 };

/** Most important first: failures by severity, then not verified, then passed. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.ruleId.localeCompare(b.ruleId)
  );
}

export function severityLabel(severity: Severity): string {
  return { critical: "Critical", major: "Major", minor: "Minor", suggestion: "Suggestion" }[severity];
}
