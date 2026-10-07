import { z } from "zod";
import type { Box } from "@/lib/qc/detections";
import { REQUIREMENT_TYPES } from "@/lib/qc/requirements";

/**
 * Strict checks on everything a provider returns (plan 6.8). Nothing enters
 * ContentDetections unless it passes here — whatever the provider promises
 * about schema adherence.
 *
 * Every response is: size-checked BEFORE parsing → parsed as JSON → depth-
 * checked → matched against a fixed shape with bounded counts, lengths and
 * ranges. AI responses are strict objects: an unknown field is a rejection,
 * not something to ignore. Failures carry a short, safe reason.
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

export const RESPONSE_LIMITS = {
  /** OCR responses are large (word/symbol geometry) but bounded. */
  ocrBytes: 8_000_000,
  ocrDepth: 24,
  ocrMaxParagraphs: 1_000,
  ocrMaxWords: 20_000,
  /** AI responses are small structured JSON. */
  aiBytes: 200_000,
  aiDepth: 8,
  maxBlocks: 300,
  maxIssues: 20,
  maxFonts: 10,
  maxSegments: 2_000,
  maxCandidates: 50,
  textChars: 2_000,
  noteChars: 300,
} as const;

function depthOf(value: unknown, limit: number): number {
  // Iterative, so a hostile deeply nested payload can't blow the stack.
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > max) max = d;
    if (max > limit) return max;
    if (v && typeof v === "object") for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return max;
}

/** Size → JSON → depth. The common front half of every validator. */
export function parseJsonSafely(text: unknown, maxBytes: number, maxDepth: number): Validated<unknown> {
  if (typeof text !== "string") return { ok: false, reason: "response was not text" };
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, reason: "response too large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "response was not valid JSON" };
  }
  if (depthOf(value, maxDepth) > maxDepth) return { ok: false, reason: "response nested too deeply" };
  return { ok: true, value };
}

function fromSchema<T>(schema: z.ZodType<T>, value: unknown): Validated<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  return { ok: false, reason: `unexpected response shape at ${issue.path.join(".") || "(root)"}: ${issue.code}` };
}

// ---------------------------------------------------------------------------
// OCR (Cloud Vision DOCUMENT_TEXT_DETECTION shape; the mock returns the same)
// ---------------------------------------------------------------------------

const coord = z.number().finite().min(-10).max(100_000);
const vertex = z.object({ x: coord.optional(), y: coord.optional() });
const poly = z.object({ vertices: z.array(vertex).max(8).optional() }).optional();
const confidence = z.number().finite().min(0).max(1);
const breakType = z.object({ type: z.string().max(40).optional() }).optional();

const visionSymbol = z.object({
  text: z.string().max(16),
  property: z.object({ detectedBreak: breakType }).optional(),
});
const visionWord = z.object({
  boundingBox: poly,
  symbols: z.array(visionSymbol).max(200),
  confidence: confidence.optional(),
});
const visionParagraph = z.object({ boundingBox: poly, words: z.array(visionWord).max(2_000), confidence: confidence.optional() });
const visionBlock = z.object({ paragraphs: z.array(visionParagraph).max(500).optional(), confidence: confidence.optional() });
const visionPage = z.object({
  width: z.number().int().min(1).max(100_000).optional(),
  height: z.number().int().min(1).max(100_000).optional(),
  blocks: z.array(visionBlock).max(1_000).optional(),
  confidence: confidence.optional(),
});
const visionResponse = z.object({
  responses: z
    .array(
      z.object({
        fullTextAnnotation: z.object({ pages: z.array(visionPage).max(1).optional() }).optional(),
        error: z.object({ message: z.string().max(1_000).optional() }).optional(),
      })
    )
    .length(1),
});

export type OcrBlock = {
  id: string;
  text: string;
  /**
   * Fractions of the prepared image. Always set by the OCR engines; absent
   * only for a Gemini line whose box_2d was invalid (the text is kept, its
   * position, size and colours are then unknown).
   */
  box?: Box;
  confidence: number;
  /** Median word height in pixels of the prepared image (absent without a box). */
  heightPx?: number;
};

export type OcrResult = {
  /** Size of the image that was read (the prepared image). */
  width: number;
  height: number;
  /** OCR page-level confidence (0–1); 0 when nothing was read. */
  pageConfidence: number;
  blocks: OcrBlock[];
};

