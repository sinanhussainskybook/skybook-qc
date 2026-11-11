import { normalizeWords } from "@/lib/qc/compare";
import type { Box, DetectedText } from "@/lib/qc/detections";
import type { Finding, Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, VIDEO_TYPES, type QcContext } from "@/lib/qc/rules/context";

/**
 * Design & Layout QC (plan 5.7), from the positions of what was detected:
 * overlapping text and text too close to the edge (measured: facts), then
 * the subjective ones — headline hierarchy and the Rule of Thirds (the main
 * subject in a 3×3 grid; a centred composition is never flagged) — which are
 * ALWAYS a SUGGESTION worded as a judgement, never a failure that blocks PASS. Video adds
 * on-screen text shown too briefly to read (5.14).
 */

const CATEGORY = "design_layout" as const;

/** App settings (not platform values). */
export const EDGE_MARGIN = 0.02; // text within 2 % of an edge
export const CANVAS_EDGE = 0.01; // text reaching within 1 % of the left / right edge can be running off the canvas
export const OVERLAP_SHARE = 0.1; // boxes overlapping by >10 % of the smaller one
export const THIRDS_DISTANCE = 0.1; // focal point within 10 % of a thirds crossing
export const CENTRE_TOLERANCE = 0.08; // focal point within 8 % of the vertical centre line: a centred composition
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

/** Requirement types whose value is wording shown ON the design (not audience, instructions, platform or size). */
const ON_DESIGN_TYPES = new Set([
  "headline",
  "required_text",
  "cta",
  "offer",
  "product_name",
  "service_name",
  "location",
  "campaign_name",
  "disclaimer",
  "price",
  "percentage",
  "date",
  "time",
  "phone",
  "whatsapp",
  "email",
  "website",
]);
/** Golden Rule categories whose approved value is wording shown on the design. */
const WORDING_RULES = new Set(["mandatory_disclaimer", "approved_product_name", "approved_cta"]);

/** The approved wording meant to appear on the design (brief, Golden Rules, company name, approved terms), as normalised words. */
function approvedWords(context: QcContext): string[][] {
  const wordings = [
    ...context.requirements.filter((r) => ON_DESIGN_TYPES.has(r.type)).map((r) => r.expectedValue),
    ...context.company.goldenRules.filter((g) => g.active && g.approved_value && WORDING_RULES.has(g.category)).map((g) => g.approved_value!),
    context.company.company.name,
    // The company's saved contact details, as they can appear on any design.
    ...[context.company.contact.phone, context.company.contact.additional_phone, context.company.contact.whatsapp, context.company.contact.email, context.company.contact.website].filter(
      (v): v is string => Boolean(v?.trim())
    ),
    ...context.company.brand.terms.filter((t) => t.kind === "approved").map((t) => t.term),
  ];
  return wordings.map((w) => normalizeWords(w).split(" ").filter(Boolean)).filter((w) => w.length > 0);
}

/**
 * Word beginnings and endings that turn one complete word into another ("offer" / "offers", "lock" / "unlock",
 * "عروض" / "العروض"): when the letters missing from an edge word are exactly one of these, the word on the
 * design is more likely a complete word in another form than a cut one. One of several checks, never the only one.
 */
const WORD_BEGINNINGS = new Set(["un", "re", "dis", "pre", "in", "im", "il", "ir", "non", "de", "co", "en", "em", "ex", "mis", "sub", "super", "over", "under", "out", "up", "anti", "inter", "multi", "self", "auto", "ال", "و", "ف", "ب", "ل", "ك", "وال", "بال", "فال", "كال", "لل"]);
const WORD_ENDINGS = new Set(["s", "es", "d", "ed", "ing", "er", "ers", "est", "ly", "y", "ies", "ied", "ment", "ments", "ness", "ion", "ions", "tion", "tions", "al", "ful", "less", "able", "ible", "ive", "ity", "ize", "ise", "ized", "ised", "ة", "ه", "ها", "هم", "ك", "كم", "نا", "ي", "ات", "ون", "ين", "ان", "وا"]);

/**
 * Each positioned text's previous and next text in reading order, per design file and page: rows top to bottom
 * (texts whose heights overlap by at least half the smaller one share a row), and within a row right to left when
 * the row starts with Arabic script, otherwise left to right. Video texts (with times) have no reading order here.
 */
