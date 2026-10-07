import { describe, expect, it } from "vitest";
import { byRule, detections, only, run } from "../../../../test/qc-fixtures";

/** Plan 5.9 — Image & Asset (+ video sound, 5.14). */
describe("Image & Asset rules", () => {
  it("image problems by severity: watermark CRITICAL, blur / pixelation / stretching MAJOR, cut off MINOR", () => {
    const findings = byRule(
      run({
        detections: detections({
          imageIssues: [
            { issue: "watermark", confidence: 0.95, note: "Stock watermark across the villa photo" },
            { issue: "pixelated", confidence: 0.9 },
            { issue: "stretched", confidence: 0.85 },
            { issue: "blurry", confidence: 0.7 },
            { issue: "cut_off", confidence: 0.8 },
          ],
        }),
      }),
      "image.quality"
    );
    expect(findings.map((f) => [f.ruleId, f.severity, f.kind])).toEqual([
      ["image.quality.watermark", "critical", "fact"],
      ["image.quality.blurry", "major", "judgement"],
      ["image.quality.pixelated", "major", "fact"],
      ["image.quality.stretched", "major", "fact"],
      ["image.quality.cut_off", "minor", "fact"],
    ]);
    expect(findings[0].detected).toBe("Stock watermark across the villa photo");
    expect(only(run({ detections: detections({ imageIssues: [] }) }), "image.quality").status).toBe("passed");
    expect(only(run(), "image.quality").status).toBe("unverified");
  });

  it("video sound: none is a SUGGESTION; peaks above −1 dBFS MINOR; loudness outside −20…−9 LUFS a SUGGESTION", () => {
    const a = (audio: object) => byRule(run({ detections: detections({ audio: { hasAudio: true, confidence: 0.9, ...audio } }) }, "youtube_video"), "image.audio");
    expect(a({ peakDbfs: -1, integratedLufs: -14 }).map((f) => f.status)).toEqual(["passed", "passed"]);
    expect(a({ peakDbfs: -0.9 })[0]).toMatchObject({ ruleId: "image.audio.peak", status: "failed", severity: "minor" });
    expect(a({ integratedLufs: -20.1 })[0]).toMatchObject({ ruleId: "image.audio.loudness", status: "failed", severity: "suggestion" });
    expect(a({ integratedLufs: -8.9 })[0]).toMatchObject({ status: "failed" });
    const silent = byRule(run({ detections: detections({ audio: { hasAudio: false, confidence: 1 } }) }, "reel_short"), "image.audio");
    expect(silent).toMatchObject([{ status: "failed", severity: "suggestion" }]);
    expect(byRule(run({ detections: detections({ audio: { hasAudio: false, confidence: 1 } }) }, "social_post"), "image.audio")).toEqual([]);
  });
});
