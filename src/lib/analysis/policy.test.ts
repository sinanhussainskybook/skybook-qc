import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, HUMAN_CHECK, HUMAN_CHECK_CRITICAL, isHumanCheck, isRegistered, LOCAL_AI_SAW_NO_PROBLEM, PARTLY_ANALYSED, PARTLY_HEARD } from "@/lib/analysis/policy";
import { LOCAL_UNCONFIRMED_CAP } from "@/lib/analysis/validate";
import type { ContentDetections } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import { NEEDS_ANALYSIS } from "@/lib/qc/rules/context";
import { company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/** Plan 6.9 — the locked confidence policy, at its exact boundaries. */
describe("confidence policy", () => {
  const counting = (fs: Finding[]) => fs.filter((f) => f.status === "failed");
  const policy = (d: ContentDetections, over: Parameters<typeof run>[0] = {}, type?: Parameters<typeof run>[1]) =>
    applyConfidencePolicy(run({ detections: d, ...over }, type), d, { state: "done" });
  const byId = (fs: Finding[], id: string) => fs.find((f) => f.ruleId === id)!;

  describe("measured text (OCR)", () => {
    const wrongPrice = (confidence: number, mandatory = true) =>
      byId(policy(detections({ texts: [text("Now AED 1,399", { confidence })], textCoverage: 0.95 }), { requirements: [requirement("price", "AED 1,299", { mandatory })] }), "brief.requirement.price");

    it("a CRITICAL from OCR counts at ≥ 0.90; below it becomes a human check (possible critical)", () => {
      expect(wrongPrice(0.97)).toMatchObject({ status: "failed", severity: "critical" });
      expect(wrongPrice(0.9)).toMatchObject({ status: "failed", severity: "critical" });
      const unsure = wrongPrice(0.899);
      expect(unsure).toMatchObject({ status: "unverified", severity: "critical", detected: "AED 1,399", expected: "AED 1,299" });
      expect(unsure.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    });

    it("an ordinary (MAJOR) OCR finding counts at ≥ 0.80", () => {
      expect(wrongPrice(0.8, false)).toMatchObject({ status: "failed", severity: "major" });
      const unsure = wrongPrice(0.79, false);
      expect(unsure.status).toBe("unverified");
      expect(unsure.explanation.startsWith(`${HUMAN_CHECK}:`)).toBe(true);
    });

    it("missing text also needs text coverage ≥ 0.90", () => {
      const missing = (textCoverage: number) =>
        byId(policy(detections({ texts: [text("Summer sale", { confidence: 0.99 })], textCoverage }), { requirements: [requirement("offer", "Free transfer")] }), "brief.requirement.offer");
      expect(missing(0.9)).toMatchObject({ status: "failed", severity: "critical" });
      expect(missing(0.89)).toMatchObject({ status: "unverified" });
      expect(missing(0.89).explanation).toMatch(/may be there/);
    });

    it("a missing or misworded Golden Rule disclaimer is an absence too", () => {
      const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "T&Cs apply" })] });
      const f = (textCoverage: number) => byId(policy(detections({ texts: [text("Hello", { confidence: 0.99 })], textCoverage }), { company: c }), "golden_rules.rule.mandatory_disclaimer");
      expect(f(0.95).status).toBe("failed");
      expect(f(0.5).status).toBe("unverified");
    });

    it("wrong contact details from OCR count; the same heard only in speech is AI evidence → human check", () => {
      const screen = policy(detections({ texts: [text("Call +971 4 999 0000", { confidence: 0.98 })], textCoverage: 0.98 }));
      expect(screen.find((f) => f.ruleId === "content.contact_details.phone" && f.severity === "critical")?.status).toBe("failed");
      const spoken = policy(
        detections({ texts: [], speech: [{ text: "call +971 4 999 0000", startMs: 0, endMs: 1000, confidence: 0.9 }], textCoverage: 1 }),
        {},
        "reel_short"
      );
      const heard = spoken.find((f) => f.ruleId === "content.contact_details.phone")!;
      expect(heard.status).toBe("unverified");
      expect(heard.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    });
  });

  describe("AI-judged", () => {
    it("can never create a counting CRITICAL: a logo mismatch becomes 'possible critical' even when clear", () => {
      const f = byId(policy(detections({ logo: { present: true, matchesCompanyLogo: false, confidence: 0.9 } })), "brand.logo");
      expect(f).toMatchObject({ status: "unverified", severity: "critical" });
      expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    });

    it("MAJOR / MINOR count only when the model was clear", () => {
      const font = (confidence: number) => byId(policy(detections({ fonts: [{ family: "Comic Sans", confidence }] })), "brand.fonts");
      expect(font(0.9)).toMatchObject({ status: "failed", severity: "major" });
      expect(font(0.7)).toMatchObject({ status: "unverified" });
      const issue = byId(policy(detections({ imageIssues: [{ issue: "watermark", confidence: 0.9 }] })), "image.quality.watermark");
      expect(issue.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    });

    it("a different CTA (found by role) is AI evidence", () => {
      const fs = policy(detections({ texts: [text("Learn more", { role: "cta", confidence: 0.99 })], textCoverage: 1 }), { requirements: [requirement("cta", "Book now")] });
      expect(byId(fs, "brief.requirement.cta").status).toBe("unverified");
    });
  });

  it("measured pixels and geometry count (contrast)", () => {
    const f = policy(detections({ texts: [text("Offer", { color: "#777777", background: "#ffffff", fontSizePx: 20, confidence: 0.95 })], textCoverage: 1 }));
    expect(byId(f, "accessibility.contrast")).toMatchObject({ status: "failed", severity: "major" });
  });

  it("suggestions are untouched and never become checks", () => {
    const f = byId(policy(detections({ focalPoint: { x: 0.5, y: 0.5, confidence: 0.4 } })), "layout.rule_of_thirds");
    expect(f).toMatchObject({ status: "failed", severity: "suggestion" });
  });

  it("no detections: the 'not verified' wording follows the analysis state", () => {
    const base = run({ requirements: [requirement("price", "AED 1,299")] });
    expect(base.some((f) => f.explanation === NEEDS_ANALYSIS)).toBe(true);
    const failed = applyConfidencePolicy(base, null, { state: "failed", reason: "the text reader timed out" });
    expect(failed.some((f) => f.explanation.includes("the text reader timed out"))).toBe(true);
    expect(failed.some((f) => f.explanation === NEEDS_ANALYSIS)).toBe(false);
    const pending = applyConfidencePolicy(base, null, { state: "pending" });
    expect(pending.some((f) => f.explanation.startsWith("The content is being analysed"))).toBe(true);
    expect(counting(failed).filter((f) => f.category !== "platform_size")).toEqual([]);
  });

  it("every rule the engine can produce is in the evidence register", () => {
    const rich = detections({
      texts: [text("Call +971 4 999 0000 lorem ipsum the the cheap", { role: "cta", color: "#E63946", background: "#fff", fontSizePx: 5, box: { x: 0, y: 0, w: 0.5, h: 0.5 }, startMs: 0, endMs: 100 })],
      speech: [{ text: "hello", startMs: 0, endMs: 2000, confidence: 0.9 }],
      colors: [{ hex: "#E63946", share: 0.5 }],
      fonts: [{ family: "Arial", confidence: 0.9 }],
      logo: { present: false, confidence: 0.9 },
      focalPoint: { x: 0.5, y: 0.5, confidence: 0.9 },
      imageIssues: [{ issue: "blurry", confidence: 0.9 }],
      colorOnlyMeaning: { present: true, confidence: 0.9 },
      audio: { hasAudio: true, integratedLufs: -30, peakDbfs: 0, confidence: 1 },
      textCoverage: 1,
    });
    const c = company({
      goldenRules: ["mandatory_disclaimer", "approved_product_name", "approved_cta", "approved_color", "approved_font", "logo_rule", "other"].map((category) =>
        golden({ category: category as never, approved_value: category === "approved_color" ? "#1A64B4" : "X" })
      ),
      brand: { ...company().brand, tone: "Warm" },
    });
    const ids = new Set<string>();
    for (const type of ["social_post", "reel_short"] as const) {
      for (const f of run({ detections: rich, company: c, requirements: [requirement("price", "AED 1"), requirement("disclaimer", "x"), requirement("other", "y")] }, type)) ids.add(f.ruleId);
    }
    const missing = [...ids].filter((id) => !isRegistered(id));
    expect(missing).toEqual([]);
    expect(ids.size).toBeGreaterThan(30);
  });

  it("isHumanCheck recognises converted findings", () => {
    const f = byId(policy(detections({ fonts: [{ family: "Comic Sans", confidence: 0.4 }] })), "brand.fonts");
    expect(isHumanCheck(f)).toBe(true);
  });
});