function readingNeighbours(texts: readonly (DetectedText & { box: Box })[]): Map<DetectedText, { previous?: DetectedText; next?: DetectedText }> {
  const pages = new Map<string, (DetectedText & { box: Box })[]>();
  for (const t of texts) {
    if (t.startMs !== undefined) continue;
    const key = `${t.fileId ?? ""}#${t.page ?? ""}`;
    pages.set(key, [...(pages.get(key) ?? []), t]);
  }
  const out = new Map<DetectedText, { previous?: DetectedText; next?: DetectedText }>();
  for (const page of pages.values()) {
    const rows: (DetectedText & { box: Box })[][] = [];
    for (const t of [...page].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2))) {
      const row = rows[rows.length - 1];
      const sameRow = row?.some((r) => Math.min(r.box.y + r.box.h, t.box.y + t.box.h) - Math.max(r.box.y, t.box.y) >= 0.5 * Math.min(r.box.h, t.box.h));
      if (row && sameRow) row.push(t);
      else rows.push([t]);
    }
    const order = rows.flatMap((row) => {
      const rtl = rightToLeft(row.map((t) => t.text).join(" "));
      return [...row].sort((a, b) => (rtl ? b.box.x + b.box.w - (a.box.x + a.box.w) : a.box.x - b.box.x));
    });
    order.forEach((t, i) => out.set(t, { previous: order[i - 1], next: order[i + 1] }));
  }
  return out;
}

/** Right to left when the first letter of the line is Arabic script (as a line of mixed text is laid out). */
const rightToLeft = (text: string) => {
  const first = text.match(/\p{L}/u)?.[0];
  return first !== undefined && /\p{Script=Arabic}/u.test(first);
};

/**
 * Text CUT OFF by the canvas, not just close to it. Position alone never says so (AI boxes are approximate and
 * kept inside the canvas), so ALL of these must hold:
 *  - the line reaches the left or right edge (within CANVAS_EDGE);
 *  - the word on that edge is a strict fragment of a word in the approved on-design wording: at the edge where
 *    the line starts (left for left-to-right text, right for Arabic - decided by the line's first letter) the
 *    END of the word is left ("ET" of "SET", "INESS" of "BUSINESS"); at the other edge, its START ("LICEN" of
 *    "LICENSED"). Never itself an approved word;
 *  - the missing letters aren't just a beginning or ending that makes another complete word ("Offer" for
 *    "Offers", "cover" for "Discover", the Arabic article);
 *  - context confirms it: a line of several words must continue that same approved wording ("ET UP YOUR" for
 *    "Set Up Your Business"; then 2+ letters of a word of 3+); a line that is ONLY the fragment (4+ letters of a
 *    word of 5+) needs the ADJACENT line in reading order to continue that wording - the line before ends with
 *    the word before ("ET UP YOUR" before "INESS") or the line after starts with the word after ("GET") - so a
 *    one-word approved wording can never be confirmed this way, and a common word elsewhere never confirms it;
 *  - numbers: missing leading zeros are formatting, never a cut ("971" for "00971");
 *  - a word split across lines on purpose is never a cut: the missing letters end the line before ("Book-" /
 *    "ing your trip", "BUSI" / "NESS") or start the line after.
 * Returns the edge and the incomplete word, or null.
 */
