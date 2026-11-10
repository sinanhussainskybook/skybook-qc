import { joinHyphenatedLines } from "@/lib/qc/compare";

/**
 * What was detected IN the content — the second input of the QC engine
 * (plan Phase 5: "approved information + what was detected → findings").
 *
 * Phase 5 defined this shape; Phase 6 (lib/analysis/) fills it from real
 * content — OCR, measured pixels / audio, and AI judgements. When there is
 * no analysis result the app passes `null`, and every check that needs it
 * reports NOT VERIFIED (5.13) — nothing is guessed.
 *
 * Phase 6 additions (approved, additive): `page` on text and frames for
 * multi-page PDFs, and `textCoverage`.
 *
 * Every field is optional: a missing field means "not analysed" (→ not
 * verified); an empty list means "analysed, nothing found".
 */

/** A rectangle as fractions (0–1) of the frame's width and height, from the top-left. */
export type Box = { x: number; y: number; w: number; h: number };

export type DetectedText = {
  text: string;
  /** Which uploaded content file it was read from. */
  fileId?: string;
  /** PDF page (1-based) the text is on; absent for single-frame files. */
  page?: number;
  box?: Box;
  role?: "headline" | "body" | "cta" | "disclaimer" | "other";
  /** How sure the AI was of that role, 0–1 (absent: as sure as the text itself). */
  roleConfidence?: number;
  fontFamily?: string;
  /** Text height in pixels of the analysed frame. */
  fontSizePx?: number;
  bold?: boolean;
  /** Text and background colour behind it, `#rrggbb`. */
  color?: string;
  background?: string;
  /** Video: when the text is on screen. */
  startMs?: number;
  endMs?: number;
  /** 0–1. */
  confidence: number;
};

export type ContentDetections = {
  /** Where these came from — a mock is never mistaken for real analysis (6.2). */
  source: "fixture" | "mock" | "ai";
  /** Size of the analysed frame in pixels (for text size checks) — when every file is the same size. */
  frame?: { width: number; height: number };
  /** Per-file (and per-page) frame sizes, for content with several files or pages of different sizes. Wins over `frame`. */
  frames?: { fileId: string; page?: number; width: number; height: number }[];
  /**
   * How completely the text was read, 0–1: OCR page confidence × the share
   * of the content that was analysed. "Missing" findings need it to be high
   * — text the reader didn't see isn't proof the text isn't there.
   */
  textCoverage?: number;
  /** Text read from the image / video frames (OCR). */
  texts?: DetectedText[];
  /** Video: spoken words (transcript). */
  speech?: { text: string; startMs: number; endMs: number; confidence: number }[];
  /** Main colours, with the share of the frame each covers (0–1). */
  colors?: { hex: string; share: number }[];
  /** Font families seen. */
  fonts?: { family: string; confidence: number }[];
  /** The logo: shown or not, and whether it is this company's logo. */
  logo?: { present: boolean; matchesCompanyLogo?: boolean; box?: Box; confidence: number };
  /** Where the eye goes first — the main subject. */
  focalPoint?: { x: number; y: number; confidence: number };
  /** Quality problems found in images / footage. */
  imageIssues?: {
    fileId?: string;
    issue: "blurry" | "pixelated" | "stretched" | "watermark" | "cut_off";
    confidence: number;
    note?: string;
  }[];
  /** Information shown only by colour (e.g. "red = sold out" with no words). */
  colorOnlyMeaning?: { present: boolean; confidence: number; note?: string };
  /** Video: sound. Loudness in LUFS, peak in dBFS. */
  audio?: { hasAudio: boolean; integratedLufs?: number; peakDbfs?: number; confidence: number };
};

/** The frame a detection was made on: its file's own size, else the shared one. */
export function frameFor(
  d: ContentDetections,
  fileId: string | undefined,
  page?: number
): { width: number; height: number } | undefined {
  return (fileId && d.frames?.find((f) => f.fileId === fileId && (f.page ?? undefined) === page)) || d.frame;
}

