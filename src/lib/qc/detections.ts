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

/** The lowest confidence among what a finding is based on (1 when based on nothing uncertain). */
export function lowest(...values: (number | undefined)[]): number {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? Math.min(...present) : 1;
}
