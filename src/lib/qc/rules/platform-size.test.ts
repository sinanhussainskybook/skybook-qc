import { describe, expect, it } from "vitest";
import { runRules } from "@/lib/qc/engine";
import type { Finding } from "@/lib/qc/findings";
import type { FileFormat } from "@/lib/qc/qc-file";
import type { MediaInfo } from "@/lib/qc/media-info";
import { PLATFORM_RULES, type CustomChoice, type PlatformContext } from "@/lib/qc/rules/platform-size";

/**
 * Platform / Size QC (5.11) against the approved D4 values. Tests B–E of
 * the Phase 5 brief: dimensions and ratio, format, file size, resolution —
 * including the exact boundaries.
 */

const file = (format: FileFormat, media: Partial<MediaInfo> | null, size = 500_000) => ({
  id: "f1",
  fileName: `content.${format}`,
  format,
  size,
  media: media ? ({ unit: format === "pdf" ? "pt" : "px", ...media } as MediaInfo) : null,
});

function check(
  platform: string | null,
  placement: string | null,
  files: PlatformContext["files"],
  custom: CustomChoice | null = null,
  contentType: "social_post" | "reel_short" = "social_post"
) {
  return runRules(PLATFORM_RULES, contentType, { platform, placement, custom, files });
}
const one = (findings: Finding[], ruleId: string) => {
  const found = findings.filter((f) => f.ruleId === ruleId);
  expect(found, ruleId).toHaveLength(1);
  return found[0];
};
const status = (findings: Finding[], ruleId: string) => one(findings, ruleId).status;
const px = (w: number, h: number, extra: Partial<MediaInfo> = {}) => ({ width: w, height: h, ...extra });
const custom = (over: Partial<CustomChoice> = {}): CustomChoice => ({
  label: null, width: 1200, height: 628, unit: "px", minDpi: null, maxBytes: null, ...over,
});

