import { missingCompanySetting, needsVerifying } from "@/lib/qc/golden-rules-view";
import { describe, expect, it } from "vitest";
import { byRule, company, detections, golden, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.6 — Golden Rules: applied automatically; a mandatory violation is CRITICAL. */
describe("Golden Rules", () => {
  const withRules = (...rules: ReturnType<typeof golden>[]) => company({ goldenRules: rules });
  const one = (rules: ReturnType<typeof golden>[], d = detections()) => {
    const findings = byRule(run({ company: withRules(...rules), detections: d }), "golden_rules");
    expect(findings).toHaveLength(1);
    return findings[0];
  };

  it("every active rule is applied, inactive ones are skipped — automatically, with nothing chosen per session", () => {
    const findings = byRule(
      run({
        company: withRules(
          golden({ category: "approved_cta", approved_value: "Book now" }),
          golden({ category: "approved_color", approved_value: "#1A64B4", active: false })
        ),
        detections: detections({ texts: [text("BOOK NOW →", { role: "cta" })] }),
      }),
      "golden_rules"
    );
    expect(findings.map((f) => [f.ruleId, f.status])).toEqual([["golden_rules.rule.approved_cta", "passed"]]);
  });

  it("a mandatory violation is CRITICAL; the same rule optional is MAJOR", () => {
    const d = detections({ texts: [text("Book today", { role: "cta" })] });
    expect(one([golden({ category: "approved_cta", approved_value: "Book now", mandatory: true })], d)).toMatchObject({ status: "failed", severity: "critical", detected: "Book today" });
    expect(one([golden({ category: "approved_cta", approved_value: "Book now", mandatory: false })], d)).toMatchObject({ status: "failed", severity: "major" });
  });

  it("mandatory disclaimer must appear word for word on screen (speech doesn't count)", () => {
    const rule = golden({ category: "mandatory_disclaimer", approved_value: "Terms and conditions apply." });
    expect(one([rule], detections({ texts: [text("*Terms & conditions apply")] })).status).toBe("failed");
    expect(one([rule], detections({ texts: [text("*Terms and conditions apply")] })).status).toBe("passed");
    expect(one([rule], detections({ texts: [], speech: [{ text: "terms and conditions apply", startMs: 0, endMs: 1, confidence: 1 }] })).status).toBe("failed");
  });

  it("approved product name: misspelt fails, not mentioned is not applicable", () => {
    const rule = golden({ category: "approved_product_name", approved_value: "Palm Residence" });
    expect(one([rule], detections({ texts: [text("New Palm Residence villas")] })).status).toBe("passed");
    expect(one([rule], detections({ texts: [text("New Palm Residense villas")] }))).toMatchObject({ status: "failed", severity: "critical" });
    expect(one([rule], detections({ texts: [text("Summer sale")] })).status).toBe("not_applicable");
  });

  it("approved colour and font", () => {
    const color = golden({ category: "approved_color", approved_value: "#1A64B4" });
    expect(one([color], detections({ colors: [{ hex: "#1A64B4", share: 0.4 }] })).status).toBe("passed");
    expect(one([color], detections({ colors: [{ hex: "#E63946", share: 0.4 }] })).status).toBe("failed");
    const font = golden({ category: "approved_font", approved_value: "Montserrat, Open Sans" });
    expect(one([font], detections({ fonts: [{ family: "Open Sans", confidence: 0.9 }] })).status).toBe("passed");
    expect(one([font], detections({ fonts: [{ family: "Arial", confidence: 0.9 }] }))).toMatchObject({ status: "failed", detected: "Arial" });
  });

  it("not verified when it can't be checked: worded rules, no approved value, bad colour code, no detections", () => {
    expect(one([golden({ category: "logo_rule", rule: "Logo always top-left" })]).status).toBe("unverified");
    expect(one([golden({ category: "other", rule: "Never show alcohol" })]).status).toBe("unverified");
    expect(one([golden({ category: "approved_cta", approved_value: null })]).status).toBe("unverified");
    expect(one([golden({ category: "approved_color", approved_value: "navy" })]).explanation).toMatch(/isn't a colour code/);
    const noDetections = byRule(run({ company: withRules(golden({ category: "approved_cta", approved_value: "Book now" })) }), "golden_rules");
    expect(noDetections[0]).toMatchObject({ status: "unverified", severity: "critical", expected: "Book now" });
  });

  it("a company with no active Golden Rules: not applicable", () => {
    expect(byRule(run(), "golden_rules")).toMatchObject([{ status: "not_applicable" }]);
  });
});

describe("an invalid saved colour is a company setting to fix, not a design issue", () => {
  const one = (rules: ReturnType<typeof golden>[]) => {
    const findings = byRule(run({ company: company({ goldenRules: rules }), detections: detections() }), "golden_rules");
    expect(findings).toHaveLength(1);
    return findings[0];
  };

  it("the rule says so in settings wording — it's listed under missing company settings, never counted", () => {
    const f = one([golden({ category: "approved_color", approved_value: "navy" })]);
    expect(f).toMatchObject({ status: "unverified", severity: "critical", mandatory: true });
    expect(f.explanation).toBe("The colour saved for this rule (\"navy\") isn't a colour code (#RRGGBB), so it can't be compared. Fix it on the company page.");
    expect(missingCompanySetting(f)).toBe(true);
    expect(needsVerifying(f)).toBe(false); // not an item to check on the design
  });

  it("a valid colour code is still compared as before", () => {
    expect(missingCompanySetting(one([golden({ category: "approved_color", approved_value: "#1A64B4" })]))).toBe(false);
  });
});