const SPACE_BREAKS = new Set(["SPACE", "SURE_SPACE", "EOL_SURE_SPACE", "LINE_BREAK", "HYPHEN"]);

function boxOf(p: z.infer<typeof poly>, width: number, height: number): Box | null {
  const vs = p?.vertices ?? [];
  if (vs.length < 3) return null;
  const xs = vs.map((v) => v.x ?? 0);
  const ys = vs.map((v) => v.y ?? 0);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp(Math.min(...xs) / width);
  const y0 = clamp(Math.min(...ys) / height);
  const x1 = clamp(Math.max(...xs) / width);
  const y1 = clamp(Math.max(...ys) / height);
  if (x1 <= x0 || y1 <= y0) return null;
  return roundBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const roundBox = (b: Box): Box => ({ x: r6(b.x), y: r6(b.y), w: r6(b.w), h: r6(b.h) });

/**
 * Parses a Vision response for an image of `width` × `height` px into text
 * blocks (one per OCR paragraph) with boxes, confidence and size.
 */
export function validateOcrResponse(text: unknown, width: number, height: number): Validated<OcrResult> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.ocrBytes, RESPONSE_LIMITS.ocrDepth);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(visionResponse, parsed.value);
  if (!shaped.ok) return shaped;
  const response = shaped.value.responses[0];
  if (response.error) return { ok: false, reason: "the text reader reported an error" };
  const page = response.fullTextAnnotation?.pages?.[0];
  const paragraphs = (page?.blocks ?? []).flatMap((b) => b.paragraphs ?? []);
  if (paragraphs.length > RESPONSE_LIMITS.ocrMaxParagraphs) return { ok: false, reason: "too many text blocks" };
  if (paragraphs.reduce((n, p) => n + p.words.length, 0) > RESPONSE_LIMITS.ocrMaxWords) return { ok: false, reason: "too many words" };

  const blocks: OcrBlock[] = [];
  for (const p of paragraphs) {
    let textOut = "";
    const heights: number[] = [];
    const confidences: number[] = [];
    for (const w of p.words) {
      for (const s of w.symbols) {
        textOut += s.text;
        if (SPACE_BREAKS.has(s.property?.detectedBreak?.type ?? "")) textOut += " ";
      }
      if (!/\s$/.test(textOut)) textOut += " ";
      const wb = boxOf(w.boundingBox, width, height);
      if (wb) heights.push(wb.h * height);
      if (w.confidence !== undefined) confidences.push(w.confidence);
    }
    const clean = textOut.replace(/\s+/g, " ").trim().slice(0, RESPONSE_LIMITS.textChars);
    const box = boxOf(p.boundingBox, width, height);
    if (!clean || !box) continue;
    heights.sort((a, b) => a - b);
    blocks.push({
      id: `b${blocks.length + 1}`,
      text: clean,
      box,
      // The weakest word decides: one unsure character can change a price.
      confidence: confidences.length ? Math.min(...confidences) : (p.confidence ?? 0),
      heightPx: Math.round(heights[Math.floor(heights.length / 2)] ?? box.h * height),
    });
  }
  return { ok: true, value: { width, height, pageConfidence: blocks.length ? (page?.confidence ?? 0) : 0, blocks } };
}

// ---------------------------------------------------------------------------
// OCR (local PaddleOCR adapter, "local-ocr-v1" — lib/analysis/local/ocr.ts)
// ---------------------------------------------------------------------------

/**
 * Local OCR confidence is a recognition score: two real misreads in the
 * 2026-10-06 trial still scored ≥ 0.90. A line counts at full confidence
 * only when an independent second read (a different PaddleOCR model on the
 * cropped line) agrees; otherwise it is capped just below the 0.90 bar that
 * a CRITICAL finding needs.
 */
export const LOCAL_UNCONFIRMED_CAP = 0.89;

const localLine = z.strictObject({
  text: z.string().max(RESPONSE_LIMITS.textChars),
  box: z.strictObject({ x: coord, y: coord, w: z.number().finite().min(0).max(100_000), h: z.number().finite().min(0).max(100_000) }),
  confidence,
  secondRead: z.enum(["agree", "disagree", "none"]),
});
const localOcrResponse = z.strictObject({
  format: z.literal("local-ocr-v1"),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
  lines: z.array(localLine).max(RESPONSE_LIMITS.ocrMaxParagraphs),
});

