import { describe, expect, it } from "vitest";
import { AI_CONFIDENCE, assembleDetections, type FrameAnalysis } from "@/lib/analysis/assemble";
import type { ImageJudgement, OcrResult } from "@/lib/analysis/validate";

/** Building the one ContentDetections object per run (6.4–6.6 mapping, 6.9 inputs). */
describe("assembling ContentDetections", () => {
  const ocr = (blocks: Partial<OcrResult["blocks"][number]>[], pageConfidence = 0.96): OcrResult => ({
    width: 1000,
    height: 1000,
    pageConfidence,
    blocks: blocks.map((b, i) => ({ id: `b${i + 1}`, text: "Text", box: { x: 0.1, y: 0.1 * (i + 1), w: 0.5, h: 0.05 }, confidence: 0.95, heightPx: 40, ...b })),
  });
  const judgement = (over: Partial<ImageJudgement> = {}): ImageJudgement => ({
    blocks: [],
    fonts: [],
    logo: { present: false, matchesCompanyLogo: null, box: null, certainty: "clear" },
    focalPoint: null,
    imageIssues: [],
    colorOnlyMeaning: { present: false, certainty: "clear", note: "" },
    ...over,
  });
  const frame = (over: Partial<FrameAnalysis> = {}): FrameAnalysis => ({
    fileId: "f1",
    frame: { width: 2000, height: 2000 },
    ocr: ocr([{ text: "Summer Sale" }, { text: "Book now" }]),
    judgement: judgement({
      blocks: [
        { id: "b1", role: "headline", fontFamily: "Montserrat", bold: true, certainty: "clear" },
        { id: "b2", role: "cta", fontFamily: null, bold: null, certainty: "unsure" },
      ],
    }),
    colours: { byBlock: { b1: { color: "#1A64B4", background: "#FFFFFF" } }, dominant: [{ hex: "#FFFFFF", share: 0.7 }] },
    ...over,
  });

  it("text comes from OCR; roles and fonts from the AI only when not 'unsure'; size scaled to the original frame", () => {
    const d = assembleDetections({ provider: "google", frames: [frame()], analysedShare: 1, hasCompanyLogo: true });
    expect(d.source).toBe("ai");
    expect(d.frame).toEqual({ width: 2000, height: 2000 });
    expect(d.texts).toEqual([
      { text: "Summer Sale", fileId: "f1", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 }, fontSizePx: 80, confidence: 0.95, role: "headline", roleConfidence: 0.9, fontFamily: "Montserrat", bold: true, color: "#1A64B4", background: "#FFFFFF" },
      { text: "Book now", fileId: "f1", box: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 }, fontSizePx: 80, confidence: 0.95 },
    ]);
    expect(d.textCoverage).toBe(0.96);
    expect(d.colors).toEqual([{ hex: "#FFFFFF", share: 0.7 }]);
  });

  it("the mock is labelled as such", () => {
    expect(assembleDetections({ provider: "mock", frames: [frame()], analysedShare: 1, hasCompanyLogo: false }).source).toBe("mock");
  });

  it("multi-page PDFs: page numbers on text and frames; coverage reflects pages not analysed", () => {
    const d = assembleDetections({
      provider: "google",
      frames: [frame({ page: 1 }), frame({ page: 2, frame: { width: 1000, height: 1400 }, ocr: ocr([{ text: "Page two" }], 0.9) })],
      analysedShare: 2 / 3,
      hasCompanyLogo: false,
    });
    expect(d.frames).toEqual([
      { fileId: "f1", page: 1, width: 2000, height: 2000 },
      { fileId: "f1", page: 2, width: 1000, height: 1400 },
    ]);
    expect(d.frame).toBeUndefined();
    expect(d.texts!.map((t) => [t.text, t.page])).toEqual([["Summer Sale", 1], ["Book now", 1], ["Page two", 2]]);
    expect(d.textCoverage).toBe(Math.round(((0.96 + 0.9) / 2) * (2 / 3) * 1000) / 1000);
  });

  it("no OCR at all → no texts and zero coverage (checks stay not verified)", () => {
    const d = assembleDetections({ provider: "google", frames: [frame({ ocr: null })], analysedShare: 1, hasCompanyLogo: false });
    expect(d.texts).toBeUndefined();
    expect(d.textCoverage).toBe(0);
  });

  it("video: the same text in consecutive frames becomes one timed span; a gap starts a new one", () => {
    const at = (timeMs: number, t = "Sale") => frame({ timeMs, intervalMs: 1000, ocr: ocr([{ text: t }]), judgement: null });
    const d = assembleDetections({ provider: "google", frames: [at(0), at(1000), at(2000), at(5000)], analysedShare: 1, hasCompanyLogo: false });
    expect(d.texts!.map((t) => [t.text, t.startMs, t.endMs])).toEqual([
      ["Sale", 0, 3000],
      ["Sale", 5000, 6000],
    ]);
  });

  it("logo: mismatch anywhere wins; identity is ignored when the company has no saved logo", () => {
    const logo = (matches: boolean | null, certainty: "clear" | "likely" = "clear") =>
      frame({ judgement: judgement({ logo: { present: true, matchesCompanyLogo: matches, box: [0, 0, 100, 100], certainty } }) });
    const d = assembleDetections({ provider: "google", frames: [logo(true), logo(false, "likely")], analysedShare: 1, hasCompanyLogo: true });
    expect(d.logo).toEqual({ present: true, matchesCompanyLogo: false, box: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: AI_CONFIDENCE.likely });
    const none = assembleDetections({ provider: "google", frames: [logo(false)], analysedShare: 1, hasCompanyLogo: false });
    expect(none.logo).not.toHaveProperty("matchesCompanyLogo");
  });

  it("AI categories map to fixed values; transcript and audio are carried", () => {
    const d = assembleDetections({
      provider: "google",
      frames: [frame({ judgement: judgement({ fonts: [{ family: "Arial", certainty: "likely" }, { family: "Comic", certainty: "unsure" }], imageIssues: [{ issue: "blurry", certainty: "clear", note: "" }] }) })],
      analysedShare: 1,
      hasCompanyLogo: false,
      transcript: { hasSpeech: true, segments: [{ startMs: 0, endMs: 900, text: "Hi", certainty: "clear" }] },
      audio: { hasAudio: true, integratedLufs: -14.2, peakDbfs: -1.5 },
    });
    expect(d.fonts).toEqual([{ family: "Arial", confidence: 0.7 }]);
    expect(d.imageIssues).toEqual([{ fileId: "f1", issue: "blurry", confidence: 0.9 }]);
    expect(d.speech).toEqual([{ text: "Hi", startMs: 0, endMs: 900, confidence: 0.9 }]);
    expect(d.audio).toEqual({ hasAudio: true, integratedLufs: -14.2, peakDbfs: -1.5, confidence: 1 });
  });
});
