import { describe, expect, it } from "vitest";
import { byRule, detections, only, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.8 — Accessibility: contrast, text size, colour-only meaning (+ captions for video). */
describe("Accessibility rules", () => {
  // Frame 1080 × 1350 → shorter side 1080: large text ≥ 32.4px (bold ≥ 25.92px), minimum 17px.
  it("contrast: 4.5:1 for normal text, 3:1 for large text (boundaries)", () => {
    const c = (color: string, size: number, bold = false) =>
      only(run({ detections: detections({ texts: [text("Offer", { color, background: "#ffffff", fontSizePx: size, bold })] }) }), "accessibility.contrast");
    expect(c("#767676", 20).status).toBe("passed"); // 4.54
    expect(c("#777777", 20)).toMatchObject({ status: "failed", severity: "major" }); // 4.48
    expect(c("#949494", 33).status).toBe("passed"); // ~3.03, large
    expect(c("#949494", 32).status).toBe("failed"); // same colour, normal size
    expect(c("#949494", 26, true).status).toBe("passed"); // bold large
  });

  it("text size: under 1.5% of the shorter side is MINOR", () => {
    const s = (px: number) => only(run({ detections: detections({ texts: [text("Small print", { fontSizePx: px })] }) }), "accessibility.text_size");
    expect(s(17).status).toBe("passed");
    expect(s(16)).toMatchObject({ status: "failed", severity: "minor", expected: "At least 17px (1.5% of 1080px)" });
  });

  it("a carousel of different sizes: each text is judged against its own file's frame", () => {
    const d = detections({
      frame: undefined,
      frames: [{ fileId: "small", width: 1080, height: 1080 }, { fileId: "big", width: 2160, height: 2160 }],
      texts: [text("Fine here", { fileId: "small", fontSizePx: 20 }), text("Too small here", { fileId: "big", fontSizePx: 20 })],
    });
    const findings = byRule(run({ detections: d }), "accessibility.text_size");
    expect(findings).toMatchObject([{ status: "failed", expected: "At least 33px (1.5% of 2160px)", fileId: "big" }]);
  });

  it("colour-only meaning", () => {
    const m = (present: boolean) => only(run({ detections: detections({ colorOnlyMeaning: { present, confidence: 0.7 } }) }), "accessibility.color_only");
    expect(m(false).status).toBe("passed");
    const confident = only(run({ detections: detections({ colorOnlyMeaning: { present: true, confidence: 0.99 } }) }), "accessibility.color_only");
    expect(confident.kind).toBe("judgement"); // an interpretation, even at high confidence
    expect(m(true)).toMatchObject({ status: "failed", severity: "minor", kind: "judgement" });
  });

  it("video captions: speech needs on-screen text for at least half its length", () => {
    const speech = [{ text: "Book your villa today", startMs: 0, endMs: 4000, confidence: 0.9 }];
    const captioned = (endMs: number) => detections({ speech, texts: [text("Book your villa today", { startMs: 0, endMs })] });
    expect(only(run({ detections: captioned(2000) }, "reel_short"), "accessibility.captions").status).toBe("passed");
    expect(only(run({ detections: captioned(1999) }, "reel_short"), "accessibility.captions")).toMatchObject({ status: "failed", severity: "minor" });
    expect(only(run({ detections: detections({ speech: [], texts: [] }) }, "reel_short"), "accessibility.captions").status).toBe("not_applicable");
    expect(byRule(run({ detections: captioned(0) }, "design_poster"), "accessibility.captions")).toEqual([]);
  });

  it("no detections → not verified", () => {
    expect(byRule(run(), "accessibility").every((f) => f.status === "unverified")).toBe(true);
  });
});
