import { contrastRatio } from "@/lib/qc/compare";
import { frameFor, type DetectedText } from "@/lib/qc/detections";
import type { Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, VIDEO_TYPES, type QcContext } from "@/lib/qc/rules/context";

/**
 * Accessibility QC (plan 5.8): contrast, text size and colour-only meaning;
 * for video, captions for speech (5.14).
 *
 * Contrast uses the WCAG 2.x ratios: 4.5 : 1 for normal text, 3 : 1 for
 * large text. In a design "large" is relative to the frame: text at least
 * 3 % of the frame's shorter side (2.4 % if bold). Text under 1.5 % of the
 * shorter side is flagged as too small. These are app settings.
 */

const CATEGORY = "accessibility" as const;

export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;
export const LARGE_TEXT_SHARE = 0.03;
export const LARGE_BOLD_TEXT_SHARE = 0.024;
export const MIN_TEXT_SHARE = 0.015;
/**
 * A contrast ratio estimated from approximate text positions (Gemini) counts only when it is clearly too
 * low: under this share of the ratio needed (approved: 60 %). Nearer the limit it goes to a person.
 */
export const CONTRAST_CLEAR_CUT = 0.6;
/** Captions should cover at least this share of the speech. */
export const CAPTION_COVERAGE = 0.5;

const quote = (t: DetectedText) => `"${t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}"`;

const contrastRule: Rule<QcContext> = {
  id: "accessibility.contrast",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text colour and the colour behind it", "frame size"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const d = context.detections;
    const coloured = (d?.texts ?? []).filter((t) => t.color && t.background);
    if (!d?.texts || coloured.length === 0) return [notVerified(this.id, CATEGORY, "Text contrast", "major", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Text contrast");
    return coloured.map((t) => {
      const ratio = contrastRatio(t.color!, t.background!);
      const frame = frameFor(d, t.fileId, t.page);
      const shorter = frame ? Math.min(frame.width, frame.height) : null;
      const share = shorter && t.fontSizePx ? t.fontSizePx / shorter : null;
      const large = share !== null && share >= (t.bold ? LARGE_BOLD_TEXT_SHARE : LARGE_TEXT_SHARE);
      const needed = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
      if (ratio === null) {
        return notVerified(this.id, CATEGORY, "Text contrast", "major", `The colours of ${quote(t)} couldn't be read.`);
      }
      const ok = ratio >= needed;
      const finding = make({
        severity: "major",
        status: ok ? "passed" : "failed",
        expected: `At least ${needed} : 1${large ? " (large text)" : ""}`,
        detected: `${ratio.toFixed(2)} : 1 — ${quote(t)} (${t.color} on ${t.background})`,
        explanation: ok ? "Enough contrast to read comfortably." : "The text doesn't stand out enough from its background to be read easily.",
        suggestedFix: "Darken the text or lighten the background (or the other way round).",
        confidence: t.confidence,
        fileId: t.fileId,
      });
      // Measured from the colours inside the text's box: say how clear the failure is (policy.ts decides).
      return ok ? finding : { ...finding, estimate: { value: Math.round(ratio * 100) / 100, limit: needed, clearCut: ratio < needed * CONTRAST_CLEAR_CUT } };
    });
  },
};

const textSizeRule: Rule<QcContext> = {
  id: "accessibility.text_size",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text sizes", "frame size"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const d = context.detections;
    const sized = (d?.texts ?? []).filter((t) => t.fontSizePx && frameFor(d!, t.fileId, t.page));
    if (!d?.texts || sized.length === 0) return [notVerified(this.id, CATEGORY, "Text size", "minor", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Text size");
    const minimumFor = (t: DetectedText) => {
      const frame = frameFor(d, t.fileId, t.page)!;
      const shorter = Math.min(frame.width, frame.height);
      return { shorter, minimum: Math.ceil(shorter * MIN_TEXT_SHARE) };
    };
    const small = sized.filter((t) => t.fontSizePx! < minimumFor(t).minimum);
    if (small.length === 0) {
      return [make({ severity: "minor", status: "passed", expected: `At least ${MIN_TEXT_SHARE * 100}% of the frame's shorter side`, detected: `Smallest ${Math.min(...sized.map((t) => t.fontSizePx!))}px`, explanation: "All text is large enough to read." })];
    }
    return small.map((t) => {
      const { shorter, minimum } = minimumFor(t);
      return make({
        severity: "minor",
        status: "failed",
        expected: `At least ${minimum}px (${MIN_TEXT_SHARE * 100}% of ${shorter}px)`,
        detected: `${t.fontSizePx}px — ${quote(t)}`,
        explanation: "This text is too small to read comfortably, especially on a phone.",
        suggestedFix: `Make it at least ${minimum}px tall.`,
        confidence: t.confidence,
        fileId: t.fileId,
      });
    });
  },
};

const colorOnlyRule: Rule<QcContext> = {
  id: "accessibility.color_only",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["visual analysis of meaning shown by colour"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const finding = context.detections?.colorOnlyMeaning;
    if (!finding) return [notVerified(this.id, CATEGORY, "Meaning shown only by colour", "minor", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Meaning shown only by colour");
    return [
      make({
        severity: "minor",
        status: finding.present ? "failed" : "passed",
        expected: "Meaning also shown in words or symbols",
        detected: finding.present ? (finding.note ?? "Information shown only by colour") : "None",
        explanation: finding.present
          ? "Some information is shown only by colour, which colour-blind viewers may miss."
          : "Nothing relies on colour alone.",
        suggestedFix: "Add a word, label or icon alongside the colour.",
        confidence: finding.confidence,
        kind: "judgement", // whether colour carries meaning is an interpretation
      }),
    ];
  },
};

const captionsRule: Rule<QcContext> = {
  id: "accessibility.captions",
  category: CATEGORY,
  appliesTo: VIDEO_TYPES,
  needs: ["transcript", "on-screen text with timings"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const d = context.detections;
    if (!d?.speech || !d.texts) return [notVerified(this.id, CATEGORY, "Captions", "minor", NEEDS_ANALYSIS)];
    if (d.speech.length === 0) return [notApplicable(this.id, CATEGORY, "Captions", "Nothing is spoken in the video.")];
    const make = findingFor(this.id, CATEGORY, "Captions");
    const spoken = d.speech.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    const covered = d.speech.reduce((sum, s) => {
      const overlapMs = d.texts!
        .filter((t) => t.startMs !== undefined && t.endMs !== undefined)
        .reduce((best, t) => Math.max(best, Math.min(s.endMs, t.endMs!) - Math.max(s.startMs, t.startMs!)), 0);
      return sum + Math.max(0, overlapMs);
    }, 0);
    const share = spoken > 0 ? covered / spoken : 1;
    return [
      make({
        severity: "minor",
        status: share >= CAPTION_COVERAGE ? "passed" : "failed",
        expected: `On-screen text during at least ${CAPTION_COVERAGE * 100}% of the speech`,
        detected: `${Math.round(share * 100)}% of the speech has text on screen`,
        explanation:
          share >= CAPTION_COVERAGE ? "Speech is accompanied by on-screen text." : "Most of what is said has no captions — many people watch with the sound off.",
        suggestedFix: "Add captions for the spoken words.",
        confidence: Math.min(...d.speech.map((s) => s.confidence)),
      }),
    ];
  },
};

export const ACCESSIBILITY_RULES: readonly Rule<QcContext>[] = [contrastRule, textSizeRule, colorOnlyRule, captionsRule];