/** Everything readable in the content: on-screen text, and for video what is said. */
export function allText(d: ContentDetections | null, withSpeech = true): string | null {
  if (!d?.texts) return null;
  const parts = d.texts.map((t) => t.text);
  if (withSpeech && d.speech) parts.push(...d.speech.map((s) => s.text));
  return parts.join("\n");
}

/** Arabic-script letters (Arabic, Persian, Urdu…) — a line mostly in them is read right to left. */
const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu;
const LATIN_OR_OTHER_LETTER = /[^\P{L}\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu;
const rightToLeft = (s: string) => (s.match(ARABIC_LETTER)?.length ?? 0) > (s.match(LATIN_OR_OTHER_LETTER)?.length ?? 0);

/**
 * The on-screen text of one frame (file + page) in reading order, from the text positions: rows top to
 * bottom (lines whose heights overlap by at least half the smaller one share a row); within a row, right to
 * left when the row is mostly Arabic script, otherwise left to right. Null when a line has no position —
 * then the listed order is the only one there is.
 */
function spatialOrder(texts: DetectedText[]): string[] | null {
  if (texts.some((t) => !t.box)) return null;
  const sorted = [...texts].sort((a, b) => a.box!.y + a.box!.h / 2 - (b.box!.y + b.box!.h / 2));
  const rows: DetectedText[][] = [];
  for (const t of sorted) {
    const row = rows[rows.length - 1];
    const sameRow =
      row &&
      row.some((r) => {
        const overlap = Math.min(r.box!.y + r.box!.h, t.box!.y + t.box!.h) - Math.max(r.box!.y, t.box!.y);
        return overlap >= 0.5 * Math.min(r.box!.h, t.box!.h);
      });
    if (sameRow) row.push(t);
    else rows.push([t]);
  }
  return rows.flatMap((row) => {
    const rtl = rightToLeft(row.map((t) => t.text).join(" "));
    return [...row].sort((a, b) => (rtl ? b.box!.x + b.box!.w - (a.box!.x + a.box!.w) : a.box!.x - b.box!.x)).map((t) => t.text);
  });
}

/**
 * The content's text read every reasonable way, for checking that REQUIRED WORDING is present (Stage 3, A4):
 *   1. as listed (allText) — always first;
 *   2. the same with words broken across lines by a hyphen put back together (joinHyphenatedLines);
 *   3. in reading order from the text positions (spatialOrder) — rows top to bottom, Arabic rows right to
 *      left — so wording split over several text blocks matches however they were listed; and 4. that with
 *      hyphenated breaks joined.
 * Wording counts as present only when it appears complete, word for word, in one of them; anything about
 * missing or different words is still judged on the text as listed. Video (texts with times) and frames
 * where a line has no position keep the listed order. Empty when there's no text.
 */
export function textReadings(d: ContentDetections | null, withSpeech = true): string[] {
  const listed = allText(d, withSpeech);
  if (listed === null || !d?.texts) return [];
  const readings = [listed, joinHyphenatedLines(listed)];
  if (!d.texts.some((t) => t.startMs !== undefined)) {
    const frames = new Map<string, DetectedText[]>();
    for (const t of d.texts) {
      const key = `${t.fileId ?? ""}#${t.page ?? ""}`;
      frames.set(key, [...(frames.get(key) ?? []), t]);
    }
    const ordered = [...frames.values()].map((texts) => spatialOrder(texts) ?? texts.map((t) => t.text)).flat();
    if (withSpeech && d.speech) ordered.push(...d.speech.map((s) => s.text));
    const spatial = ordered.join("\n");
    readings.push(spatial, joinHyphenatedLines(spatial));
  }
  return [...new Set(readings)];
}

/**
 * How sure a finding based on texts' ROLES can be ("this is the CTA"): the least sure of those texts and
 * of their roles. A wrong CTA or headline is only as certain as the AI's reading of which text it is.
 */
export function roleBasedConfidence(texts: DetectedText[]): number {
  return Math.min(...texts.map((t) => Math.min(t.confidence, t.roleConfidence ?? t.confidence)));
}

/** The lowest confidence among what a finding is based on (1 when based on nothing uncertain). */
export function lowest(...values: (number | undefined)[]): number {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? Math.min(...present) : 1;
}