export function validateLocalOcr(text: unknown, width: number, height: number): Validated<OcrResult> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.ocrBytes, 6);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(localOcrResponse, parsed.value);
  if (!shaped.ok) return shaped;
  if (shaped.value.width !== width || shaped.value.height !== height) return { ok: false, reason: "the text reader read a different image size" };
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const blocks: OcrBlock[] = [];
  let chars = 0;
  let weighted = 0;
  for (const line of shaped.value.lines) {
    const clean = line.text.replace(/\s+/g, " ").trim();
    const x0 = clamp(line.box.x / width);
    const y0 = clamp(line.box.y / height);
    const x1 = clamp((line.box.x + line.box.w) / width);
    const y1 = clamp((line.box.y + line.box.h) / height);
    if (!clean || x1 <= x0 || y1 <= y0) continue;
    chars += clean.length;
    weighted += clean.length * line.confidence;
    blocks.push({
      id: `b${blocks.length + 1}`,
      text: clean,
      box: roundBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }),
      confidence: line.secondRead === "agree" ? line.confidence : Math.min(line.confidence, LOCAL_UNCONFIRMED_CAP),
      heightPx: Math.max(1, Math.round((y1 - y0) * height)),
    });
  }
  // Page confidence: the recognition scores, weighted by characters (not capped — coverage, not certainty).
  return { ok: true, value: { width, height, pageConfidence: chars ? Math.round((weighted / chars) * 1000) / 1000 : 0, blocks } };
}

/** The OCR validator for a provider's response shape (Vision for Google and the mock; local-v1 for local). */
export function ocrValidator(provider: { ocrFormat?: "vision" | "local-v1" | "gemini-v1" }): (raw: unknown, width: number, height: number) => Validated<OcrResult> {
  if (provider.ocrFormat === "gemini-v1") return validateGeminiText;
  return provider.ocrFormat === "local-v1" ? validateLocalOcr : validateOcrResponse;
}

// ---------------------------------------------------------------------------
// Image judgement (Gemini, 6.5) — strict: unknown fields are rejected
// ---------------------------------------------------------------------------

/** How sure the model says it is. Categories, NOT calibrated probabilities. */
export const CERTAINTIES = ["clear", "likely", "unsure"] as const;
const certainty = z.enum(CERTAINTIES);
const box2d = z
  .array(z.number().int().min(0).max(1000))
  .length(4)
  .refine(([ymin, xmin, ymax, xmax]) => ymin < ymax && xmin < xmax, "invalid box");
const note = z.string().max(RESPONSE_LIMITS.noteChars);

export const IMAGE_JUDGEMENT_SCHEMA = z.strictObject({
  blocks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^b\d{1,4}$/),
        role: z.enum(["headline", "body", "cta", "disclaimer", "other"]),
        fontFamily: z.string().max(80).nullable(),
        bold: z.boolean().nullable(),
        certainty,
      })
    )
    .max(RESPONSE_LIMITS.maxBlocks),
  fonts: z.array(z.strictObject({ family: z.string().min(1).max(80), certainty })).max(RESPONSE_LIMITS.maxFonts),
  logo: z.strictObject({
    present: z.boolean(),
    matchesCompanyLogo: z.boolean().nullable(),
    box: box2d.nullable(),
    certainty,
  }),
  focalPoint: z.strictObject({ x: z.number().int().min(0).max(1000), y: z.number().int().min(0).max(1000), certainty }).nullable(),
  imageIssues: z
    .array(
      z.strictObject({
        issue: z.enum(["blurry", "pixelated", "stretched", "watermark", "cut_off"]),
        certainty,
        note,
      })
    )
    .max(RESPONSE_LIMITS.maxIssues),
  colorOnlyMeaning: z.strictObject({ present: z.boolean(), certainty, note }),
});
export type ImageJudgement = z.infer<typeof IMAGE_JUDGEMENT_SCHEMA>;

/**
 * Validates a judgement. `blockIds` are the OCR blocks that were supplied —
 * a judgement may only label those (the AI never authors text).
 */
export function validateImageJudgement(text: unknown, blockIds: ReadonlySet<string>): Validated<ImageJudgement> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.aiBytes, RESPONSE_LIMITS.aiDepth);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(IMAGE_JUDGEMENT_SCHEMA, parsed.value);
  if (!shaped.ok) return shaped;
  const unknown = shaped.value.blocks.find((b) => !blockIds.has(b.id));
  if (unknown) return { ok: false, reason: "response labelled text that was not supplied" };
  if (new Set(shaped.value.blocks.map((b) => b.id)).size !== shaped.value.blocks.length) {
    return { ok: false, reason: "response labelled the same text twice" };
  }
  return shaped;
}

