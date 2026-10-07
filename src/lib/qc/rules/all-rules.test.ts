import { describe, expect, it } from "vitest";
import { CATEGORIES, type Finding } from "@/lib/qc/findings";
import { CONTENT_TYPES } from "@/lib/qc/content-types";
import { QC_RULES } from "@/lib/qc/rules";
import { company, detections, golden, requirement, run, text } from "../../../../test/qc-fixtures";

/**
 * The plan's "done when" for Phase 5: given fixture inputs, the engine
 * returns the right findings for EVERY category — through one engine, for
 * all four content types — and with no detections nothing is guessed.
 */
describe("all QC rules through the one engine", () => {
  it("every rule is in one of the nine categories and declares what it needs", () => {
    const categories = CATEGORIES.map((c) => c.value);
    for (const rule of QC_RULES) {
      expect(categories, rule.id).toContain(rule.category);
      expect(rule.needs.length, rule.id).toBeGreaterThan(0);
      expect(rule.appliesTo.length, rule.id).toBeGreaterThan(0);
    }
    expect(new Set(QC_RULES.map((r) => r.category))).toEqual(new Set(categories));
  });

  it("with fixture detections, every category produces checked (passed / failed) findings", () => {
    const findings = run(
      {
        company: company({ goldenRules: [golden({ category: "approved_cta", approved_value: "Book now" })] }),
        requirements: [requirement("price", "AED 1,299"), requirement("disclaimer", "T&Cs apply")],
        platform: {
          platform: "instagram",
          placement: "feed_image",
          custom: null,
          files: [{ id: "f1", fileName: "post.png", format: "png", size: 500_000, media: { unit: "px", width: 1440, height: 1800 } }],
        },
        detections: detections({
          texts: [
            text("Skybook Villas — from AED 1,299", { role: "headline", fontSizePx: 80, color: "#1A64B4", background: "#ffffff", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 } }),
            text("Book now", { role: "cta", fontSizePx: 40, color: "#ffffff", background: "#1A64B4", box: { x: 0.1, y: 0.8, w: 0.3, h: 0.06 } }),
            text("T&Cs apply", { role: "disclaimer", fontSizePx: 20, color: "#222222", background: "#ffffff", box: { x: 0.1, y: 0.9, w: 0.3, h: 0.03 } }),
          ],
          colors: [{ hex: "#1A64B4", share: 0.3 }, { hex: "#ffffff", share: 0.6 }],
          fonts: [{ family: "Montserrat", confidence: 0.95 }],
          logo: { present: true, matchesCompanyLogo: true, confidence: 0.95 },
          focalPoint: { x: 0.33, y: 0.66, confidence: 0.9 },
          imageIssues: [],
          colorOnlyMeaning: { present: false, confidence: 0.9 },
        }),
      },
      "social_post"
    );
    for (const { value } of CATEGORIES) {
      const checked = findings.filter((f) => f.category === value && (f.status === "passed" || f.status === "failed"));
      expect(checked.length, value).toBeGreaterThan(0);
    }
    // This fixture is a clean design: nothing should fail.
    expect(findings.filter((f) => f.status === "failed").map((f) => [f.ruleId, f.detected])).toEqual([]);
  });

  it("with NO detections (today, before Phase 6): nothing is passed or failed except Platform / Size — never a guess", () => {
    for (const { value } of CONTENT_TYPES) {
      const findings = run({ requirements: [requirement("price", "AED 1,299")] }, value);
      const decided = findings.filter((f) => f.category !== "platform_size" && (f.status === "passed" || f.status === "failed"));
      expect(decided, value).toEqual([]);
      expect(findings.every((f) => f.status !== "unverified" || f.confidence === 0)).toBe(true);
    }
  });

  it("video-only checks run only for Reel / Short and YouTube", () => {
    const ids = (type: (typeof CONTENT_TYPES)[number]["value"]) => new Set(run({}, type).map((f) => f.ruleId.split(".").slice(0, 2).join(".")));
    for (const videoOnly of ["layout.on_screen_time", "accessibility.captions", "image.audio"]) {
      expect(ids("reel_short").has(videoOnly), videoOnly).toBe(true);
      expect(ids("youtube_video").has(videoOnly), videoOnly).toBe(true);
      expect(ids("design_poster").has(videoOnly), videoOnly).toBe(false);
      expect(ids("social_post").has(videoOnly), videoOnly).toBe(false);
    }
  });
});

describe("Platform / Size safe zone with text positions", () => {
  const stories = {
    platform: "instagram",
    placement: "stories_image",
    custom: null,
    files: [{ id: "f1", fileName: "story.png", format: "png" as const, size: 500_000, media: { unit: "px" as const, width: 1440, height: 2560 } }],
  };
  const safe = (box: { x: number; y: number; w: number; h: number }) =>
    run({ platform: stories, detections: detections({ texts: [text("Book now", { box })] }) }).find((f) => f.ruleId === "platform.safe_zone")!;

  it("text inside the safe area passes; in the top 14% / bottom 35% / side 6% it fails", () => {
    expect(safe({ x: 0.1, y: 0.3, w: 0.8, h: 0.1 }).status).toBe("passed");
    expect(safe({ x: 0.1, y: 0.14, w: 0.8, h: 0.51 }).status).toBe("passed"); // exactly on both edges
    expect(safe({ x: 0.1, y: 0.13, w: 0.8, h: 0.1 })).toMatchObject({ status: "failed", severity: "minor", detected: 'In the unsafe area: "Book now"' });
    expect(safe({ x: 0.1, y: 0.6, w: 0.8, h: 0.1 }).status).toBe("failed");
    expect(safe({ x: 0.05, y: 0.3, w: 0.5, h: 0.1 }).status).toBe("failed");
  });

  it("still not verified with no content analysis (the live app until Phase 6)", () => {
    expect(run({ platform: stories }).find((f) => f.ruleId === "platform.safe_zone")!.status).toBe("unverified");
  });
});