describe("Platform / Size rules", () => {
  it("every failed finding says what was expected, what was detected, the issue and a fix — and nothing is critical", () => {
    const findings = check("instagram", "stories_image", [file("webp", px(1080, 1350), 31_000_000)]);
    const failed = findings.filter((f) => f.status === "failed");
    expect(failed.length).toBeGreaterThan(2);
    for (const f of failed) {
      expect(f.category).toBe("platform_size");
      expect(f.expected, f.ruleId).toBeTruthy();
      expect(f.detected, f.ruleId).toBeTruthy();
      expect(f.explanation, f.ruleId).toBeTruthy();
      expect(f.suggestedFix, f.ruleId).toBeTruthy();
      expect(f.source?.url).toMatch(/^https:\/\/www\.facebook\.com\/business\/ads-guide\//);
    }
    expect(findings.some((f) => f.severity === "critical")).toBe(false);
  });

  describe("B. dimensions and aspect ratio", () => {
    it("correct dimensions pass", () => {
      const findings = check("instagram", "stories_image", [file("png", px(1440, 2560))]);
      expect(findings.filter((f) => f.status === "failed")).toEqual([]);
      expect(status(findings, "platform.ratio")).toBe("passed");
    });

    it("a wrong ratio with a published tolerance is MAJOR", () => {
      const f = one(check("instagram", "stories_image", [file("png", px(1080, 1350))]), "platform.ratio");
      expect(f).toMatchObject({ status: "failed", severity: "major", expected: "9:16 (±1%)", detected: "4:5 (1080 × 1350)" });
    });

    it("a ratio the platform only recommends is a SUGGESTION", () => {
      const f = one(check("linkedin", "image_landscape", [file("png", px(1200, 1200))]), "platform.ratio");
      expect(f).toMatchObject({ status: "failed", severity: "suggestion" });
    });

    it("Instagram feed: allowed range edges (1.91:1 +1% passes, beyond fails; 4:5 −1% passes, beyond fails)", () => {
      const ratio = (w: number, h: number) => status(check("instagram", "feed_image", [file("png", px(w, h))]), "platform.ratio");
      expect(ratio(1929, 1000)).toBe("passed");
      expect(ratio(1930, 1000)).toBe("failed");
      expect(ratio(793, 1000)).toBe("passed");
      expect(ratio(791, 1000)).toBe("failed");
      // Allowed but not the recommended 4:5 → a suggestion on top.
      const findings = check("instagram", "feed_image", [file("png", px(1080, 1080))]);
      expect(one(findings, "platform.ratio_recommended")).toMatchObject({ status: "failed", severity: "suggestion" });
    });

    it("minimum and maximum size, exactly at the limits", () => {
      const sizes = (w: number, h: number) => check("linkedin", "image_square", [file("png", px(w, h))]);
      expect(status(sizes(360, 360), "platform.size_min")).toBe("passed");
      expect(one(sizes(359, 359), "platform.size_min")).toMatchObject({ status: "failed", severity: "major" });
      expect(status(sizes(4320, 4320), "platform.size_max")).toBe("passed");
      expect(one(sizes(4321, 4321), "platform.size_max")).toMatchObject({ status: "failed", severity: "major" });
    });

    it("Instagram Reels: 500 px minimum width applies from 30 seconds", () => {
      const reel = (ms: number) => check("instagram", "reels", [file("mp4", px(400, 711, { durationMs: ms }))], null, "reel_short");
      expect(status(reel(29_999), "platform.size_min")).toBe("passed");
      expect(status(reel(30_000), "platform.size_min")).toBe("failed");
    });

    it("display ads must be one of the listed sizes exactly", () => {
      expect(one(check("display_ad", "google_uploaded_image", [file("png", px(300, 250))]), "platform.exact_size")).toMatchObject({
        status: "passed",
        detected: "300 × 250 (Inline rectangle)",
      });
      expect(status(check("display_ad", "google_uploaded_image", [file("png", px(301, 250))]), "platform.exact_size")).toBe("failed");
    });

    it("LinkedIn video: must match one listed ratio, then that ratio's size range", () => {
      const v = (w: number, h: number) => check("linkedin", "video", [file("mp4", px(w, h, { durationMs: 10_000 }))], null, "reel_short");
      expect(status(v(1920, 1080), "platform.ratio")).toBe("passed");
      expect(status(v(1080, 1080), "platform.ratio")).toBe("passed");
      expect(status(v(2000, 1000), "platform.ratio")).toBe("failed");
      expect(status(v(1100, 1100), "platform.size_max")).toBe("passed");
      expect(status(v(2000, 2000), "platform.size_max")).toBe("failed");
    });

    it("YouTube Shorts: square or vertical, up to 3 minutes", () => {
      const s = (w: number, h: number, ms: number) => check("youtube", "shorts", [file("mp4", px(w, h, { durationMs: ms }))], null, "reel_short");
      expect(status(s(1080, 1920, 180_000), "platform.orientation")).toBe("passed");
      expect(status(s(1080, 1920, 180_000), "platform.duration")).toBe("passed");
      expect(status(s(1080, 1080, 60_000), "platform.orientation")).toBe("passed");
      expect(one(s(1920, 1080, 60_000), "platform.orientation")).toMatchObject({ status: "failed", severity: "major" });
      expect(status(s(1080, 1920, 180_001), "platform.duration")).toBe("failed");
    });

    it("a typed pixel size must match exactly", () => {
      expect(status(check("website_banner", null, [file("png", px(1200, 628))], custom()), "platform.custom_size")).toBe("passed");
      expect(status(check("website_banner", null, [file("png", px(1201, 628))], custom()), "platform.custom_size")).toBe("failed");
    });

    it("a PDF against a pixel size: shape is checked, exact pixels are not verified", () => {
      const findings = check("presentation_slide", null, [file("pdf", { width: 960, height: 540 })], custom({ width: 1920, height: 1080 }));
      expect(status(findings, "platform.ratio")).toBe("passed");
      expect(status(findings, "platform.custom_size")).toBe("unverified");
    });

    it("a PDF against a print size: page size within ±1 mm", () => {
      const a4 = custom({ width: 210, height: 297, unit: "mm" });
      expect(status(check("print", null, [file("pdf", { width: 595, height: 842 })], a4), "platform.print_size")).toBe("passed");
      expect(status(check("print", null, [file("pdf", { width: 612, height: 792 })], a4), "platform.print_size")).toBe("failed");
    });
  });

  describe("C. file format (read from the content, Phase 4)", () => {
    it("an allowed format passes; another is MAJOR", () => {
      expect(status(check("instagram", "feed_image", [file("png", px(1440, 1800))]), "platform.format")).toBe("passed");
      expect(one(check("instagram", "feed_image", [file("webp", px(1440, 1800))]), "platform.format")).toMatchObject({
        status: "failed",
        severity: "major",
        expected: "JPG or PNG",
        detected: "WEBP",
      });
      expect(status(check("linkedin", "video", [file("mov", px(1920, 1080, { durationMs: 5_000 }))], null, "reel_short"), "platform.format")).toBe("failed");
    });
  });

  describe("D. file size", () => {
    const ad = (bytes: number) => check("display_ad", "google_uploaded_image", [file("png", px(300, 250), bytes)]);
    it("below, exactly at and above the 150 KB limit", () => {
      expect(status(ad(149_999), "platform.file_size")).toBe("passed");
      expect(status(ad(150_000), "platform.file_size")).toBe("passed");
      expect(one(ad(150_001), "platform.file_size")).toMatchObject({ status: "failed", severity: "major", expected: "150 KB" });
    });

    it("LinkedIn video minimum 75 KB", () => {
      const v = (bytes: number) => check("linkedin", "video", [file("mp4", px(1920, 1080, { durationMs: 5_000 }), bytes)], null, "reel_short");
      expect(status(v(74_999), "platform.file_size")).toBe("failed");
      expect(status(v(75_000), "platform.file_size")).toBe("passed");
    });

    it("an optional typed limit for custom platforms", () => {
      const c = custom({ maxBytes: 1_000_000 });
      expect(status(check("email_banner", null, [file("png", px(1200, 628), 1_000_000)], c), "platform.file_size")).toBe("passed");
      expect(status(check("email_banner", null, [file("png", px(1200, 628), 1_000_001)], c), "platform.file_size")).toBe("failed");
      expect(check("email_banner", null, [file("png", px(1200, 628), 9_000_000)], custom()).some((f) => f.ruleId === "platform.file_size")).toBe(false);
    });
  });

  describe("E. resolution", () => {
    it("recommended resolution: met passes, below is a SUGGESTION", () => {
      expect(status(check("instagram", "feed_image", [file("png", px(1440, 1800))]), "platform.resolution_recommended")).toBe("passed");
      expect(one(check("instagram", "feed_image", [file("png", px(1080, 1350))]), "platform.resolution_recommended")).toMatchObject({
        status: "failed",
        severity: "suggestion",
      });
    });

    it("print DPI at the typed size: 300 DPI A4 needs 2481 × 3508", () => {
      const a4 = custom({ width: 210, height: 297, unit: "mm", minDpi: 300 });
      expect(status(check("print", null, [file("png", px(2481, 3508))], a4), "platform.print_resolution")).toBe("passed");
      expect(one(check("print", null, [file("png", px(2480, 3508))], a4), "platform.print_resolution")).toMatchObject({
        status: "failed",
        severity: "major",
      });
    });

    it("not verified where it can't be measured — never guessed", () => {
      const a4 = custom({ width: 210, height: 297, unit: "mm", minDpi: 300 });
      expect(status(check("print", null, [file("pdf", { width: 595, height: 842 })], a4), "platform.print_resolution")).toBe("unverified");
      const unmeasured = check("instagram", "feed_image", [file("png", { note: "The file's size details couldn't be read." })]);
      expect(one(unmeasured, "platform.dimensions")).toMatchObject({ status: "unverified", explanation: "The file's size details couldn't be read." });
      expect(unmeasured.some((f) => f.ruleId === "platform.ratio")).toBe(false);
      const noLength = check("instagram", "reels", [file("webm", px(1080, 1920))], null, "reel_short");
      expect(status(noLength, "platform.duration")).toBe("unverified");
    });

    it("YouTube resolutions are a guide only (SUGGESTION)", () => {
      const y = (w: number, h: number) => check("youtube", "video", [file("mp4", px(w, h, { durationMs: 5_000 }))], null, "reel_short");
      expect(status(y(1920, 1080), "platform.resolution_guide")).toBe("passed");
      expect(one(y(320, 180), "platform.resolution_guide")).toMatchObject({ status: "failed", severity: "suggestion" });
    });
  });

  describe("not verified: safe zones, unconfigured placements, no choice", () => {
    it("safe zones need visual analysis (Phase 6)", () => {
      const f = one(check("instagram", "stories_image", [file("png", px(1440, 2560))]), "platform.safe_zone");
      expect(f).toMatchObject({ status: "unverified", confidence: 0 });
      expect(f.expected).toContain("top 14%");
    });

    it("Facebook Reels has no configured values", () => {
      const findings = check("facebook", "reels", [file("mp4", px(1080, 1920, { durationMs: 5_000 }))], null, "reel_short");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ ruleId: "platform.not_configured", status: "unverified" });
    });

    it("no platform chosen", () => {
      expect(check(null, null, [file("png", px(10, 10))])).toMatchObject([{ ruleId: "platform.choice", status: "unverified" }]);
    });
  });
});
