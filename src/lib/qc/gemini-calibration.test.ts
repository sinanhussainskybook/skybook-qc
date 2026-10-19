import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, GEMINI_DIDNT_LIST, GEMINI_ESTIMATE, HUMAN_CHECK, HUMAN_CHECK_CRITICAL, isHumanCheck } from "@/lib/analysis/policy";
import { assembleDetections } from "@/lib/analysis/assemble";
import { consolidateFindings } from "@/lib/qc/consolidate";
import { roleBasedConfidence, type ContentDetections, type DetectedText } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import { CONTRAST_CLEAR_CUT } from "@/lib/qc/rules/accessibility";
import { BRAND_COLOR_TOLERANCE, TEXT_COLOR_CLEAR_CUT } from "@/lib/qc/rules/brand";
import type { QcContext } from "@/lib/qc/rules/context";
import { resultDisplay, scoreFindings } from "@/lib/qc/scoring";
import { company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 4 — Gemini accuracy calibration. Gemini reads the text AND gives its positions, approximately; it
 * says how sure it is of each line it returns, but nothing about lines it skipped. So, with Gemini only:
 *   1. "not found" isn't proof — a person checks it (a mandatory one stays a possible critical issue);
 *   2. contrast and text colour measured inside its approximate boxes count only when clear-cut;
 *   3. a wrong headline / CTA is only as sure as the AI's reading of which text that is.
 * Other providers are unchanged.
 */

type Provider = "gemini" | "google" | "local" | "mock";
const policy = (over: Partial<QcContext>, provider: Provider) => {
  const d = (over.detections ?? null) as ContentDetections | null;
  return applyConfidencePolicy(run(over), d, { state: "done" }, { provider });
};
/** What the app does: rules → policy → consolidate. */
const results = (over: Partial<QcContext>, provider: Provider) => consolidateFindings(policy(over, provider));
const clear = (t: string, over: Partial<DetectedText> = {}) => text(t, { confidence: 0.9, ...over }); // Gemini "clear"
const design = (texts: DetectedText[], over: Partial<ContentDetections> = {}) => detections({ texts, textCoverage: 0.9, frame: { width: 1080, height: 1080 }, ...over });
const one = (fs: Finding[], prefix: string) => fs.filter((f) => f.ruleId === prefix || f.ruleId.startsWith(`${prefix}.`));

describe("1. Gemini 'not found' is never counted as missing", () => {
  it("an optional brief item Gemini didn't list → a human check (it may be there), not a counted issue", () => {
    const [f] = one(policy({ requirements: [requirement("offer", "Free airport transfer", { mandatory: false })], detections: design([clear("Summer sale")]) }, "gemini"), "brief.requirement");
    expect(f).toMatchObject({ status: "unverified", severity: "minor" });
    expect(isHumanCheck(f)).toBe(true);
    expect(f.explanation).toContain(GEMINI_DIDNT_LIST);
  });

  it("a mandatory one stays a possible critical issue → CHECK BEFORE SENDING", () => {
    const fs = policy({ requirements: [requirement("offer", "Free airport transfer", { mandatory: true })], detections: design([clear("Summer sale")]) }, "gemini");
    const [f] = one(fs, "brief.requirement");
    expect(f).toMatchObject({ status: "unverified", severity: "critical" });
    expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(resultDisplay(scoreFindings(fs))).toBe("check_before_sending");
  });

  it("the same for a brief disclaimer and a company disclaimer Golden Rule", () => {
    const legal = one(policy({ requirements: [requirement("disclaimer", "T&C apply", { mandatory: false })], detections: design([clear("Book now")]) }, "gemini"), "legal.disclaimer")[0];
    expect(isHumanCheck(legal)).toBe(true);
    const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "T&C apply", mandatory: false })] });
    const rule = one(policy({ company: c, detections: design([clear("Book now")]) }, "gemini"), "golden_rules")[0];
    expect(isHumanCheck(rule)).toBe(true);
  });

  it("a value Gemini DID read and that's wrong still counts when it was clear (not an absence)", () => {
    const [f] = one(policy({ requirements: [requirement("price", "AED 1,299", { mandatory: false })], detections: design([clear("Now AED 1,499")]) }, "gemini"), "brief.requirement");
    expect(f).toMatchObject({ status: "failed", severity: "major", detected: "AED 1,499" });
  });

  it("other providers are unchanged: with real OCR coverage, an optional missing item still counts", () => {
    for (const provider of ["google", "mock"] as const) {
      const [f] = one(policy({ requirements: [requirement("offer", "Free airport transfer", { mandatory: false })], detections: design([text("Summer sale", { confidence: 0.97 })], { textCoverage: 0.95 }) }, provider), "brief.requirement");
      expect([provider, f.status]).toEqual([provider, "failed"]);
    }
  });
});

