import { datesWrittenOneWay, normalizeWords } from "@/lib/qc/compare";
import type { ContentDetections } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import { NEEDS_ANALYSIS, notAnalysedExplanation, type AnalysisState } from "@/lib/qc/rules/context";
import { LOCAL_UNCONFIRMED_CAP } from "@/lib/analysis/validate";

/**
 * The confidence policy (plan 6.9; locked 2026-10-04). Applied ONCE to the
 * findings the frozen Phase 5 rules produce — the rules themselves are not
 * changed.
 *
 * In plain English:
 *   - Measured things count (sizes, pixel colours, contrast, audio levels,
 *     text the OCR read clearly).
 *   - Text that could FAIL a design (a CRITICAL) needs a very clear reading;
 *     "missing" needs the whole content to have been read clearly too.
 *   - AI opinions can ask for revision (MAJOR / MINOR) only when the model
 *     says it is clear — never fail a design. An AI-only critical becomes
 *     "Needs a human check — possible critical issue".
 *   - Suggestions never block anything. Not analysed → NOT VERIFIED.
 *
 * "Needs a human check" = status unverified: shown with expected and
 * detected, never counted for or against the result.
 */
export const POLICY = {
  measured: 0.8,
  measuredCritical: 0.9,
  coverage: 0.9,
  /** AI certainty "clear" maps to 0.9 (lib/analysis/assemble.ts). */
  aiClear: 0.9,
} as const;

export const HUMAN_CHECK = "Needs a human check";
export const HUMAN_CHECK_CRITICAL = "Needs a human check — possible critical issue";

/**
 * Evidence register: what each rule's failures are based on.
 *   text     — words in the content (OCR = measured; speech = AI)
 *   measured — pixels, geometry from OCR boxes, timing, audio, file facts
 *   ai       — a model's judgement (roles, fonts, logo, image quality…)
 *   none     — never decided automatically (always not verified)
 * Longest matching prefix wins. A rule missing here is treated as "ai"
 * (the safe side), and a test fails until it is registered.
 */
export const EVIDENCE: Record<string, "text" | "measured" | "ai" | "none"> = {
  "content.contact_details": "text",
  "content.company_name": "text",
  "content.placeholder": "text",
  "content.repeated_word": "text",
  "brand.colors.present": "measured",
  "brand.colors.text": "measured",
  "brand.colors": "measured",
  "brand.fonts": "ai",
  "brand.terms": "text",
  "brand.logo": "ai",
  "brand.written_guidelines": "none",
  "golden_rules.rule.mandatory_disclaimer": "text",
  "golden_rules.rule.approved_product_name": "text",
  "golden_rules.rule.approved_cta": "ai", // which text is the CTA is a role judgement
  "golden_rules.rule.approved_color": "measured",
  "golden_rules.rule.approved_font": "ai",
  "golden_rules.rule.logo_rule": "none",
  "golden_rules.rule.other": "none",
  "golden_rules.rule": "none",
  "layout.text_overlap": "measured",
  "layout.edge_margin": "measured",
  "layout.hierarchy": "ai",
  "layout.rule_of_thirds": "ai",
  "layout.on_screen_time": "measured",
  "accessibility.contrast": "measured",
  "accessibility.text_size": "measured",
  "accessibility.color_only": "ai",
  "accessibility.captions": "ai", // depends on the transcript
  "image.quality": "ai",
  "image.audio": "measured",
  "brief.requirement.cta": "ai", // a different CTA is found by role
  "brief.requirement.headline": "ai", // a different headline is found by role
  "brief.requirement.dimensions": "measured", // the file's own size against an exact size in the brief
  "brief.requirement": "text",
  "brief.unexpected": "text",
  "platform": "measured",
  // Where text and logos sit: positions from the analysis (the logo's always from AI, text from AI with
  // Gemini), not the file's own measurements — so never a reliable measurement on its own.
  "platform.safe_zone": "ai",
  "legal.disclaimer": "text",
};

/** Failures that mean "it isn't there" — they also need the text to have been read completely. */
const ABSENCE_RULES = ["brief.requirement", "legal.disclaimer", "golden_rules.rule.mandatory_disclaimer"];