function cutOffAtEdge(
  t: DetectedText & { box: Box },
  approved: readonly string[][],
  adjacent: { previous: readonly string[]; next: readonly string[] }
): { side: "left" | "right"; word: string } | null {
  const words = normalizeWords(t.text).split(" ").filter(Boolean);
  if (words.length === 0 || approved.length === 0) return null;
  const rtl = rightToLeft(t.text);
  const whole = new Set(approved.flat());
  const alone = words.length === 1;
  const isFragment = (part: string, word: string, kept: "end" | "start") => {
    if (part.length < (alone ? 4 : 2) || word.length < (alone ? 5 : 3) || part.length >= word.length || whole.has(part)) return false;
    if (kept === "end" ? !word.endsWith(part) : !word.startsWith(part)) return false;
    const missing = kept === "end" ? word.slice(0, word.length - part.length) : word.slice(part.length);
    if (/^0+$/.test(missing)) return false; // "971" for "00971": formatting, not a cut
    // Split across lines on purpose ("Book-" / "ing …", "BUSI" / "NESS"): the missing letters are on the adjacent line.
    // A deliberate split leaves 2+ characters there - a lone "a", "I" or digit ending a line is just a word, never a split.
    if (missing.length >= 2 && (kept === "end" ? adjacent.previous[adjacent.previous.length - 1] === missing : adjacent.next[0] === missing)) return false;
    return !(kept === "end" ? WORD_BEGINNINGS : WORD_ENDINGS).has(missing);
  };
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);
  // A one-word fragment: the adjacent line in reading order continues the wording around it.
  const neighbourShown = (wording: readonly string[], i: number) =>
    (i > 0 && adjacent.previous[adjacent.previous.length - 1] === wording[i - 1]) || (i + 1 < wording.length && adjacent.next[0] === wording[i + 1]);
  for (const side of ["left", "right"] as const) {
    const atEdge = side === "left" ? t.box.x <= CANVAS_EDGE : t.box.x + t.box.w >= 1 - CANVAS_EDGE;
    if (!atEdge) continue;
    const lineStart = rtl ? side === "right" : side === "left";
    for (const wording of approved) {
      for (let i = 0; i < wording.length; i++) {
        if (lineStart) {
          // [end of wording[i], wording[i + 1], ...]
          if (!isFragment(words[0], wording[i], "end")) continue;
          const rest = words.slice(1);
          const next = wording.slice(i + 1);
          const n = Math.min(rest.length, next.length);
          if (alone ? neighbourShown(wording, i) : n > 0 && same(rest.slice(0, n), next.slice(0, n))) return { side, word: wording[i] };
        } else {
          // [..., wording[i - 1], start of wording[i]]
          if (!isFragment(words[words.length - 1], wording[i], "start")) continue;
          const before = words.slice(0, -1);
          const previous = wording.slice(0, i);
          const n = Math.min(before.length, previous.length);
          if (alone ? neighbourShown(wording, i) : n > 0 && same(before.slice(before.length - n), previous.slice(previous.length - n))) return { side, word: wording[i] };
        }
      }
    }
  }
  return null;
}

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
    const approved = approvedWords(context);
    // The lines before and after each text in reading order, for confirming a one-word fragment (cutOffAtEdge).
    const wordsOf = (t: DetectedText | undefined) => (t ? normalizeWords(t.text).split(" ").filter(Boolean) : []);
    const neighbours = readingNeighbours(texts);
    return close.map((t) => {
      // Actually cut off by the canvas (an incomplete approved word at the edge): MAJOR, its own title.
      const around = neighbours.get(t);
      const cut = cutOffAtEdge(t, approved, { previous: wordsOf(around?.previous), next: wordsOf(around?.next) });
      if (cut) {
        return findingFor(this.id, CATEGORY, "Text cut off at the edge")({
          severity: "major",
          status: "failed",
          expected: "All text fully inside the design",
          detected: `${quote(t)} runs off the ${cut.side} edge ("${cut.word}" is incomplete)`,
          explanation: "Part of this text is outside the design: the word at the edge is cut off.",
          suggestedFix: "Move the text back inside the design, with a margin from the edge.",
          confidence: t.confidence,
          fileId: t.fileId,
        });
      }
      return make({
        severity: "minor",
        status: "failed",
        expected: `At least ${EDGE_MARGIN * 100}% from every edge`,
        detected: `${quote(t)} touches the edge`,
        explanation: "Text this close to the edge can be cut off when the content is cropped or printed.",
        suggestedFix: "Move the text further in from the edge.",
        confidence: t.confidence,
        fileId: t.fileId,
      });
    });
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

/** Where a point falls in a conceptual 3×3 grid: "top-left" … "middle-centre" … "bottom-right". */
export function gridCell(point: { x: number; y: number }): string {
  const third = (v: number) => (v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2);
  return `${["top", "middle", "bottom"][third(point.y)]}-${["left", "centre", "right"][third(point.x)]}`;
}

/**
 * Rule of Thirds (composition): where the main subject — the focal point the
 * existing analysis already returns — sits in a 3×3 grid. Always a soft
 * SUGGESTION worded as a judgement; never a failure that blocks a PASS.
 *   on or near a thirds crossing      → passed
 *   on the vertical centre line       → passed: a centred, symmetrical
 *                                       composition is a deliberate choice,
 *                                       not an error
 *   anywhere else (off-centre, away   → a suggestion with an optional
 *   from every crossing)                improvement
 */
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
    const centred = Math.abs(point.x - 0.5) <= CENTRE_TOLERANCE;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const where = `Main subject in the ${gridCell(point)} of the 3×3 grid (${pct(point.x)} across, ${pct(point.y)} down)`;
    const base = { severity: "suggestion" as const, kind: "judgement" as const, expected: "Main subject on a thirds crossing, or deliberately centred", detected: where, confidence: point.confidence };
    if (distance <= THIRDS_DISTANCE) return [make({ ...base, status: "passed", explanation: "The main subject sits on a thirds crossing." })];
    if (centred) {
      return [make({ ...base, status: "passed", explanation: "The main subject is centred — a balanced, deliberate composition, so the Rule of Thirds isn't needed." })];
    }
    return [
      make({
        ...base,
        status: "failed",
        explanation: "A suggestion only: the main subject is off-centre but not on a thirds crossing, so the layout can feel unplanned. It doesn't affect the result.",
        suggestedFix: "Optional: move the main subject onto a thirds crossing, or centre it deliberately.",
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
