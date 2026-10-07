import type { Box, DetectedText } from "@/lib/qc/detections";
import type { Finding, Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, VIDEO_TYPES, type QcContext } from "@/lib/qc/rules/context";

/**
 * Design & Layout QC (plan 5.7), from the positions of what was detected:
 * overlapping text and text too close to the edge (measured: facts), then
 * the subjective ones — headline hierarchy and the Rule of Thirds — which are
 * ALWAYS a SUGGESTION worded as a judgement, never a failure that blocks PASS. Video adds
 * on-screen text shown too briefly to read (5.14).
 */

const CATEGORY = "design_layout" as const;

/** App settings (not platform values). */
export const EDGE_MARGIN = 0.02; // text within 2 % of an edge
export const OVERLAP_SHARE = 0.1; // boxes overlapping by >10 % of the smaller one
export const THIRDS_DISTANCE = 0.1; // focal point within 10 % of a thirds crossing
export const READ_MS_PER_WORD = 300; // ~3 words a second…
export const MIN_ON_SCREEN_MS = 1500; // …and never under 1.5 s

const area = (b: Box) => b.w * b.h;
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const sameTime = (a: DetectedText, b: DetectedText) =>
  a.startMs === undefined || b.startMs === undefined || (a.startMs < (b.endMs ?? Infinity) && b.startMs < (a.endMs ?? Infinity));
const quote = (t: DetectedText) => `"${t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text}"`;

function positioned(context: QcContext): (DetectedText & { box: Box })[] | null {
  const texts = context.detections?.texts;
  if (!texts) return null;
  return texts.filter((t): t is DetectedText & { box: Box } => Boolean(t.box));
}

const overlapRule: Rule<QcContext> = {
  id: "layout.text_overlap",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text positions"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const texts = positioned(context);
    if (!texts) return [notVerified(this.id, CATEGORY, "Overlapping text", "major", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Overlapping text");
    const findings: Finding[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const [a, b] = [texts[i], texts[j]];
        if (a.fileId !== b.fileId || a.page !== b.page || !sameTime(a, b)) continue;
        if (overlap(a.box, b.box) > OVERLAP_SHARE * Math.min(area(a.box), area(b.box))) {
          findings.push(
            make({
              severity: "major",
              status: "failed",
              expected: "Text blocks don't overlap",
              detected: `${quote(a)} overlaps ${quote(b)}`,
              explanation: "Two pieces of text sit on top of each other, so neither reads cleanly.",
              suggestedFix: "Move or resize one of them so they don't overlap.",
              confidence: Math.min(a.confidence, b.confidence),
              fileId: a.fileId,
            })
          );
        }
      }
    }
    return findings.length ? findings : [make({ severity: "major", status: "passed", detected: "No overlaps", explanation: "No text overlaps other text." })];
  },
};

