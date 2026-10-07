import { describe, expect, it } from "vitest";
import { byRule, company, detections, only, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.5 — Brand QC. */
describe("Brand rules", () => {
  it("colours: a brand colour must be used; boundary at the 2% share", () => {
    const used = byRule(run({ detections: detections({ colors: [{ hex: "#1B65B5", share: 0.02 }, { hex: "#ffffff", share: 0.7 }] }) }), "brand.colors.present");
    expect(used[0].status).toBe("passed");
    const tooSmall = byRule(run({ detections: detections({ colors: [{ hex: "#1A64B4", share: 0.019 }] }) }), "brand.colors.present");
    expect(tooSmall[0]).toMatchObject({ status: "failed", severity: "minor" });
    const none = byRule(run({ detections: detections({ colors: [{ hex: "#E63946", share: 0.5 }] }) }), "brand.colors.present");
    expect(none[0]).toMatchObject({ status: "failed", expected: "At least one of: Skybook Blue #1A64B4, Sun #F4B400" });
  });

  it("text colours: brand or neutral pass; anything else is MINOR", () => {
    const d = detections({
      colors: [{ hex: "#1A64B4", share: 0.3 }],
      texts: [text("Headline", { color: "#1A64B4" }), text("Body", { color: "#222222" }), text("Promo", { color: "#E63946" })],
    });
    const findings = byRule(run({ detections: d }), "brand.colors.text");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "failed", severity: "minor", detected: '#E63946 — "Promo"' });
  });

  it("fonts: off-brand font is MAJOR; low-confidence detection is worded as a judgement", () => {
    expect(only(run({ detections: detections({ fonts: [{ family: "Montserrat Bold", confidence: 0.9 }] }) }), "brand.fonts").status).toBe("passed");
    const wrong = only(run({ detections: detections({ fonts: [{ family: "Comic Sans", confidence: 0.6 }] }) }), "brand.fonts");
    expect(wrong).toMatchObject({ status: "failed", severity: "major", kind: "judgement", confidence: 0.6 });
  });

  it("terms: banned term and misspelt approved term are MAJOR", () => {
    const findings = byRule(run({ detections: detections({ texts: [text("Cheap stays at Skybok Villas")] }) }), "brand.terms");
    expect(findings.map((f) => [f.status, f.severity, f.detected]).sort()).toEqual([
      ["failed", "major", "cheap"],
      ["failed", "major", "skybok villas"],
    ]);
    expect(only(run({ detections: detections({ texts: [text("Great value at Skybook Villas")] }) }), "brand.terms").status).toBe("passed");
  });

  it("logo: missing is MAJOR, a different logo is CRITICAL", () => {
    expect(only(run({ detections: detections({ logo: { present: true, matchesCompanyLogo: true, confidence: 0.9 } }) }), "brand.logo").status).toBe("passed");
    expect(only(run({ detections: detections({ logo: { present: false, confidence: 0.9 } }) }), "brand.logo")).toMatchObject({ status: "failed", severity: "major" });
    expect(only(run({ detections: detections({ logo: { present: true, matchesCompanyLogo: false, confidence: 0.9 } }) }), "brand.logo")).toMatchObject({ status: "failed", severity: "critical" });
  });

  it("missing brand information → NOT VERIFIED, never a guess", () => {
    const empty = company({ logo: null, brand: { ...company().brand, colors: [], fonts: [], terms: [] } });
    const findings = byRule(run({ company: empty, detections: detections({ colors: [], fonts: [], logo: { present: false, confidence: 1 } }) }), "brand");
    expect(findings.map((f) => [f.ruleId, f.status]).sort()).toEqual([
      ["brand.colors", "unverified"],
      ["brand.fonts", "unverified"],
      ["brand.logo", "unverified"],
      ["brand.terms", "unverified"],
    ]);
  });

  it("written guidelines are listed for a person to check", () => {
    const c = company({ brand: { ...company().brand, tone: "Warm and premium", capitalization_rules: "Sentence case headlines" } });
    const findings = byRule(run({ company: c }), "brand.written_guidelines");
    expect(findings.map((f) => [f.title, f.status, f.expected])).toEqual([
      ["Capitalisation", "unverified", "Sentence case headlines"],
      ["Tone of voice", "unverified", "Warm and premium"],
    ]);
  });
});