/** Found in the browser check: a pass must not claim more than was analysed. */
describe("passes need the content to have been analysed", () => {
  const ids = (fs: Finding[]) => Object.fromEntries(fs.map((f) => [f.ruleId, f.status]));
  const clean = (textCoverage: number) =>
    detections({
      texts: [text("Book now", { role: "cta", color: "#000000", background: "#ffffff", fontSizePx: 60, box: { x: 0.2, y: 0.8, w: 0.3, h: 0.05 }, confidence: 0.97 })],
      textCoverage,
    });
  const policyAt = (textCoverage: number, analysis: Parameters<typeof applyConfidencePolicy>[2] = { state: "done" }) => {
    const d = clean(textCoverage);
    return applyConfidencePolicy(run({ detections: d, requirements: [requirement("cta", "Book now")] }), d, analysis);
  };

  it("coverage ≥ 0.90: whole-content passes stand", () => {
    const s = ids(policyAt(0.9));
    expect(s["content.placeholder"]).toBe("passed");
    expect(s["layout.text_overlap"]).toBe("passed");
    expect(s["accessibility.contrast"]).toBe("passed");
  });

  it("coverage < 0.90 (e.g. 2 of 3 images failed): 'nothing wrong found' becomes NOT VERIFIED; 'it was found' and file measurements stay", () => {
    const fs = policyAt(0.317);
    const s = ids(fs);
    for (const id of ["content.placeholder", "content.repeated_word", "layout.text_overlap", "layout.edge_margin", "accessibility.contrast", "accessibility.text_size", "brief.unexpected"]) {
      expect([id, s[id]]).toEqual([id, "unverified"]);
    }
    expect(s["brief.requirement.cta"]).toBe("passed"); // the CTA was seen — it is there
    expect(fs.filter((f) => f.ruleId.startsWith("platform")).every((f) => f.status !== "unverified" || f.explanation !== PARTLY_ANALYSED)).toBe(true);
    expect(fs.find((f) => f.ruleId === "content.placeholder")!.explanation).toBe(PARTLY_ANALYSED);
    expect(fs.filter((f) => f.status === "passed").every((f) => f.ruleId.startsWith("platform") || f.ruleId.startsWith("brief.requirement"))).toBe(true);
  });

  it("video longer than the analysed 15 minutes: a sound-level pass becomes NOT VERIFIED; a fault found stays", () => {
    const d = detections({ texts: [], textCoverage: 1, audio: { hasAudio: true, integratedLufs: -16, peakDbfs: -3, confidence: 1 } });
    const at = (analysedShare?: number) =>
      applyConfidencePolicy(run({ detections: d }, "reel_short"), d, analysedShare === undefined ? { state: "done" } : { state: "done", analysedShare }).filter((f) => f.ruleId.startsWith("image.audio"));
    expect(at().length).toBeGreaterThan(0);
    expect(at().every((f) => f.status === "passed")).toBe(true);
    expect(at(0.5).every((f) => f.status === "unverified" && f.explanation === PARTLY_HEARD)).toBe(true);
    const loud = detections({ texts: [], textCoverage: 1, audio: { hasAudio: true, integratedLufs: -5, peakDbfs: 0.5, confidence: 1 } });
    const faults = applyConfidencePolicy(run({ detections: loud }, "reel_short"), loud, { state: "done", analysedShare: 0.5 }).filter((f) => f.ruleId.startsWith("image.audio"));
    expect(faults.some((f) => f.status === "failed")).toBe(true);
  });
});