/** Gemini's 0–1000 [ymin, xmin, ymax, xmax] → our fraction box. */
export function boxFrom2d([ymin, xmin, ymax, xmax]: number[]): Box {
  return roundBox({ x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 });
}

// ---------------------------------------------------------------------------
// Transcript (Gemini, 6.6)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_SCHEMA = z.strictObject({
  hasSpeech: z.boolean(),
  segments: z
    .array(
      z.strictObject({
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        text: z.string().min(1).max(RESPONSE_LIMITS.textChars),
        certainty,
      })
    )
    .max(RESPONSE_LIMITS.maxSegments),
});
export type Transcript = z.infer<typeof TRANSCRIPT_SCHEMA>;

export function validateTranscript(text: unknown, durationMs: number): Validated<Transcript> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.aiBytes, RESPONSE_LIMITS.aiDepth);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(TRANSCRIPT_SCHEMA, parsed.value);
  if (!shaped.ok) return shaped;
  const slack = 1_000;
  const bad = shaped.value.segments.find((s) => s.endMs <= s.startMs || s.endMs > durationMs + slack);
  if (bad) return { ok: false, reason: "response had an impossible timestamp" };
  if (!shaped.value.hasSpeech && shaped.value.segments.length) return { ok: false, reason: "response contradicted itself" };
  return shaped;
}

// ---------------------------------------------------------------------------
// Requirement candidates (6.7)
// ---------------------------------------------------------------------------

const requirementType = z.enum(REQUIREMENT_TYPES.map((t) => t.value) as [string, ...string[]]);

export const REQUIREMENT_CANDIDATES_SCHEMA = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        type: requirementType,
        label: z.string().min(1).max(120).nullable(),
        value: z.string().min(1).max(500),
        quote: z.string().min(1).max(500),
      })
    )
    .max(RESPONSE_LIMITS.maxCandidates),
});
export type RequirementCandidates = z.infer<typeof REQUIREMENT_CANDIDATES_SCHEMA>;

export function validateRequirementCandidates(text: unknown): Validated<RequirementCandidates> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.aiBytes, RESPONSE_LIMITS.aiDepth);
  if (!parsed.ok) return parsed;
  return fromSchema(REQUIREMENT_CANDIDATES_SCHEMA, parsed.value);
}

// ---------------------------------------------------------------------------
// Gemini API provider: text read by the model (no OCR engine) — "gemini-v1"
// ---------------------------------------------------------------------------

/**
 * Gemini says how sure it is per line; these are the same AI categories as
 * every other AI judgement (assemble.ts AI_CONFIDENCE), NOT a measured OCR
 * confidence — the "gemini" policy profile treats this text as AI evidence.
 */
export const CERTAINTY_CONFIDENCE = { clear: 0.9, likely: 0.7, unsure: 0.4 } as const;

/**
 * Gemini's boxes and focal point are OPTIONAL: Gemini sometimes returns a
 * box that is clearly wrong (e.g. every y negated on a design both 3.5
 * Flash-Lite and 3.8 Flash read that way). A box or point that isn't fully
 * valid (box2d: four integers 0–1000, ymin < ymax, xmin < xmax) is DISCARDED
 * on its own — never repaired, never sign-flipped — and the rest of the
 * answer is still validated strictly (text, role, certainty, fonts, logo
 * presence / match, image issues, colour-only meaning). Slightly-out values
 * were already clamped by the Gemini provider (clampGeminiCoordinates).
 * Without a position, the position-based passes (overlap, edges, text size)
 * become not verified in the confidence policy, never a blanket pass.
 */
const optionalBox = z.unknown().optional();
const validBoxOrNull = (value: unknown): number[] | null => {
  const box = box2d.safeParse(value);
  return box.success ? box.data : null;
};
const coordinate = z.number().int().min(0).max(1000);

const geminiTextLine = z.strictObject({ text: z.string().max(RESPONSE_LIMITS.textChars), box_2d: optionalBox, certainty });
const GEMINI_TEXT_SCHEMA = z.strictObject({ texts: z.array(geminiTextLine).max(500) });

