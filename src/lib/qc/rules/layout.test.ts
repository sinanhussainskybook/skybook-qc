import { describe, expect, it } from "vitest";
import { byRule, detections, only, run, text } from "../../../../test/qc-fixtures";
import { gridCell } from "@/lib/qc/rules/layout";
import { scoreFindings } from "@/lib/qc/scoring";

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

  describe("Rule of Thirds — the main subject in a 3×3 grid, a soft suggestion only", () => {
    const at = (x: number, y: number) => only(run({ detections: detections({ focalPoint: { x, y, confidence: 0.9 } }) }), "layout.rule_of_thirds");

    it("on or near a thirds crossing → passed, naming the grid cell", () => {
      expect(at(0.34, 0.66)).toMatchObject({ status: "passed", severity: "suggestion", kind: "judgement" }); // a judgement, even when confident
      expect(at(0.34, 0.66).detected).toBe("Main subject in the middle-centre of the 3×3 grid (34% across, 66% down)");
      expect(at(0.7, 0.3)).toMatchObject({ status: "passed", explanation: "The main subject sits on a thirds crossing." });
    });

    it("a centred composition is deliberate — never flagged, at the centre or anywhere on the vertical centre line", () => {
      for (const [x, y] of [[0.5, 0.5], [0.51, 0.26], [0.45, 0.8], [0.57, 0.5]]) {
        const f = at(x, y);
        expect([x, y, f.status, f.suggestedFix]).toEqual([x, y, "passed", undefined]);
        expect(f.explanation).toMatch(/centred — a balanced, deliberate composition/);
      }
      expect(at(0.51, 0.26).detected).toBe("Main subject in the top-centre of the 3×3 grid (51% across, 26% down)"); // the real Travel Mart poster
    });

    it("off-centre and away from every crossing → a suggestion with a short reason and an optional improvement; never counted", () => {
      for (const [x, y] of [[0.15, 0.5], [0.85, 0.1], [0.2, 0.9], [0.62, 0.5]]) {
        const f = at(x, y);
        expect([x, y, f.status, f.severity, f.kind]).toEqual([x, y, "failed", "suggestion", "judgement"]);
        expect(f.explanation).toMatch(/^A suggestion only: .*It doesn't affect the result\.$/);
        expect(f.suggestedFix).toBe("Optional: move the main subject onto a thirds crossing, or centre it deliberately.");
      }
      expect(at(0.15, 0.5).detected).toBe("Main subject in the middle-left of the 3×3 grid (15% across, 50% down)");
      // A suggestion never changes the result or the score.
      const board = scoreFindings([at(0.15, 0.5)]);
      expect([board.result, board.score, board.issues.suggestion]).toEqual(["pass", 100, 1]);
    });

    it("no focal point from the analysis → not verified (a suggestion, never counted)", () => {
      expect(only(run(), "layout.rule_of_thirds")).toMatchObject({ status: "unverified", severity: "suggestion" });
    });

    it("the 3×3 grid cells", () => {
      expect([gridCell({ x: 0.1, y: 0.1 }), gridCell({ x: 0.5, y: 0.5 }), gridCell({ x: 0.9, y: 0.9 }), gridCell({ x: 0.34, y: 0.66 })]).toEqual(["top-left", "middle-centre", "bottom-right", "middle-centre"]);
    });
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