describe("2. contrast and text colour from Gemini's approximate boxes count only when clear-cut", () => {
  // Normal-size text (25px in 1080 — under 3 % of it): 4.5 : 1 needed; clear-cut below 60 % of it (2.7 : 1).
  const contrast = (color: string, background: string, provider: Provider = "gemini", fontSizePx = 25) =>
    one(policy({ detections: design([clear("Summer offer", { color, background, fontSizePx, box: { x: 0.2, y: 0.4, w: 0.5, h: 0.05 } })]) }, provider), "accessibility.contrast")[0];

  it("the threshold is the approved 60 % of the required ratio", () => {
    expect(CONTRAST_CLEAR_CUT).toBe(0.6);
  });

  it("clearly unreadable (≈1.2 : 1) still counts", () => {
    const f = contrast("#EEEEEE", "#FFFFFF");
    expect(f).toMatchObject({ status: "failed", severity: "major", estimate: { limit: 4.5, clearCut: true } });
  });

  it("near the limit (≈4.5 : 1, just under) → a human check, estimated from an approximate position", () => {
    const f = contrast("#777777", "#FFFFFF");
    expect(f.estimate).toMatchObject({ limit: 4.5, clearCut: false });
    expect(f.estimate!.value).toBeGreaterThan(2.7);
    expect(f.status).toBe("unverified");
    expect(f.explanation).toContain(GEMINI_ESTIMATE);
  });

  it("large text (3 : 1 needed): ≈2.8 : 1 is a human check, ≈1.6 : 1 counts", () => {
    // 60px text in 1080 is large (≥ 3 %): clear-cut below 1.8 : 1.
    expect(contrast("#999999", "#FFFFFF", "gemini", 60)).toMatchObject({ status: "unverified", estimate: { limit: 3, clearCut: false } });
    expect(contrast("#CCCCCC", "#FFFFFF", "gemini", 60)).toMatchObject({ status: "failed", estimate: { limit: 3, clearCut: true } });
  });

  it("other providers are unchanged: a borderline (≈4.5 : 1) reading by OCR still counts", () => {
    for (const provider of ["google", "local", "mock"] as const) {
      expect([provider, contrast("#777777", "#FFFFFF", provider).status]).toEqual([provider, "failed"]);
    }
  });

  it("text colour: far off-brand counts; just past the tolerance is a human check (approved: 2× the tolerance)", () => {
    expect(TEXT_COLOR_CLEAR_CUT * BRAND_COLOR_TOLERANCE).toBe(20);
    const colour = (hex: string, provider: Provider = "gemini") =>
      // The brand colours check runs once the design's colours were measured.
      one(policy({ detections: design([clear("Summer offer", { color: hex, box: { x: 0.2, y: 0.4, w: 0.5, h: 0.05 } })], { colors: [{ hex: "#1A64B4", share: 0.5 }] }) }, provider), "brand.colors.text")[0];
    // Brand palette: #1A64B4 and #F4B400.
    expect(colour("#E0115F")).toMatchObject({ status: "failed", severity: "minor", estimate: { clearCut: true } }); // raspberry: far from both
    const near = colour("#1E7AC4"); // a blue just past the tolerance (ΔE ≈ 10.8) from #1A64B4
    expect(near.estimate!.value).toBeGreaterThan(BRAND_COLOR_TOLERANCE);
    expect(near.estimate!.value).toBeLessThanOrEqual(2 * BRAND_COLOR_TOLERANCE);
    expect(near).toMatchObject({ status: "unverified", estimate: { clearCut: false } });
    expect(colour("#1E7AC4", "google").status).toBe("failed"); // other providers unchanged
  });
});