/** Local provider rules (2026-10-06 trial) — scoped to "local"; Google / mock unchanged. */
describe("local provider safety rules", () => {
  const byId = (fs: Finding[], id: string) => fs.find((f) => f.ruleId === id)!;
  const at = (provider: "local" | "google", d: ContentDetections, over: Parameters<typeof run>[0] = {}, type?: Parameters<typeof run>[1]) =>
    applyConfidencePolicy(run({ detections: d, ...over }, type), d, { state: "done" }, { provider });
  const wrongPrice = (provider: "local" | "google", confidence: number) =>
    byId(at(provider, detections({ texts: [text("Now AED 1,399", { confidence })], textCoverage: 0.95 }), { requirements: [requirement("price", "AED 1,299")] }), "brief.requirement.price");

  it("a text CRITICAL from local OCR needs ≥ 0.95 (a second read must agree); Google's 0.90 bar is unchanged", () => {
    expect(wrongPrice("local", 0.95)).toMatchObject({ status: "failed", severity: "critical" });
    const unsure = wrongPrice("local", 0.949);
    expect(unsure).toMatchObject({ status: "unverified", severity: "critical" });
    expect(unsure.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(wrongPrice("local", 0.89).status).toBe("unverified"); // the cap for an unconfirmed local reading
    expect(wrongPrice("google", 0.92)).toMatchObject({ status: "failed", severity: "critical" });
  });

  it("text the second read didn't confirm (≤ 0.89) never counts locally, at any severity", () => {
    const misread = (provider: "local" | "google", confidence: number) =>
      byId(at(provider, detections({ texts: [text("Istand Hopping", { role: "headline", confidence })], textCoverage: 0.95 }), { requirements: [requirement("headline", "Island Hopping", { mandatory: false })] }), "brief.requirement.headline");
    const local = misread("local", LOCAL_UNCONFIRMED_CAP);
    expect(local.status).toBe("unverified");
    expect(local.explanation).toMatch(/^Needs a human check: the local text reader's two reads of this text didn't agree/);
    expect(misread("local", 0.97).status).toBe("failed"); // confirmed by both reads → counts
    expect(misread("google", 0.89).status).toBe("failed"); // Google unchanged
  });

  it("missing text is never a local CRITICAL (the detector can miss lines) — even at full coverage", () => {
    const missing = (provider: "local" | "google") =>
      byId(at(provider, detections({ texts: [text("Summer sale", { confidence: 0.99 })], textCoverage: 1 }), { requirements: [requirement("offer", "Free transfer")] }), "brief.requirement.offer");
    const local = missing("local");
    expect(local).toMatchObject({ status: "unverified", severity: "critical" });
    expect(local.explanation).toMatch(/^Needs a human check — possible critical issue: the local text reader can't confirm/);
    expect(missing("google")).toMatchObject({ status: "failed", severity: "critical" });
    // A local MAJOR "missing" still counts at full coverage.
    const optional = byId(at("local", detections({ texts: [text("Summer sale", { confidence: 0.99 })], textCoverage: 1 }), { requirements: [requirement("offer", "Free transfer", { mandatory: false })] }), "brief.requirement.offer");
    expect(optional.status).toBe("failed");
  });

  it("an AI 'no problem found' pass is NOT VERIFIED for local; Google keeps the pass", () => {
    const d = detections({ texts: [text("Book now", { role: "cta", confidence: 0.97 })], imageIssues: [], colorOnlyMeaning: { present: false, confidence: 0.9 }, textCoverage: 1 });
    const local = byId(at("local", d), "image.quality");
    expect(local).toMatchObject({ status: "unverified", explanation: LOCAL_AI_SAW_NO_PROBLEM });
    expect(byId(at("local", d), "accessibility.color_only").status).toBe("unverified");
    expect(byId(at("google", d), "image.quality").status).toBe("passed");
  });

  it("AI-only evidence still never makes a counting CRITICAL; partial analysis stays not verified", () => {
    const wrongLogo = detections({ logo: { present: true, matchesCompanyLogo: false, confidence: 0.9 }, textCoverage: 1 });
    const logo = at("local", wrongLogo).find((f) => f.ruleId.startsWith("brand.logo") && f.severity === "critical");
    expect(logo).toBeDefined();
    expect(logo!.status).toBe("unverified");
    expect(logo!.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    const partial = byId(at("local", detections({ texts: [text("Hello", { confidence: 0.99 })], textCoverage: 0.3 })), "content.placeholder");
    expect(partial.explanation).toBe(PARTLY_ANALYSED);
  });
});

/** An exact size in the brief is the file's own measurement: it counts whoever read the text. */
describe("exact dimensions from the brief", () => {
  const sized = (provider: "gemini" | "local" | "google" | "mock", width: number) => {
    const d = detections({ texts: [text("Book now", { confidence: 0.6 })], textCoverage: 0.95 });
    const files = [{ id: "f1", fileName: "post.jpg", format: "jpeg" as const, size: 1, media: { unit: "px" as const, width, height: width } }];
    const findings = applyConfidencePolicy(
      run({ detections: d, requirements: [requirement("dimensions", "1080 × 1080")], platform: { platform: null, placement: null, custom: null, files } }),
      d,
      { state: "done" },
      { provider }
    );
    return findings.find((f) => f.ruleId === "brief.requirement.dimensions")!;
  };

  it("is measured, not AI: a mismatch counts and a match passes — Gemini included", () => {
    expect(isRegistered("brief.requirement.dimensions")).toBe(true);
    for (const provider of ["gemini", "local", "google", "mock"] as const) {
      expect(sized(provider, 1254), provider).toMatchObject({ status: "failed", severity: "major", detected: "1254 × 1254 px" });
      expect(sized(provider, 1080), provider).toMatchObject({ status: "passed" });
    }
  });
});
