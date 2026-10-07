import { describe, expect, it } from "vitest";
import { byRule, detections, only, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.7 — Design & Layout. Rule of Thirds is always a SUGGESTION. */
describe("Design & Layout rules", () => {
  it("overlapping text is MAJOR; side-by-side is fine; different video moments don't clash", () => {
    const overlapping = detections({ texts: [text("A", { box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 } }), text("B", { box: { x: 0.3, y: 0.15, w: 0.5, h: 0.1 } })] });
    expect(only(run({ detections: overlapping }), "layout.text_overlap")).toMatchObject({ status: "failed", severity: "major" });
    const apart = detections({ texts: [text("A", { box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }), text("B", { box: { x: 0.5, y: 0.1, w: 0.3, h: 0.1 } })] });
    expect(only(run({ detections: apart }), "layout.text_overlap").status).toBe("passed");
    const timed = detections({
      texts: [
        text("A", { box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }, startMs: 0, endMs: 2000 }),
        text("B", { box: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 }, startMs: 2000, endMs: 4000 }),
      ],
    });
    expect(only(run({ detections: timed }, "reel_short"), "layout.text_overlap").status).toBe("passed");
  });

  it("text within 2% of an edge is MINOR (boundary)", () => {
    const at = (x: number) => detections({ texts: [text("Edge", { box: { x, y: 0.5, w: 0.2, h: 0.05 } })] });
    expect(only(run({ detections: at(0.02) }), "layout.edge_margin").status).toBe("passed");
    expect(only(run({ detections: at(0.019) }), "layout.edge_margin")).toMatchObject({ status: "failed", severity: "minor" });
  });

  it("headline should be the largest text — a SUGGESTION only", () => {
    const d = (h: number) => detections({ texts: [text("Big news", { role: "headline", fontSizePx: h }), text("Details", { role: "body", fontSizePx: 40 })] });
    expect(only(run({ detections: d(80) }), "layout.hierarchy").status).toBe("passed");
    // Subjective (freeze review): a recommendation worded as a judgement, never blocking PASS.
    expect(only(run({ detections: d(40) }), "layout.hierarchy")).toMatchObject({ status: "failed", severity: "suggestion", kind: "judgement" });
  });

  it("Rule of Thirds: never more than a SUGGESTION", () => {
    const at = (x: number, y: number) => only(run({ detections: detections({ focalPoint: { x, y, confidence: 0.9 } }) }), "layout.rule_of_thirds");
    expect(at(0.34, 0.66).status).toBe("passed");
    const centred = at(0.5, 0.5);
    expect(centred).toMatchObject({ status: "failed", severity: "suggestion", kind: "judgement" });
    expect(at(0.34, 0.66).kind).toBe("judgement"); // even when the detection is confident
    expect(centred.explanation).toMatch(/suggestion only/i);
    expect(only(run(), "layout.rule_of_thirds")).toMatchObject({ status: "unverified", severity: "suggestion" });
  });

  it("video: on-screen text must stay up long enough to read (5.14) — not run for images", () => {
    const d = (ms: number) => detections({ texts: [text("Book your villa now", { startMs: 0, endMs: ms })] }); // 4 words → 1.5 s minimum
    expect(only(run({ detections: d(1500) }, "reel_short"), "layout.on_screen_time").status).toBe("passed");
    expect(only(run({ detections: d(1499) }, "youtube_video"), "layout.on_screen_time")).toMatchObject({ status: "failed", severity: "minor" });
    expect(byRule(run({ detections: d(100) }, "social_post"), "layout.on_screen_time")).toEqual([]);
  });

  it("no positions → not verified", () => {
    expect(byRule(run(), "layout").every((f) => f.status === "unverified")).toBe(true);
  });
});