describe("3. a wrong headline / CTA is only as sure as the AI's reading of which text it is", () => {
  const cta = (t: Partial<DetectedText>, mandatory = false, provider: Provider = "gemini") =>
    one(policy({ requirements: [requirement("cta", "Book now", { mandatory })], detections: design([text("Buy today", { role: "cta", ...t })]) }, provider), "brief.requirement")[0];

  it("the finding carries the least sure of the text and its role (no longer 'certain' by default)", () => {
    const [f] = one(run({ requirements: [requirement("cta", "Book now", { mandatory: false })], detections: design([text("Buy today", { role: "cta", confidence: 0.95, roleConfidence: 0.7 })]) }), "brief.requirement");
    expect(f).toMatchObject({ status: "failed", confidence: 0.7 });
    expect(roleBasedConfidence([text("a", { confidence: 0.9 }), text("b", { confidence: 0.95, roleConfidence: 0.4 })])).toBe(0.4);
    expect(roleBasedConfidence([text("a", { confidence: 0.8 })])).toBe(0.8); // no role certainty: the text's own
  });

  it("Gemini 'likely' (0.7) → a human check; 'clear' (0.9) → counts; mandatory → a possible critical issue", () => {
    expect(isHumanCheck(cta({ confidence: 0.7, roleConfidence: 0.7 }))).toBe(true);
    expect(cta({ confidence: 0.9, roleConfidence: 0.9 })).toMatchObject({ status: "failed", severity: "major" });
    const mandatory = cta({ confidence: 0.9, roleConfidence: 0.9 }, true);
    expect(mandatory).toMatchObject({ status: "unverified", severity: "critical" });
    expect(mandatory.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
  });

  it("an OCR provider: a confidently read text whose CTA role was only 'likely' → a human check", () => {
    const f = cta({ confidence: 0.97, roleConfidence: 0.7 }, false, "google");
    expect(f.status).toBe("unverified");
    expect(f.explanation.startsWith(`${HUMAN_CHECK}:`)).toBe(true);
    expect(cta({ confidence: 0.97, roleConfidence: 0.9 }, false, "google").status).toBe("failed");
  });

  it("a wrong headline, and the Golden Rule CTA, follow the same rule", () => {
    const headline = one(policy({ requirements: [requirement("headline", "Summer Escape", { mandatory: false })], detections: design([text("Winter Deals", { role: "headline", confidence: 0.9, roleConfidence: 0.7 })]) }, "gemini"), "brief.requirement")[0];
    expect(headline).toMatchObject({ status: "unverified", detected: "Winter Deals" });
    const c = company({ goldenRules: [golden({ category: "approved_cta", approved_value: "Book now", mandatory: false })] });
    const rule = one(policy({ company: c, detections: design([text("Buy today", { role: "cta", confidence: 0.95, roleConfidence: 0.7 })]) }, "google"), "golden_rules")[0];
    expect(rule).toMatchObject({ status: "unverified", confidence: 0.7 });
  });

  it("assemble keeps the role's certainty from the AI's labels", () => {
    const d = assembleDetections({
      provider: "google",
      frames: [
        {
          fileId: "f1",
          frame: { width: 1000, height: 1000 },
          ocr: { width: 1000, height: 1000, pageConfidence: 0.95, blocks: [{ id: "b1", text: "Buy today", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 }, heightPx: 40, confidence: 0.97 }] },
          judgement: { blocks: [{ id: "b1", role: "cta", fontFamily: null, bold: null, certainty: "likely" }], fonts: [], logo: { present: false, matchesCompanyLogo: null, box: null, certainty: "clear" }, focalPoint: null, imageIssues: [], colorOnlyMeaning: { present: false, certainty: "clear", note: "" } },
          colours: null,
        },
      ],
      analysedShare: 1,
      hasCompanyLogo: false,
    });
    expect(d.texts![0]).toMatchObject({ role: "cta", roleConfidence: 0.7, confidence: 0.97 });
  });
});

describe("counted and human-verification findings stay separate (Stage 2 grouping)", () => {
  it("contrast on four labels with Gemini: clear-cut ones are ONE counted issue, borderline ones ONE item to verify", () => {
    const label = (t: string, color: string, y: number) => clear(t, { fileId: "f1", color, background: "#FFFFFF", fontSizePx: 25, box: { x: 0.2, y, w: 0.4, h: 0.05 } });
    const fs = results({ detections: design([label("One", "#EEEEEE", 0.1), label("Two", "#F0F0F0", 0.3), label("Three", "#777777", 0.5), label("Four", "#7A7A7A", 0.7)]) }, "gemini");
    const contrast = one(fs, "accessibility.contrast");
    const counted = contrast.filter((f) => f.status === "failed");
    const toVerify = contrast.filter(isHumanCheck);
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ occurrences: 2 });
    expect(toVerify).toHaveLength(1);
    expect(toVerify[0]).toMatchObject({ occurrences: 2 });
    const board = scoreFindings(fs);
    expect(board.issues.major).toBe(1); // only the clear-cut issue counts
    expect(board.counting.every((f) => f.status === "failed")).toBe(true);
  });

  it("result logic is unchanged: borderline estimates alone give PASS — PLEASE VERIFY, a clear-cut one NEEDS REVISION", () => {
    const only = (color: string) => resultDisplay(scoreFindings(results({ requirements: [requirement("headline", "Summer offer", { mandatory: false })], detections: design([clear("Summer offer", { role: "headline", roleConfidence: 0.9, color, background: "#FFFFFF", fontSizePx: 25, box: { x: 0.2, y: 0.4, w: 0.5, h: 0.05 } })]) }, "gemini")));
    expect(only("#777777")).toBe("pass_human_check");
    expect(only("#EEEEEE")).toBe("needs_revision");
  });
});

