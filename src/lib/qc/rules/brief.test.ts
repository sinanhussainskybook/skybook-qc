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

  it("UK and US spellings of the same words pass (\"Customised\" for \"Customized\"); a real typo is still caught", () => {
    expect(check(requirement("required_text", "Customized Packages"), "Customised Packages")).toMatchObject({ status: "passed" });
    expect(check(requirement("required_text", "Explore our colourful centre"), "Explore our colorful center")).toMatchObject({ status: "passed" });
    expect(check(requirement("product_name", "Travelling Made Easy"), "Traveling made easy")).toMatchObject({ status: "passed" });
    expect(check(requirement("cta", "Organize your trip"), "Organise your trip")).toMatchObject({ status: "passed" });
    // A typo in either spelling is still a typo.
    expect(check(requirement("required_text", "Customized Packages"), "Custmised Packages")).toMatchObject({ status: "failed", severity: "major", detected: "custmised packages" });
  });

  it("mismatched: misspelt, currency left out, country code left out — MAJOR", () => {
    expect(check(requirement("product_name", "Palm Residence"), "The Palm Residense")).toMatchObject({ status: "failed", severity: "major", detected: "palm residense" });
    // A misspelt OPTIONAL item counts no more than a missing one: MINOR (a mandatory one's typo stays MAJOR, above).
    expect(check(requirement("required_text", "Customized Packages", { mandatory: false }), "Custmized Packages")).toMatchObject({ status: "failed", severity: "minor", suggestedFix: 'Write it exactly as "Customized Packages".' });
    // Only typos change: an optional number shown without its country code is still MAJOR.
    expect(check(requirement("phone", "+971 4 123 4567", { mandatory: false }), "Call 04 123 4567")).toMatchObject({ status: "failed", severity: "major" });
    expect(check(requirement("price", "AED 1,299"), "Only 1,299 AED"))
      .toMatchObject({ status: "passed" });
    const noCurrency = byRule(
      run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Only $1,299")] }) }),
      "brief.requirement"
    )[0];
    expect(noCurrency).toMatchObject({ status: "failed", severity: "critical" }); // $ is a different currency → wrong
    expect(check(requirement("phone", "+971 4 123 4567"), "Call 04 123 4567")).toMatchObject({ status: "failed", severity: "major" });
  });

  it("CTA: a misspelt CTA is a typo to correct (with the expected wording), never a different or missing CTA", () => {
    // Read without a role (as Gemini often does): a typo, not "Not found".
    expect(check(requirement("cta", "Ready for a Snowy Escape?"), "Ready for a Snowy Ecsape?")).toMatchObject({
      status: "failed",
      severity: "major",
      detected: "ready for a snowy ecsape",
      suggestedFix: 'Write it exactly as "Ready for a Snowy Escape?".',
    });
    // Read AS the CTA: still a typo, not a "different CTA" (which would be CRITICAL when mandatory).
    const asCta = byRule(
      run({ requirements: [requirement("cta", "Book now")], detections: detections({ texts: [text("Bok now", { role: "cta" })] }) }),
      "brief.requirement"
    )[0];
    expect(asCta).toMatchObject({ status: "failed", severity: "major", detected: "bok now" });
    // Optional: MINOR, like any optional typo.
    expect(check(requirement("cta", "Book now", { mandatory: false }), "Bok now")).toMatchObject({ severity: "minor" });
    // A genuinely different CTA is still WRONG, and none at all still missing.
    const different = byRule(
      run({ requirements: [requirement("cta", "Book now")], detections: detections({ texts: [text("Learn more", { role: "cta" })] }) }),
      "brief.requirement"
    )[0];
    expect(different).toMatchObject({ status: "failed", detected: "Learn more" });
    expect(check(requirement("cta", "Book now"), "Summer sale")).toMatchObject({ status: "failed", severity: "critical", detected: "Not found" });
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
      run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Now AED 1,299, also AED 1,599. Save 20%! Until 31 Dec")] }) }),
      "brief.unexpected"
    );
    expect(findings.map((f) => [f.detected, f.severity])).toEqual([
      ["AED 1,599", "major"], // the brief has a price, this isn't it (and it isn't introduced as the old price)
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
    // The date actually shown, so the designer sees which one is wrong.
    expect(failedFor(date)).toEqual([["brief.requirement.date", "major", "30/10/2026"]]);
    // Several dates: each one listed; one that reads both ways says so.
    const two = run({ requirements: [requirement("date", "31 October 2026")], detections: detections({ texts: [text("From 01/11/2026 to 05/11/2026")] }) });
    expect(byRule(two, "brief.requirement")[0].detected).toBe("1/11/2026 (or the other way round), 5/11/2026 (or the other way round)");
    // Wrong percentage.
    const pct = run({ requirements: [requirement("percentage", "20%")], detections: detections({ texts: [text("Save 25% today")] }) });
    expect(failedFor(pct)).toEqual([["brief.requirement.percentage", "critical", "25%"]]);
  });

  it("other kinds and genuinely extra values are still reported as unexpected", () => {
    // The price is wrong (reported once, under its requirement) — but a date the brief doesn't mention is still flagged.
    const mixed = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("From AED 1,399 until 31 Dec")] }) });
    expect(byRule(mixed, "brief.unexpected").map((f) => [f.status, f.severity, f.detected])).toEqual([["failed", "minor", "31/12"]]);
    // The right price is shown AND another one is left in (not introduced as the old price): still an unexpected MAJOR.
    const leftover = run({ requirements: [requirement("price", "AED 1,299")], detections: detections({ texts: [text("Now AED 1,299 · AED 1,599")] }) });
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

  describe("exact dimensions from the brief (no platform needed)", () => {
    const design = (width: number, height: number, id = "f1", unit: "px" | "pt" = "px") => ({
      id,
      fileName: `${id}.jpg`,
      format: "jpeg" as const,
      size: 500_000,
      media: { unit, width, height },
    });
    const sizeCheck = (expected: string, files: ReturnType<typeof design>[], over = {}) =>
      byRule(
        run({
          requirements: [requirement("dimensions", expected, over)],
          detections: detections({ texts: [text("Book now")] }),
          platform: { platform: null, placement: null, custom: null, files },
        }),
        "brief.requirement"
      );

    it("a mismatch is flagged: 1080 × 1080 asked, 1254 × 1254 delivered (MAJOR when Must have)", () => {
      expect(sizeCheck("1080 × 1080", [design(1254, 1254)])).toEqual([
        expect.objectContaining({
          ruleId: "brief.requirement.dimensions",
          status: "failed",
          severity: "major",
          expected: "1080 × 1080 px",
          detected: "1254 × 1254 px",
          suggestedFix: "Export the design at exactly 1080 × 1080 px.",
          fileName: "f1.jpg",
        }),
      ]);
      expect(sizeCheck("1080x1080", [design(1254, 1254)], { mandatory: false })[0]).toMatchObject({ status: "failed", severity: "minor" });
    });

    it("regression: a size whose × was lost ('1080  1080 px') is still checked against the design", () => {
      expect(sizeCheck("1080  1080 px", [design(1254, 1254)])).toEqual([
        expect.objectContaining({ ruleId: "brief.requirement.dimensions", status: "failed", severity: "major", expected: "1080 × 1080 px", detected: "1254 × 1254 px" }),
      ]);
      expect(sizeCheck("1080 1080", [design(1080, 1080)])[0]).toMatchObject({ status: "passed" });
    });

    it("a matching size passes — written any common way", () => {
      for (const written of ["1080 × 1080", "1080x1080 px", "1080 X 1080", "1080 by 1080 pixels", "Instagram post 1080 x 1080"]) {
        expect(sizeCheck(written, [design(1080, 1080)]), written).toEqual([
          expect.objectContaining({ status: "passed", expected: "1080 × 1080 px", detected: "1080 × 1080 px" }),
        ]);
      }
    });

    it("each design is measured separately (a carousel)", () => {
      const findings = sizeCheck("1080 × 1080", [design(1080, 1080, "a"), design(1080, 1350, "b")]);
      expect(findings.map((f) => [f.fileName, f.status]).sort()).toEqual([["a.jpg", "passed"], ["b.jpg", "failed"]]);
    });

    it("not measured → not verified, never guessed; no design → not verified", () => {
      expect(sizeCheck("1080 × 1080", [{ ...design(0, 0), media: null } as never])[0]).toMatchObject({ status: "unverified" });
      expect(sizeCheck("1080 × 1080", [design(1080, 1080, "p", "pt")])[0]).toMatchObject({ status: "unverified" });
      expect(sizeCheck("1080 × 1080", [])[0]).toMatchObject({ status: "unverified" });
    });

    it("dimensions that aren't one exact pixel size stay with the Platform / Size check", () => {
      for (const written of ["Square", "210 × 297 mm", "1080 × 1080 or 1080 × 1350", "4:5"]) {
        expect(sizeCheck(written, [design(1254, 1254)])[0], written).toMatchObject({ status: "not_applicable" });
      }
    });
  });

  describe("product / service described in the brief", () => {
    it("regression: an optional product or service name that isn't on the design isn't reported as missing", () => {
      for (const type of ["product_name", "service_name"]) {
        const missing = check(requirement(type, "Customized Azerbaijan Travel Packages", { mandatory: false }), "Snow Has Arrived in Azerbaijan!", "Customised Packages");
        expect(missing, type).toMatchObject({ status: "not_applicable", severity: "suggestion" });
        expect(missing.explanation, type).toContain("doesn't require these exact words");
      }
    });

    it("still checked when it is on the design, misspelt, or Must have", () => {
      expect(check(requirement("product_name", "Palm Residence", { mandatory: false }), "The Palm Residence collection")).toMatchObject({ status: "passed" });
      expect(check(requirement("product_name", "Palm Residence", { mandatory: false }), "The Palm Residense collection")).toMatchObject({ status: "failed", severity: "minor" }); // optional typo
      expect(check(requirement("product_name", "Palm Residence"), "The Palm Residense collection")).toMatchObject({ status: "failed", severity: "major" }); // Must have typo
      expect(check(requirement("product_name", "Palm Residence"), "Summer sale")).toMatchObject({ status: "failed", severity: "critical", detected: "Not found" });
      // Other kinds of text are unchanged: an optional offer that's missing is still MINOR.
      expect(check(requirement("offer", "Free airport transfer", { mandatory: false }), "Summer sale")).toMatchObject({ status: "failed", severity: "minor" });
    });
  });

  describe("exact wording capitals (Must have required text)", () => {
    it("same words, different capitals → MINOR (T&C apply vs T&C Apply)", () => {
      expect(check(requirement("required_text", "T&C apply"), "Book today. T&C Apply")).toMatchObject({
        status: "failed",
        severity: "minor",
        expected: "T&C apply",
        detected: "T&C Apply",
        explanation: expect.stringContaining("capitals"),
      });
    });

    it("normal sentences aren't held to capitals: ALL CAPS styling, a capital at the start, other text kinds, optional items", () => {
      expect(check(requirement("required_text", "T&C apply"), "T&C APPLY")).toMatchObject({ status: "passed" });
      expect(check(requirement("required_text", "limited availability"), "Limited availability")).toMatchObject({ status: "passed" });
      expect(check(requirement("required_text", "T&C apply", { mandatory: false }), "T&C Apply")).toMatchObject({ status: "passed" });
      expect(check(requirement("offer", "Free airport transfer"), "free Airport Transfer")).toMatchObject({ status: "passed" });
      expect(check(requirement("headline", "Summer in the sun"), "Summer In The Sun")).toMatchObject({ status: "passed" });
    });
  });
});