const edgeRule: Rule<QcContext> = {
  id: "layout.edge_margin",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text positions"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const texts = positioned(context);
    if (!texts) return [notVerified(this.id, CATEGORY, "Text near the edge", "minor", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Text near the edge");
    const close = texts.filter((t) => t.box.x < EDGE_MARGIN || t.box.y < EDGE_MARGIN || t.box.x + t.box.w > 1 - EDGE_MARGIN || t.box.y + t.box.h > 1 - EDGE_MARGIN);
    if (close.length === 0) return [make({ severity: "minor", status: "passed", detected: "Clear of the edges", explanation: "All text keeps a margin from the edges." })];
    return close.map((t) =>
      make({
        severity: "minor",
        status: "failed",
        expected: `At least ${EDGE_MARGIN * 100}% from every edge`,
        detected: `${quote(t)} touches the edge`,
        explanation: "Text this close to the edge can be cut off when the content is cropped or printed.",
        suggestedFix: "Move the text further in from the edge.",
        confidence: t.confidence,
        fileId: t.fileId,
      })
    );
  },
};

const hierarchyRule: Rule<QcContext> = {
  id: "layout.hierarchy",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text sizes and roles"],
  defaultSeverity: "suggestion",
  mandatory: false,
  run(context) {
    const texts = context.detections?.texts;
    if (!texts) return [notVerified(this.id, CATEGORY, "Headline stands out", "suggestion", NEEDS_ANALYSIS)];
    const headlines = texts.filter((t) => t.role === "headline" && t.fontSizePx);
    const others = texts.filter((t) => t.role !== "headline" && t.fontSizePx);
    if (headlines.length === 0 || others.length === 0) return [notApplicable(this.id, CATEGORY, "Headline stands out", "No headline with other text to compare it with.")];
    const make = findingFor(this.id, CATEGORY, "Headline stands out");
    const headline = Math.max(...headlines.map((t) => t.fontSizePx!));
    const larger = others.filter((t) => t.fontSizePx! >= headline);
    return [
      larger.length === 0
        ? make({ severity: "suggestion", kind: "judgement", status: "passed", detected: `Headline ${headline}px, the largest text`, explanation: "The headline is the largest text." })
        : make({
            severity: "suggestion", kind: "judgement",
            status: "failed",
            expected: "The headline is the largest text",
            detected: `${quote(larger[0])} is ${larger[0].fontSizePx}px; the headline is ${headline}px`,
            explanation: "A suggestion: other text is as large as or larger than the headline, so the main message may not stand out. This can be intentional.",
            suggestedFix: "Make the headline larger, or the other text smaller.",
            confidence: Math.min(...larger.map((t) => t.confidence), ...headlines.map((t) => t.confidence)),
          }),
    ];
  },
};

const thirdsRule: Rule<QcContext> = {
  id: "layout.rule_of_thirds",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["the main subject's position"],
  defaultSeverity: "suggestion",
  mandatory: false,
  run(context) {
    const point = context.detections?.focalPoint;
    // Always a SUGGESTION — never a failure that blocks a PASS (plan 5.7).
    if (!point) return [notVerified(this.id, CATEGORY, "Rule of Thirds", "suggestion", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Rule of Thirds");
    const lines = [1 / 3, 2 / 3];
    const distance = Math.min(...lines.flatMap((x) => lines.map((y) => Math.hypot(point.x - x, point.y - y))));
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return [
      make({
        severity: "suggestion",
        kind: "judgement",
        status: distance <= THIRDS_DISTANCE ? "passed" : "failed",
        expected: "Main subject near a thirds crossing",
        detected: `Main subject at ${pct(point.x)} across, ${pct(point.y)} down`,
        explanation:
          distance <= THIRDS_DISTANCE
            ? "The main subject sits on a thirds crossing."
            : "A suggestion only: placing the main subject on a thirds crossing often makes the layout feel more balanced. Centred layouts can be intentional.",
        suggestedFix: "Consider moving the main subject towards one of the thirds crossings.",
        confidence: point.confidence,
      }),
    ];
  },
};

const onScreenTimeRule: Rule<QcContext> = {
  id: "layout.on_screen_time",
  category: CATEGORY,
  appliesTo: VIDEO_TYPES,
  needs: ["on-screen text with timings"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const texts = context.detections?.texts;
    if (!texts) return [notVerified(this.id, CATEGORY, "Time to read on-screen text", "minor", NEEDS_ANALYSIS)];
    const timed = texts.filter((t) => t.startMs !== undefined && t.endMs !== undefined);
    if (timed.length === 0) return [notApplicable(this.id, CATEGORY, "Time to read on-screen text", "No timed on-screen text.")];
    const make = findingFor(this.id, CATEGORY, "Time to read on-screen text");
    const needed = (t: DetectedText) => Math.max(MIN_ON_SCREEN_MS, t.text.trim().split(/\s+/).length * READ_MS_PER_WORD);
    const short = timed.filter((t) => t.endMs! - t.startMs! < needed(t));
    if (short.length === 0) return [make({ severity: "minor", status: "passed", detected: "Long enough", explanation: "All on-screen text stays up long enough to read." })];
    return short.map((t) =>
      make({
        severity: "minor",
        status: "failed",
        expected: `At least ${(needed(t) / 1000).toFixed(1)} s`,
        detected: `${quote(t)} for ${((t.endMs! - t.startMs!) / 1000).toFixed(1)} s`,
        explanation: "This text disappears before most people can read it.",
        suggestedFix: "Keep it on screen longer, or shorten the text.",
        confidence: t.confidence,
      })
    );
  },
};

export const LAYOUT_RULES: readonly Rule<QcContext>[] = [overlapRule, edgeRule, hierarchyRule, thirdsRule, onScreenTimeRule];