/**
 * A PASS that says "nothing wrong anywhere" (no placeholder, no overlap,
 * contrast fine…) is only true if the whole content was read. These passes
 * don't depend on that: the file's own measurements, and "it was found"
 * (a required item seen once is there, whatever the rest says).
 */
const PASS_WITHOUT_FULL_COVERAGE = ["platform", ...ABSENCE_RULES];
/** …except the safe zone: "everything is inside" covers every text and logo, so it needs them all read. */
const NEEDS_FULL_COVERAGE = ["platform.safe_zone"];
export const PARTLY_ANALYSED = "Not verified: only part of the content could be read clearly, so this can't be confirmed for all of it.";
/**
 * The LOCAL provider's extra rules (2026-10-06 trial findings; Google and the
 * mock are unchanged):
 *   - a text-based CRITICAL needs confidence ≥ 0.95, and local OCR only
 *     reaches 0.90+ when an independent second read agreed (validate.ts);
 *   - "missing" text can't be a CRITICAL: local OCR can't measure what its
 *     detector missed → "Needs a human check — possible critical issue";
 *   - an AI "no problem found" pass is NOT VERIFIED (the 4B model missed a
 *     blurred design);
 *   - text the second read didn't confirm (confidence capped at 0.89) never
 *     counts at ANY severity: misreads like "Istand Hopping" made false
 *     MAJOR findings in the acceptance run → "Needs a human check".
 */
export const LOCAL_POLICY = { measuredCritical: 0.95 } as const;
const LOCAL_AI_ABSENCE_PASSES = ["image.quality", "accessibility.color_only", "brand.fonts", "layout.hierarchy"];
export const GEMINI_SAW_NO_PROBLEM =
  "Not verified: Gemini saw no problem here, but that isn't confirmed — check it yourself. Not counted for or against the result.";
export const LOCAL_AI_SAW_NO_PROBLEM =
  "Not verified: the local AI saw no problem here, but that isn't confirmed — check it yourself. Not counted for or against the result.";

export type PolicyOptions = {
  /** The provider whose detections these are; "local" adds the local rules. */
  provider?: "mock" | "google" | "local" | "gemini" | null;
};

/**
 * The GEMINI provider (Gemini API, one call per design): there is no OCR
 * engine — Gemini reads the text AND judges the design, so everything it
 * reports is AI evidence. Text, text positions and text-based measurements
 * (overlap, edges, contrast, size) are treated as AI: an AI-only CRITICAL is
 * "Needs a human check — possible critical issue", other findings count only
 * when Gemini said it was clear, and an AI "no problem found" pass is not
 * verified. Only the file's own measurements (Platform / Size — not its safe
 * zone, which uses detected positions — and an exact size the brief asks for)
 * and measured audio stay "measured". Google, local and the mock are unchanged.
 */
const GEMINI_STILL_MEASURED = ["platform", "brief.requirement.dimensions", "image.audio"];

/** Why a borderline value measured inside Gemini's approximate text position isn't counted (Stage 4). */
export const GEMINI_ESTIMATE = "this was estimated from Gemini's approximate text position and isn't clearly past the limit.";

/** Why a Gemini "not found" isn't counted (Stage 4). */
export const GEMINI_DIDNT_LIST = "Gemini didn't list this text, but that isn't proof it's missing — it may still be on the design.";

/**
 * Passes that cover ALL text positions / sizes at once ("No overlaps", "Clear
 * of the edges", "All text is large enough"). The rules check only text that
 * has a box / size; when some text has none (a Gemini box that was invalid
 * and discarded, validate.ts), such a pass would cover only part of the
 * text, so it becomes not verified instead. Gemini only: the OCR providers
 * always measure a box for every line.
 */
const POSITION_PASSES = ["layout.text_overlap", "layout.edge_margin", "accessibility.text_size", "platform.safe_zone"];
export const SOME_POSITIONS_UNREAD =
  "Not verified: the position or size of some text couldn't be read, so this couldn't be checked for all of it — check it yourself. Not counted for or against the result.";

export const PARTLY_HEARD = "Not verified: only the first part of the video was analysed, so the sound couldn't be measured for all of it.";
const NOT_FOUND = "Not found";