/** Text lines (with 0–1000 boxes and certainty) → the shared OcrResult for an image of width × height px. */
function blocksFrom(lines: { text: string; box_2d?: unknown; certainty: (typeof CERTAINTIES)[number] }[], height: number): { blocks: OcrBlock[]; kept: number[] } {
  const blocks: OcrBlock[] = [];
  const kept: number[] = [];
  lines.forEach((line, i) => {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    const valid = validBoxOrNull(line.box_2d);
    const box = valid ? boxFrom2d(valid) : null;
    kept.push(i);
    blocks.push({
      id: `b${blocks.length + 1}`,
      text,
      ...(box ? { box, heightPx: Math.max(1, Math.round(box.h * height)) } : {}),
      confidence: CERTAINTY_CONFIDENCE[line.certainty],
    });
  });
  return { blocks, kept };
}

const pageConfidenceOf = (blocks: OcrBlock[]) => (blocks.length ? Math.round((blocks.reduce((n, b) => n + b.confidence, 0) / blocks.length) * 1000) / 1000 : 0);

export function validateGeminiText(text: unknown, width: number, height: number): Validated<OcrResult> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.aiBytes, RESPONSE_LIMITS.aiDepth);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(GEMINI_TEXT_SCHEMA, parsed.value);
  if (!shaped.ok) return shaped;
  const { blocks } = blocksFrom(shaped.value.texts, height);
  return { ok: true, value: { width, height, pageConfidence: pageConfidenceOf(blocks), blocks } };
}

/** One-call design analysis (DESIGN_ANALYSIS_SCHEMA): text lines + the visual judgement. */
const DESIGN_ANALYSIS = z.strictObject({
  texts: z
    .array(
      z.strictObject({
        text: z.string().max(RESPONSE_LIMITS.textChars),
        box_2d: optionalBox,
        role: z.enum(["headline", "body", "cta", "disclaimer", "other"]),
        fontFamily: z.string().max(80).nullable(),
        bold: z.boolean().nullable(),
        certainty,
      })
    )
    .max(RESPONSE_LIMITS.maxBlocks),
  fonts: IMAGE_JUDGEMENT_SCHEMA.shape.fonts,
  // Same fields as IMAGE_JUDGEMENT_SCHEMA, but the logo box and the focal point's x / y may be
  // invalid: they are discarded below, then the whole judgement is re-checked strictly.
  logo: z.strictObject({ present: z.boolean(), matchesCompanyLogo: z.boolean().nullable(), box: optionalBox, certainty }),
  focalPoint: z.strictObject({ x: z.unknown(), y: z.unknown(), certainty }).nullable(),
  imageIssues: IMAGE_JUDGEMENT_SCHEMA.shape.imageIssues,
  colorOnlyMeaning: IMAGE_JUDGEMENT_SCHEMA.shape.colorOnlyMeaning,
});

export type DesignAnalysis = { ocr: OcrResult; judgement: ImageJudgement };

/**
 * Validates a one-call design analysis for an image of width × height px
 * and splits it into the SAME two validated results the two-step providers
 * produce: an OcrResult and an ImageJudgement (re-checked by
 * validateImageJudgement, so the strict judgement rules apply unchanged).
 */
export function validateDesignAnalysis(text: unknown, width: number, height: number): Validated<DesignAnalysis> {
  const parsed = parseJsonSafely(text, RESPONSE_LIMITS.aiBytes, RESPONSE_LIMITS.aiDepth);
  if (!parsed.ok) return parsed;
  const shaped = fromSchema(DESIGN_ANALYSIS, parsed.value);
  if (!shaped.ok) return shaped;
  const { texts, logo, focalPoint, ...rest } = shaped.value;
  const { blocks, kept } = blocksFrom(texts, height);
  const point = focalPoint && coordinate.safeParse(focalPoint.x).success && coordinate.safeParse(focalPoint.y).success ? focalPoint : null;
  const judgement = validateImageJudgement(
    JSON.stringify({
      ...rest,
      logo: { ...logo, box: validBoxOrNull(logo.box) },
      focalPoint: point,
      blocks: kept.map((i, n) => ({ id: `b${n + 1}`, role: texts[i].role, fontFamily: texts[i].fontFamily, bold: texts[i].bold, certainty: texts[i].certainty })),
    }),
    new Set(blocks.map((b) => b.id))
  );
  if (!judgement.ok) return judgement;
  return { ok: true, value: { ocr: { width, height, pageConfidence: pageConfidenceOf(blocks), blocks }, judgement: judgement.value } };
}
