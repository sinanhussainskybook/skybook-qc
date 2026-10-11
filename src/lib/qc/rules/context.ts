import type { CompanyConfiguration } from "@/lib/company/types";
import type { ContentType } from "@/lib/qc/content-types";
import type { ContentDetections } from "@/lib/qc/detections";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import type { QcInputRequirement } from "@/lib/qc/qc-input";
import type { PlatformContext } from "@/lib/qc/rules/platform-size";

/**
 * Everything one QC check reads — the engine's single input (plan Phase 5):
 * approved information (company configuration, confirmed requirements,
 * platform choice) + what was detected in the content (null until Phase 6).
 */
export type QcContext = {
  contentType: ContentType;
  company: CompanyConfiguration;
  /** Confirmed requirements only. */
  requirements: QcInputRequirement[];
  platform: PlatformContext;
  detections: ContentDetections | null;
  /** Why there are no (or only partial) detections — chooses the "not verified" wording. Phase 6 addition. */
  analysis?: AnalysisState;
};

/** State of content analysis for this session (Phase 6, approved additive change). */
export type AnalysisState =
  | { state: "not_configured" }
  | { state: "not_started" }
  | { state: "pending" }
  /** `analysedShare` < 1: only part of the content was analysed (e.g. the first 15 minutes of a long video). */
  | { state: "done"; analysedShare?: number }
  | { state: "failed"; reason: string }
  | { state: "unsupported"; reason: string };

/** Below this, a finding based on detection is worded as a judgement, not a fact. */
export const FACT_CONFIDENCE = 0.8;

/**
 * Marker explanation used by every rule when a detection it needs is
 * missing. Shown as-is only when nothing more specific is known; the
 * analysis step (lib/analysis/policy.ts) swaps in the reason for the session.
 */
export const NEEDS_ANALYSIS =
  "This needs the content to be analysed (text, colours, fonts, logo, images), and no analysis result is available. Not counted for or against the result.";

/** The "not verified" wording for each analysis state. */
export function notAnalysedExplanation(analysis: AnalysisState | undefined): string {
  switch (analysis?.state) {
    case "not_configured":
      return "Content analysis isn't set up on this server, so this can't be checked. Not counted for or against the result.";
    case "not_started":
      return "The content hasn't been analysed yet — it is analysed when you press Check Design. Not counted for or against the result.";
    case "pending":
      return "The content is being analysed. This updates when the analysis finishes. Not counted for or against the result.";
    case "failed":
      return `The analysis didn't finish (${analysis.reason}), so this couldn't be checked. Not counted for or against the result.`;
    case "unsupported":
      return `This couldn't be analysed (${analysis.reason}). Not counted for or against the result.`;
    case "done":
      return "The analysis didn't produce what this check needs, so it couldn't be checked. Not counted for or against the result.";
    default:
      return NEEDS_ANALYSIS;
  }
}

type Parts = {
  severity: Severity;
  status: FindingStatus;
  expected?: string;
  detected?: string;
  explanation: string;
  suggestedFix?: string;
  confidence?: number;
  /**
   * "judgement" for SUBJECTIVE checks (design taste, interpretation): always
   * worded as a recommendation, whatever the detection's confidence.
   * Omitted → a fact, unless the detection itself is unsure.
   */
  kind?: "judgement";
  fileId?: string;
  fileName?: string;
};

/** Builds findings for one rule, in the one shared shape (5.1). */
export function findingFor(ruleId: string, category: Category, title: string) {
  return (parts: Parts): Finding => {
    const confidence = parts.status === "unverified" ? 0 : (parts.confidence ?? 1);
    return {
      ruleId,
      category,
      title,
      severity: parts.severity,
      status: parts.status,
      kind: parts.kind ?? (confidence < FACT_CONFIDENCE && parts.status !== "unverified" ? "judgement" : "fact"),
      expected: parts.expected,
      detected: parts.detected,
      explanation: parts.explanation,
      suggestedFix: parts.status === "failed" ? parts.suggestedFix : undefined,
      confidence,
      fileId: parts.fileId,
      fileName: parts.fileName,
    };
  };
}

/** One NOT VERIFIED finding, for when approved information or a detection is missing (5.13). */
export function notVerified(
  ruleId: string,
  category: Category,
  title: string,
  severity: Severity,
  explanation: string,
  expected?: string
): Finding {
  return findingFor(ruleId, category, title)({ severity, status: "unverified", explanation, expected, detected: "Not checked" });
}

export function notApplicable(ruleId: string, category: Category, title: string, explanation: string): Finding {
  return findingFor(ruleId, category, title)({ severity: "suggestion", status: "not_applicable", explanation });
}

export const VISUAL_TYPES = ["design_poster", "social_post"] as const satisfies readonly ContentType[];
export const VIDEO_TYPES = ["reel_short", "youtube_video"] as const satisfies readonly ContentType[];
export const ALL_TYPES = [...VISUAL_TYPES, ...VIDEO_TYPES] as const;

/** Mandatory requirement / rule broken → CRITICAL; optional → `optional`. */
export const severityFor = (mandatory: boolean, optional: Severity = "major"): Severity =>
  mandatory ? "critical" : optional;