export function evidenceOf(ruleId: string): "text" | "measured" | "ai" | "none" {
  const key = Object.keys(EVIDENCE)
    .filter((k) => ruleId === k || ruleId.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? EVIDENCE[key] : "ai";
}

/** Where a finding's detected words come from, and how sure the reading was. */
function textEvidence(finding: Finding, d: ContentDetections, isAbsence: boolean): { source: "ocr" | "speech" | "absent"; confidence: number } {
  const detected = finding.detected ?? "";
  if (detected === NOT_FOUND || finding.detected === undefined) return { source: "absent", confidence: d.textCoverage ?? 0 };
  // Dates written one way on both sides: the rules compare worded text with dates written one way and report
  // their near match in that form ("offer valid until 30 12 2026" for "Offer valid until 30 Dec 2026"), so the
  // line must be read the same way to be recognised as where those words came from — otherwise a WRONG value
  // would be taken for a missing one.
  const needle = normalizeWords(datesWrittenOneWay(detected));
  const matches = (text: string) => {
    const t = normalizeWords(datesWrittenOneWay(text));
    return needle.length > 0 && (t.includes(needle) || needle.includes(t));
  };
  const ocr = (d.texts ?? []).filter((t) => matches(t.text));
  if (ocr.length) return { source: "ocr", confidence: Math.min(...ocr.map((t) => t.confidence)) };
  const speech = (d.speech ?? []).filter((s) => matches(s.text));
  if (speech.length) return { source: "speech", confidence: Math.min(...speech.map((s) => s.confidence)) };
  // An absence rule whose detected value isn't words from the content ("Not found", or wording it reports itself).
  if (isAbsence) return { source: "absent", confidence: d.textCoverage ?? 0 };
  // Can't tell which words — use the weakest reading in the content (the safe side).
  const all = (d.texts ?? []).map((t) => t.confidence);
  return { source: "ocr", confidence: all.length ? Math.min(...all) : 0 };
}

/** The finding's detected words are local OCR lines the second read didn't confirm (capped at 0.89). */
function unconfirmedLocalReading(finding: Finding, d: ContentDetections): boolean {
  const needle = normalizeWords(finding.detected ?? "");
  if (!needle || finding.detected === NOT_FOUND) return false;
  const lines = (d.texts ?? []).filter((t) => {
    const n = normalizeWords(t.text);
    return n.length > 0 && (n.includes(needle) || needle.includes(n));
  });
  return lines.length > 0 && Math.min(...lines.map((t) => t.confidence)) <= LOCAL_UNCONFIRMED_CAP;
}

function humanCheck(finding: Finding, critical: boolean, why: string): Finding {
  const prefix = critical ? HUMAN_CHECK_CRITICAL : HUMAN_CHECK;
  return { ...finding, status: "unverified", suggestedFix: undefined, explanation: `${prefix}: ${why} ${finding.explanation}` };
}

export function applyConfidencePolicy(
  findings: Finding[],
  detections: ContentDetections | null,
  analysis: AnalysisState | undefined,
  options: PolicyOptions = {}
): Finding[] {
  const local = options.provider === "local" && detections !== null;
  const gemini = options.provider === "gemini" && detections !== null;
  return findings.map((f) => {
    if (f.status === "unverified" && f.explanation === NEEDS_ANALYSIS) {
      return { ...f, explanation: notAnalysedExplanation(analysis) };
    }
    if (f.status === "passed") {
      const checked = checkPass(f, detections, analysis, gemini);
      if (local && checked.status === "passed" && LOCAL_AI_ABSENCE_PASSES.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`))) {
        return { ...checked, status: "unverified", detected: undefined, suggestedFix: undefined, explanation: LOCAL_AI_SAW_NO_PROBLEM };
      }
      if (gemini && checked.status === "passed" && LOCAL_AI_ABSENCE_PASSES.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`))) {
        return { ...checked, status: "unverified", detected: undefined, suggestedFix: undefined, explanation: GEMINI_SAW_NO_PROBLEM };
      }
      return checked;
    }
    if (f.status !== "failed" || f.severity === "suggestion" || !detections) return f;

    const critical = f.severity === "critical";
    let evidence = evidenceOf(f.ruleId);
    let confidence = f.confidence;

    if (evidence === "none") return humanCheck(f, critical, "this isn't decided automatically.");
    if (local && (evidence === "text" || evidence === "ai") && unconfirmedLocalReading(f, detections)) {
      return humanCheck(f, critical, "the local text reader's two reads of this text didn't agree.");
    }
    if (gemini && evidence !== "ai" && !GEMINI_STILL_MEASURED.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`))) {
      // Read by Gemini, not measured: the text, its position and its colours come from the AI.
      if (evidence === "text") {
        const isAbsence = ABSENCE_RULES.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`));
        const found = textEvidence(f, detections, isAbsence);
        // "It isn't there" based only on Gemini not listing it: Gemini's lines carry no measure of what it
        // skipped (its "coverage" is just how sure it was of the lines it did return), so text it didn't list
        // may still be on the design. Never counted; a mandatory one stays a possible critical issue.
        if (isAbsence && found.source === "absent") return humanCheck(f, critical, GEMINI_DIDNT_LIST);
        confidence = Math.min(confidence, found.confidence);
      }
      // A value measured inside Gemini's approximate text box (contrast, text colour) counts only when it is
      // clearly past the limit (the rule says how clear: estimate.clearCut); nearer the limit, a person checks.
      if (f.estimate && !f.estimate.clearCut) return humanCheck(f, critical, GEMINI_ESTIMATE);
      evidence = "ai";
    }
    if (evidence === "text") {
      const isAbsence = ABSENCE_RULES.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`));
      const found = textEvidence(f, detections, isAbsence);
      if (found.source === "speech") {
        evidence = "ai"; // a transcript is the AI's hearing, not a measurement
        confidence = found.confidence;
      } else if (found.source === "absent") {
        if (local && critical) {
          return humanCheck(f, true, "the local text reader can't confirm that text is missing.");
        }
        if (isAbsence && (detections.textCoverage ?? 0) < POLICY.coverage) {
          return humanCheck(f, critical, "not all of the content's text could be read clearly, so it may be there.");
        }
        confidence = Math.min(confidence, detections.textCoverage ?? 0);
      } else {
        confidence = Math.min(confidence, found.confidence);
      }
    }

    if (evidence === "ai") {
      if (critical) return humanCheck(f, true, "this was judged by AI, which can't fail a design on its own.");
      if (confidence < POLICY.aiClear) return humanCheck(f, false, "the AI wasn't clear about this.");
      return f;
    }

    const needed = critical ? (local && evidenceOf(f.ruleId) === "text" ? LOCAL_POLICY.measuredCritical : POLICY.measuredCritical) : POLICY.measured;
    if (confidence < needed) return humanCheck(f, critical, "the reading wasn't clear enough to be sure.");
    return f;
  });
}

/** Anything not analysed is NOT VERIFIED — including the parts of a pass the analysis didn't reach. */
function checkPass(f: Finding, detections: ContentDetections | null, analysis: AnalysisState | undefined, gemini = false): Finding {
  const unverified = (explanation: string): Finding => ({ ...f, status: "unverified", detected: undefined, suggestedFix: undefined, explanation });
  if (f.ruleId.startsWith("image.audio")) {
    return analysis?.state === "done" && analysis.analysedShare !== undefined && analysis.analysedShare < 1 ? unverified(PARTLY_HEARD) : f;
  }
  // Analysis always reports its coverage; detections without one are hand-made (tests).
  if (!detections || detections.textCoverage === undefined) return f;
  if (
    gemini &&
    POSITION_PASSES.some((r) => f.ruleId === r || f.ruleId.startsWith(`${r}.`)) &&
    (detections.texts ?? []).some((t) => !t.box || t.fontSizePx === undefined)
  ) {
    return unverified(SOME_POSITIONS_UNREAD);
  }
  const matches = (r: string) => f.ruleId === r || f.ruleId.startsWith(`${r}.`);
  if (evidenceOf(f.ruleId) === "none" || (PASS_WITHOUT_FULL_COVERAGE.some(matches) && !NEEDS_FULL_COVERAGE.some(matches))) return f;
  return (detections.textCoverage ?? 0) < POLICY.coverage ? unverified(PARTLY_ANALYSED) : f;
}

export const isHumanCheck = (f: Finding) => f.status === "unverified" && f.explanation.startsWith(HUMAN_CHECK);

/** True when a rule id has its own entry in the register (tests keep the register complete). */
export function isRegistered(ruleId: string): boolean {
  return Object.keys(EVIDENCE).some((k) => ruleId === k || ruleId.startsWith(`${k}.`));
}
