import type { Box, ContentDetections, DetectedText } from "@/lib/qc/detections";
import { normalizeWords } from "@/lib/qc/compare";
import { boxFrom2d, type ImageJudgement, type OcrResult, type Transcript } from "@/lib/analysis/validate";
import type { ProviderName } from "@/lib/analysis/provider";

/**
 * Builds the ONE ContentDetections object for a run from what each analysed
 * frame produced (pure; no I/O):
 *   MEASURED  — OCR text / boxes / confidence, pixel colours, audio levels;
 *   AI-JUDGED — roles, fonts, logo, focal point, image issues, colour-only
 *               meaning, transcript.
 * Text only ever comes from OCR — the AI's judgement can label an OCR block
 * by id, never add text.
 *
 * AI certainty is a CATEGORY the model reports, not a calibrated
 * probability. It maps to fixed numbers only so the existing rules can word
 * findings (fact vs judgement); lib/analysis/policy.ts decides what counts.
 */
export const AI_CONFIDENCE = { clear: 0.9, likely: 0.7, unsure: 0.4 } as const;

export type MeasuredColours = {
  /** Text / background colour per OCR block id, sampled from pixels. */
  byBlock: Record<string, { color: string; background: string }>;
  /** Dominant colours of the frame with their share (0–1). */
  dominant: { hex: string; share: number }[];
};

/** Everything one analysed frame (an image, a PDF page, or a video frame) produced. */
export type FrameAnalysis = {
  fileId: string;
  page?: number;
  /** Video frames: when this frame was taken, and the sampling interval. */
  timeMs?: number;
  intervalMs?: number;
  /** The ORIGINAL frame size in pixels (file / page / video), for text size. */
  frame: { width: number; height: number };
  ocr: OcrResult | null;
  judgement: ImageJudgement | null;
  colours: MeasuredColours | null;
};

export type AssembleInput = {
  provider: ProviderName;
  frames: FrameAnalysis[];
  /** Share (0–1) of the content that was analysed: pages, frames, duration. */
  analysedShare: number;
  transcript?: Transcript | null;
  audio?: { hasAudio: boolean; integratedLufs?: number; peakDbfs?: number } | null;
  /** Whether the company has a saved logo (else logo identity isn't judged). */
  hasCompanyLogo: boolean;
};

const textKey = (t: string) => normalizeWords(t);

function overlaps(a: Box, b: Box): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 && w * h >= 0.5 * Math.min(a.w * a.h, b.w * b.h);
}