/**
 * Freeze review — what Phase 5 hands to the result logic.
 *
 * PASS / NEEDS REVISION / FAIL is NOT built yet: it is plan task 7.4 and the
 * thresholds wait on decision D7. These tests pin down the INPUT it will
 * read: only FAILED findings count, at their severity; passed, unverified
 * and not-applicable findings never count, whatever severity they carry.
 * `planRule` below is the plan's proposed rule (Phase 7), written here only
 * as a test oracle — it is not application code.
 */
function planRule(findings: Finding[]): "PASS" | "NEEDS REVISION" | "FAIL" {
  const issues = findings.filter((f) => f.status === "failed");
  if (issues.some((f) => f.severity === "critical")) return "FAIL";
  if (issues.some((f) => f.severity === "major" || f.severity === "minor")) return "NEEDS REVISION";
  return "PASS";
}

describe("findings feed the PASS / NEEDS REVISION / FAIL rule correctly", () => {
  const clean = (over: { texts?: ReturnType<typeof text>[]; focalX?: number; fonts?: string[]; price?: string } = {}) =>
    run(
      {
        company: company({ goldenRules: [golden({ category: "approved_cta", approved_value: "Book now" })] }),
        requirements: [requirement("price", "AED 1,299")],
        platform: {
          platform: "instagram",
          placement: "feed_image",
          custom: null,
          files: [{ id: "f1", fileName: "post.png", format: "png", size: 500_000, media: { unit: "px", width: 1440, height: 1800 } }],
        },
        detections: detections({
          frame: { width: 1440, height: 1800 },
          texts: [
            text(`Skybook Villas — from ${over.price ?? "AED 1,299"}`, { role: "headline", fontSizePx: 90, color: "#1A64B4", background: "#ffffff", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 } }),
            text("Book now", { role: "cta", fontSizePx: 50, color: "#ffffff", background: "#1A64B4", box: { x: 0.1, y: 0.8, w: 0.3, h: 0.06 } }),
            ...(over.texts ?? []),
          ],
          colors: [{ hex: "#1A64B4", share: 0.3 }, { hex: "#ffffff", share: 0.6 }],
          fonts: (over.fonts ?? ["Montserrat"]).map((family) => ({ family, confidence: 0.95 })),
          logo: { present: true, matchesCompanyLogo: true, confidence: 0.95 },
          focalPoint: { x: over.focalX ?? 0.33, y: 0.66, confidence: 0.9 },
          imageIssues: [],
          colorOnlyMeaning: { present: false, confidence: 0.9 },
        }),
      },
      "social_post"
    );
  const failed = (findings: Finding[]) => findings.filter((f) => f.status === "failed").map((f) => f.severity).sort();

  it("clean content → PASS", () => {
    expect(failed(clean())).toEqual([]);
    expect(planRule(clean())).toBe("PASS");
  });

  it("suggestions only (subjective checks) → PASS", () => {
    const findings = clean({ focalX: 0.5, texts: [text("Our rooms", { role: "body", fontSizePx: 95, box: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 } })] });
    expect(failed(findings)).toEqual(["suggestion", "suggestion"]); // Rule of Thirds + headline hierarchy
    expect(findings.filter((f) => f.status === "failed").every((f) => f.kind === "judgement")).toBe(true);
    expect(planRule(findings)).toBe("PASS");
  });

  it("a minor issue → NEEDS REVISION", () => {
    const findings = clean({ texts: [text("Book the the best villa", { box: { x: 0.1, y: 0.5, w: 0.8, h: 0.05 } })] });
    expect(failed(findings)).toEqual(["minor"]);
    expect(planRule(findings)).toBe("NEEDS REVISION");
  });

  it("a major issue → NEEDS REVISION", () => {
    const findings = clean({ fonts: ["Montserrat", "Comic Sans"] });
    expect(failed(findings)).toEqual(["major"]);
    expect(planRule(findings)).toBe("NEEDS REVISION");
  });

  it("a critical issue (wrong mandatory price) → FAIL", () => {
    const findings = clean({ price: "AED 1,399" });
    expect(failed(findings)).toContain("critical");
    expect(planRule(findings)).toBe("FAIL");
  });

  it("critical + suggestions → FAIL", () => {
    const findings = clean({ price: "AED 1,399", focalX: 0.5 });
    expect(failed(findings)).toEqual(expect.arrayContaining(["critical", "suggestion"]));
    expect(planRule(findings)).toBe("FAIL");
  });

  it("not verified only (today's live app) → nothing counts, even findings that carry CRITICAL severity", () => {
    const findings = run({
      company: company({ goldenRules: [golden({ category: "approved_cta", approved_value: "Book now" })] }),
      requirements: [requirement("price", "AED 1,299")],
    });
    const unverifiedCritical = findings.filter((f) => f.status === "unverified" && f.severity === "critical");
    expect(unverifiedCritical.length).toBeGreaterThan(0); // the severity it WOULD have…
    expect(failed(findings)).toEqual([]); // …but nothing has failed
    expect(planRule(findings)).toBe("PASS"); // (see the D7 note: Phase 7 should say how much was verified)
  });

  it("not applicable only → nothing counts", () => {
    const findings = run({ detections: detections({ texts: [text("Hello")] }) }).filter((f) => f.status === "not_applicable");
    expect(findings.length).toBeGreaterThan(0);
    expect(failed(findings)).toEqual([]);
    expect(planRule(findings)).toBe("PASS");
  });
});