describe("Stage 4 review: a company disclaimer Golden Rule reports what it read", () => {
  const disclaimer = (shown: DetectedText[], mandatory: boolean, provider: Provider) => {
    const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "T&C apply", mandatory })] });
    return one(policy({ company: c, detections: design(shown, provider === "gemini" ? {} : { textCoverage: 0.95 }) }, provider), "golden_rules")[0];
  };

  it("Gemini read a near-match clearly ('T&C appy', a letter missing): a counted issue naming the words read — not 'didn't list'", () => {
    const f = disclaimer([clear("Book now. T&C appy")], false, "gemini");
    expect(f).toMatchObject({ status: "failed", severity: "major", detected: "t and c appy" });
    expect(f.explanation).toMatch(/not word for word/);
    expect(f.explanation).not.toContain(GEMINI_DIDNT_LIST);
  });

  it("Gemini read it unsurely ('likely') → a human check for being unsure, still naming the words read", () => {
    const f = disclaimer([text("Book now. T&C appy", { confidence: 0.7 })], false, "gemini");
    expect(f).toMatchObject({ status: "unverified", detected: "t and c appy" });
    expect(f.explanation.startsWith(`${HUMAN_CHECK}:`)).toBe(true);
    expect(f.explanation).not.toContain(GEMINI_DIDNT_LIST);
  });

  it("only a true absence becomes 'Gemini didn't list this text'", () => {
    const f = disclaimer([clear("Book now")], false, "gemini");
    expect(f).toMatchObject({ status: "unverified", detected: "Not found" });
    expect(f.explanation).toContain(GEMINI_DIDNT_LIST);
  });

  it("different numbers in it are named as such", () => {
    const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "Offer ends 2026", mandatory: false })] });
    const f = one(policy({ company: c, detections: design([clear("Offer ends 2025")]) }, "gemini"), "golden_rules")[0];
    expect(f).toMatchObject({ status: "failed", detected: "offer ends 2025" });
    expect(f.explanation).toMatch(/different numbers/);
  });

  it("mandatory behaviour is preserved: Gemini → a possible critical issue (CHECK BEFORE SENDING); a clear OCR reading → a counted critical", () => {
    const gemini = disclaimer([clear("Book now. T&C appy")], true, "gemini");
    expect(gemini).toMatchObject({ status: "unverified", severity: "critical" });
    expect(gemini.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "T&C apply", mandatory: true })] });
    expect(resultDisplay(scoreFindings(results({ company: c, requirements: [requirement("headline", "Book now", { mandatory: false })], detections: design([clear("Book now. T&C appy", { role: "headline", roleConfidence: 0.9 })]) }, "gemini")))).toBe("check_before_sending");
    expect(disclaimer([text("Book now. T&C appy", { confidence: 0.97 })], true, "google")).toMatchObject({ status: "failed", severity: "critical", detected: "t and c appy" });
    // A true absence with OCR coverage still counts, as before.
    expect(disclaimer([text("Book now", { confidence: 0.97 })], true, "google")).toMatchObject({ status: "failed", severity: "critical", detected: "Not found" });
  });
});

describe("Stage 4 review: isNeutral is unchanged", () => {
  it("greys, black and white are neutral; brand colours aren't", async () => {
    const { isNeutral, chroma, NEUTRAL_CHROMA } = await import("@/lib/qc/compare");
    for (const grey of ["#000000", "#FFFFFF", "#808080", "#7A7A7A"]) expect([grey, isNeutral(grey)]).toEqual([grey, true]);
    for (const colour of ["#1A64B4", "#F4B400", "#E0115F"]) expect([colour, isNeutral(colour)]).toEqual([colour, false]);
    expect(chroma("#808080")! < NEUTRAL_CHROMA).toBe(true);
  });
});