export function assembleDetections(input: AssembleInput): ContentDetections {
  const d: ContentDetections = { source: input.provider === "mock" ? "mock" : "ai" };
  const ocrFrames = input.frames.filter((f) => f.ocr);

  // Frame sizes (one per file / page; video frames share their file's size).
  const frameKeys = new Set<string>();
  d.frames = [];
  for (const f of input.frames) {
    const key = `${f.fileId}#${f.page ?? ""}`;
    if (frameKeys.has(key)) continue;
    frameKeys.add(key);
    d.frames.push({ fileId: f.fileId, ...(f.page !== undefined ? { page: f.page } : {}), width: f.frame.width, height: f.frame.height });
  }
  if (d.frames.length === 1) d.frame = { width: d.frames[0].width, height: d.frames[0].height };

  // ---- Text (MEASURED by OCR; roles / fonts labelled by the AI) ----
  if (ocrFrames.length) {
    const texts: DetectedText[] = [];
    for (const f of ocrFrames) {
      const labels = new Map((f.judgement?.blocks ?? []).map((b) => [b.id, b]));
      for (const block of f.ocr!.blocks) {
        const label = labels.get(block.id);
        const usable = label && label.certainty !== "unsure";
        const colour = f.colours?.byBlock[block.id];
        const item: DetectedText = {
          text: block.text,
          fileId: f.fileId,
          ...(f.page !== undefined ? { page: f.page } : {}),
          // A Gemini line whose box was invalid has no position or size (validate.ts).
          ...(block.box ? { box: block.box } : {}),
          // OCR measured the height in the prepared image; scale to the original frame.
          ...(block.heightPx !== undefined ? { fontSizePx: Math.max(1, Math.round((block.heightPx / f.ocr!.height) * f.frame.height)) } : {}),
          confidence: block.confidence,
          ...(usable ? { role: label.role, roleConfidence: AI_CONFIDENCE[label.certainty] } : {}),
          ...(usable && label.fontFamily ? { fontFamily: label.fontFamily } : {}),
          ...(usable && label.bold !== null ? { bold: label.bold } : {}),
          ...(colour ? { color: colour.color, background: colour.background } : {}),
        };
        if (f.timeMs !== undefined) {
          // Video: merge the same text seen in consecutive frames into one on-screen span.
          const end = f.timeMs + (f.intervalMs ?? 1000);
          const previous = texts.find(
            (t) => t.fileId === f.fileId && t.endMs === f.timeMs && textKey(t.text) === textKey(block.text) && t.box && block.box && overlaps(t.box, block.box)
          );
          if (previous) {
            previous.endMs = end;
            previous.confidence = Math.min(previous.confidence, block.confidence);
            continue;
          }
          item.startMs = f.timeMs;
          item.endMs = end;
        }
        texts.push(item);
      }
    }
    d.texts = texts;
    const meanPage = input.frames.reduce((sum, f) => sum + (f.ocr?.pageConfidence ?? 0), 0) / Math.max(1, input.frames.length);
    d.textCoverage = Math.round(meanPage * Math.min(1, Math.max(0, input.analysedShare)) * 1000) / 1000;
  } else {
    // Nothing was read: say so, so no "nothing wrong found" can pass (6.9).
    d.textCoverage = 0;
  }

  // ---- Colours (MEASURED from pixels) ----
  const colourFrames = input.frames.filter((f) => f.colours);
  if (colourFrames.length) {
    const shares = new Map<string, number>();
    for (const f of colourFrames) for (const c of f.colours!.dominant) shares.set(c.hex, (shares.get(c.hex) ?? 0) + c.share / colourFrames.length);
    d.colors = [...shares.entries()]
      .map(([hex, share]) => ({ hex, share: Math.round(share * 1000) / 1000 }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 12);
  }

  // ---- AI judgements ----
  const judged = input.frames.filter((f) => f.judgement);
  if (judged.length) {
    const fonts = new Map<string, number>();
    for (const f of judged)
      for (const font of f.judgement!.fonts)
        if (font.certainty !== "unsure") fonts.set(font.family, Math.max(fonts.get(font.family) ?? 0, AI_CONFIDENCE[font.certainty]));
    d.fonts = [...fonts.entries()].map(([family, confidence]) => ({ family, confidence }));

    const logos = judged.map((f) => f.judgement!.logo);
    const seen = logos.filter((l) => l.present);
    const anyMismatch = input.hasCompanyLogo && seen.some((l) => l.matchesCompanyLogo === false);
    const anyMatch = input.hasCompanyLogo && seen.some((l) => l.matchesCompanyLogo === true);
    const firstBox = seen.find((l) => l.box)?.box;
    d.logo = {
      present: seen.length > 0,
      ...(anyMismatch ? { matchesCompanyLogo: false } : anyMatch ? { matchesCompanyLogo: true } : {}),
      ...(firstBox ? { box: boxFrom2d(firstBox) } : {}),
      confidence: Math.min(...(seen.length ? seen : logos).map((l) => AI_CONFIDENCE[l.certainty])),
    };

    const focal = judged[0].judgement!.focalPoint;
    if (focal) d.focalPoint = { x: focal.x / 1000, y: focal.y / 1000, confidence: AI_CONFIDENCE[focal.certainty] };

    d.imageIssues = judged.flatMap((f) =>
      f.judgement!.imageIssues.map((i) => ({ fileId: f.fileId, issue: i.issue, confidence: AI_CONFIDENCE[i.certainty], ...(i.note ? { note: i.note } : {}) }))
    );
    const colourOnly = judged.map((f) => f.judgement!.colorOnlyMeaning);
    const present = colourOnly.filter((c) => c.present);
    const chosen = present.length ? present : colourOnly;
    d.colorOnlyMeaning = {
      present: present.length > 0,
      confidence: Math.min(...chosen.map((c) => AI_CONFIDENCE[c.certainty])),
      ...(present[0]?.note ? { note: present[0].note } : {}),
    };
  }

  // ---- Speech (AI) and audio (MEASURED) ----
  if (input.transcript) {
    d.speech = input.transcript.segments.map((s) => ({ text: s.text, startMs: s.startMs, endMs: s.endMs, confidence: AI_CONFIDENCE[s.certainty] }));
  }
  if (input.audio) d.audio = { ...input.audio, confidence: 1 };
  return d;
}
