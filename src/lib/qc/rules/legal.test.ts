import { describe, expect, it } from "vitest";
import { byRule, company, detections, golden, requirement, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.12 — Legal & Compliance: only configured rules, nothing invented. */
describe("Legal & Compliance rules", () => {
  const T_AND_C = "Terms and conditions apply. Prices exclude VAT.";

  it("nothing configured → one 'not applicable' finding, never an invented rule", () => {
    const findings = byRule(
      run({
        // A company with a Golden Rule disclaimer: that's 5.6, not a legal rule here.
        company: company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "T&Cs apply" })] }),
        detections: detections({ texts: [text("Win a free villa! 100% guaranteed returns")] }),
      }),
      "legal"
    );
    expect(findings).toEqual([expect.objectContaining({ status: "not_applicable", category: "legal" })]);
  });

  it("a disclaimer in the brief must be on screen word for word", () => {
    const req = requirement("disclaimer", T_AND_C);
    const check = (...lines: string[]) => byRule(run({ requirements: [req], detections: detections({ texts: lines.map((l) => text(l)) }) }), "legal")[0];
    expect(check("*Terms and conditions apply - Prices exclude VAT")).toMatchObject({ status: "passed", severity: "critical" }); // punctuation isn't wording
    expect(check("TERMS AND CONDITIONS APPLY. PRICES EXCLUDE VAT.")).toMatchObject({ status: "passed", severity: "critical" }); // ALL CAPS is styling
    expect(check("Terms and condition apply. Prices exclude VAT.")).toMatchObject({ status: "failed", severity: "critical", detected: expect.stringContaining("condition") });
    expect(check("Summer sale")).toMatchObject({ status: "failed", severity: "critical", detected: "Not found" });
  });

  it("a mandatory disclaimer with different capitals is MINOR (T&C apply vs T&C Apply)", () => {
    const check = (expected: string, shown: string, mandatory = true) =>
      byRule(run({ requirements: [requirement("disclaimer", expected, { mandatory })], detections: detections({ texts: [text(shown)] }) }), "legal")[0];
    expect(check("T&C apply", "Book now. T&C Apply")).toMatchObject({
      status: "failed",
      severity: "minor",
      expected: "T&C apply",
      detected: "T&C Apply",
      explanation: expect.stringContaining("capitals"),
      suggestedFix: 'Show the disclaimer exactly as: "T&C apply".',
    });
    expect(check("T&C apply", "Book now. T&C apply")).toMatchObject({ status: "passed" });
    expect(check("T&C apply", "T&C APPLY")).toMatchObject({ status: "passed" }); // ALL CAPS styling
    expect(check("terms apply", "Terms apply")).toMatchObject({ status: "passed" }); // only the first letter (start of a line)
    expect(check("Prices exclude VAT", "Prices exclude vat")).toMatchObject({ status: "failed", severity: "minor", detected: "Prices exclude vat" });
    // An exact copy anywhere is enough.
    expect(check("T&C apply", "T&C Apply. Book now, T&C apply")).toMatchObject({ status: "passed" });
    // Optional disclaimers aren't held to capitals.
    expect(check("T&C apply", "T&C Apply", false)).toMatchObject({ status: "passed" });
  });

  it("optional disclaimer is MAJOR; spoken-only doesn't count", () => {
    const req = requirement("disclaimer", "T&Cs apply", { mandatory: false });
    const spoken = detections({ texts: [], speech: [{ text: "T&Cs apply", startMs: 0, endMs: 1, confidence: 1 }] });
    expect(byRule(run({ requirements: [req], detections: spoken }, "reel_short"), "legal")[0]).toMatchObject({ status: "failed", severity: "major" });
  });

  it("no detections → not verified", () => {
    expect(byRule(run({ requirements: [requirement("disclaimer", T_AND_C)] }), "legal")[0]).toMatchObject({ status: "unverified", expected: T_AND_C });
  });
});
