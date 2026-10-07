import { describe, expect, it } from "vitest";
import { byRule, detections, requirement, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.10 — Brief QC: missing, wrong, mismatched and unexpected content. */
describe("Brief rules", () => {
  const check = (req: ReturnType<typeof requirement>, ...lines: string[]) => {
    const findings = byRule(run({ requirements: [req], detections: detections({ texts: lines.map((l) => text(l)) }) }), "brief.requirement");
    expect(findings).toHaveLength(1);
    return findings[0];
  };

  it("each requirement type: present passes", () => {
    const cases: [string, string, string][] = [
      ["headline", "Summer in the sun", "SUMMER IN THE SUN!"],
      ["required_text", "Limited availability", "Hurry — limited availability"],
      ["offer", "Free airport transfer", "Includes free airport transfer"],
      ["price", "AED 1,299", "From 1299 AED per night"],
      ["percentage", "20%", "Save 20 % today"],
      ["date", "31 December 2026", "Offer ends 31/12/2026"],
      ["time", "7 PM", "Doors open 19:00"],
      ["phone", "+971 4 123 4567", "Call +971-4-123-4567"],
      ["whatsapp", "+971 50 765 4321", "WhatsApp +971 50 765 4321"],
      ["email", "sales@skybookvillas.com", "Email SALES@skybookvillas.com"],
      ["website", "https://skybookvillas.com", "www.skybookvillas.com"],
      ["cta", "Book now", "BOOK NOW →"],
      ["product_name", "Palm Residence", "The Palm Residence collection"],
      ["service_name", "Concierge", "24/7 concierge"],
      ["location", "Dubai Marina", "In Dubai Marina"],
      ["campaign_name", "Summer Escape", "Summer Escape 2026"],
    ];
    for (const [type, expected, shown] of cases) {
      expect(check(requirement(type, expected), shown), type).toMatchObject({ status: "passed" });
    }
  });

  it("missing: CRITICAL when mandatory, MINOR when optional", () => {
    expect(check(requirement("offer", "Free airport transfer"), "Summer sale")).toMatchObject({ status: "failed", severity: "critical", detected: "Not found" });
    expect(check(requirement("offer", "Free airport transfer", { mandatory: false }), "Summer sale")).toMatchObject({ status: "failed", severity: "minor" });
  });

  it("wrong value: CRITICAL when mandatory (the 'wrong price → FAIL' case), MAJOR when optional", () => {
    expect(check(requirement("price", "AED 1,299"), "Now AED 1,399")).toMatchObject({ status: "failed", severity: "critical", detected: "AED 1,399" });
    expect(check(requirement("percentage", "20%", { mandatory: false }), "Save 25%")).toMatchObject({ status: "failed", severity: "major", detected: "25%" });
    expect(check(requirement("date", "31 December 2026"), "Ends 30/12/2026")).toMatchObject({ status: "failed", severity: "critical" });
    expect(check(requirement("cta", "Book now"), text("x").text, "Learn more")).toMatchObject({ status: "failed" });
    expect(check(requirement("phone", "+971 4 123 4567"), "Call +971 4 123 9999")).toMatchObject({ status: "failed", severity: "critical" });
  });

  it("mismatched: misspelt, currency left out, country code left out — MAJOR", () => {
    expect(check(requirement("product_name", "Palm Residence"), "The Palm Residense")).toMatchObject({ status: "failed", severity: "major", detected: "palm residense" });
    expect(check(requirement("price", "AED 1,299"), "Only 1,299 AED"))
      .toMatchObject({ status: "passed" });
    const noCurrency = byRule(
      run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Only $1,299")] }) }),
      "brief.requirement"
    )[0];
    expect(noCurrency).toMatchObject({ status: "failed", severity: "critical" }); // $ is a different currency → wrong
    expect(check(requirement("phone", "+971 4 123 4567"), "Call 04 123 4567")).toMatchObject({ status: "failed", severity: "major" });
  });

  it("headline: a different headline is wrong", () => {
    const findings = byRule(
      run({ requirements: [requirement("headline", "Summer in the sun")], detections: detections({ texts: [text("Winter warmers", { role: "headline" })] }) }),
      "brief.requirement"
    );
    expect(findings[0]).toMatchObject({ status: "failed", severity: "critical", detected: "Winter warmers" });
  });

  it("video: a requirement that is SAID counts as present", () => {
    const d = detections({ texts: [], speech: [{ text: "book now on our website", startMs: 0, endMs: 2000, confidence: 0.9 }] });
    expect(byRule(run({ requirements: [requirement("cta", "Book now")], detections: d }, "reel_short"), "brief.requirement")[0].status).toBe("passed");
  });

  it("types that can't be compared, platform / dimensions and disclaimers are handed off correctly", () => {
    const findings = byRule(
      run({
        requirements: [
          requirement("target_audience", "Families"),
          requirement("platform", "Instagram"),
          requirement("disclaimer", "T&Cs apply"),
        ],
        detections: detections({ texts: [text("Hello")] }),
      }),
      "brief.requirement"
    );
    expect(findings.map((f) => [f.ruleId, f.status]).sort()).toEqual([
      ["brief.requirement.platform", "not_applicable"],
      ["brief.requirement.target_audience", "unverified"],
    ]);
  });

  it("unexpected prices, percentages and dates", () => {
    const findings = byRule(
      run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Now AED 1,299, was AED 1,599. Save 20%! Until 31 Dec")] }) }),
      "brief.unexpected"
    );
    expect(findings.map((f) => [f.detected, f.severity])).toEqual([
      ["AED 1,599", "major"], // the brief has a price, this isn't it
      ["20%", "minor"], // the brief has no percentage
      ["31/12", "minor"],
    ]);
    expect(byRule(run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("AED 1,299")] }) }), "brief.unexpected")[0].status).toBe("passed");
  });

  it("one wrong value → ONE finding: a requirement's WRONG value isn't repeated as 'Unexpected offer details'", () => {
    const failedFor = (findings: ReturnType<typeof run>) => findings.filter((f) => f.status === "failed").map((f) => [f.ruleId, f.severity, f.detected]);
    // Wrong mandatory price: only the requirement finding (still CRITICAL — severity unchanged).
    const price = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("From AED 1,399")] }) });
    expect(failedFor(price)).toEqual([["brief.requirement.price", "critical", "AED 1,399"]]);
    // …and the unexpected-values check doesn't claim "nothing unexpected" either.
    expect(byRule(price, "brief.unexpected")).toMatchObject([{ status: "not_applicable" }]);
    expect(byRule(price, "brief.unexpected")[0].explanation).toMatch(/price shown differs from the brief — reported under the brief's requirement above/);
    // Wrong optional date (the live Version 1 case: "30 October" instead of "31 October"): one MAJOR, not two.
    const date = run({ requirements: [requirement("date", "31 October 2026", { mandatory: false })], detections: detections({ texts: [text("Offer ends 30 October 2026")] }) });
    expect(failedFor(date)).toEqual([["brief.requirement.date", "major", "1 other date"]]);
    // Wrong percentage.
    const pct = run({ requirements: [requirement("percentage", "20%")], detections: detections({ texts: [text("Save 25% today")] }) });
    expect(failedFor(pct)).toEqual([["brief.requirement.percentage", "critical", "25%"]]);
  });

  it("other kinds and genuinely extra values are still reported as unexpected", () => {
    // The price is wrong (reported once, under its requirement) — but a date the brief doesn't mention is still flagged.
    const mixed = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("From AED 1,399 until 31 Dec")] }) });
    expect(byRule(mixed, "brief.unexpected").map((f) => [f.status, f.severity, f.detected])).toEqual([["failed", "minor", "31/12"]]);
    // The right price is shown AND an old one is left in: the old one is still an unexpected MAJOR (no duplicate there).
    const leftover = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Now AED 1,299, was AED 1,599")] }) });
    expect(byRule(leftover, "brief.requirement")).toMatchObject([{ status: "passed" }]);
    expect(byRule(leftover, "brief.unexpected").map((f) => [f.status, f.severity, f.detected])).toEqual([["failed", "major", "AED 1,599"]]);
    // A different currency is a WRONG price too: reported once (CRITICAL, mandatory), not again as unexpected.
    const otherCurrency = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Only $1,299")] }) });
    expect(otherCurrency.filter((f) => f.status === "failed").map((f) => [f.ruleId, f.severity])).toEqual([["brief.requirement.price", "critical"]]);
    // Nothing wrong at all: the unexpected check still passes as before.
    expect(byRule(run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("AED 1,299")] }) }), "brief.unexpected")).toMatchObject([{ status: "passed" }]);
  });

  it("no detections → not verified per requirement; no requirements → not applicable", () => {
    const findings = byRule(run({ requirements: [requirement("price", "AED 1,299"), requirement("cta", "Book now", { mandatory: false })] }), "brief.requirement");
    expect(findings.map((f) => [f.status, f.severity, f.expected])).toEqual([
      ["unverified", "critical", "AED 1,299"],
      ["unverified", "major", "Book now"],
    ]);
    expect(byRule(run({ detections: detections({ texts: [text("x")] }) }), "brief.requirement")).toMatchObject([{ status: "not_applicable" }]);
  });
});
