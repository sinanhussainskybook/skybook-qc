import { describe, expect, it } from "vitest";
import { byRule, company, detections, only, requirement, run, text } from "../../../../test/qc-fixtures";

/** Plan 5.4 — Content QC. */
describe("Content rules", () => {
  const withText = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)) });

  it("contact details: matching passes; a wrong one is CRITICAL; a local number without country code is MINOR", () => {
    const findings = byRule(run({ detections: withText("Call +971 4 123 4567", "WhatsApp 050 765 4321", "sales@skybookvillas.com", "www.skybookvillas.com") }), "content.contact_details");
    expect(findings.map((f) => [f.ruleId, f.status, f.severity]).sort()).toEqual(
      [
        ["content.contact_details.email", "passed", "critical"],
        ["content.contact_details.phone", "failed", "minor"], // 050… without +971
        ["content.contact_details.phone", "passed", "critical"],
        ["content.contact_details.website", "passed", "critical"],
      ].sort()
    );

    const wrong = byRule(run({ detections: withText("Call +971 4 999 0000", "info@other.com", "skybook.co") }), "content.contact_details");
    expect(wrong.filter((f) => f.status === "failed").map((f) => [f.title, f.severity, f.detected]).sort()).toEqual([
      ["Phone / WhatsApp number", "critical", "+971 4 999 0000"],
      ["Email address", "critical", "info@other.com"],
      ["Website", "critical", "skybook.co"],
    ].sort());
    const phone = wrong.find((f) => f.title === "Phone / WhatsApp number")!;
    expect(phone.expected).toBe("+971 4 123 4567 or +971 50 765 4321");
    expect(phone.suggestedFix).toBe("Replace it with +971 4 123 4567.");
  });

  it("contact details: an EXTRA one beside the approved one is MAJOR, to check it's intended; with no approved one shown it stays CRITICAL", () => {
    // The approved phone is on the design, and so is another: the other one may be intended (a second branch).
    const extra = byRule(run({ detections: withText("Call +971 4 123 4567 or +971 4 999 0000") }), "content.contact_details");
    expect(extra.map((f) => [f.status, f.severity, f.detected]).sort()).toEqual([
      ["failed", "major", "+971 4 999 0000"],
      ["passed", "critical", "+971 4 123 4567"],
    ]);
    const check = extra.find((f) => f.status === "failed")!;
    expect(check.suggestedFix).toBe("Check it's intended; if not, remove it.");
    expect(check.explanation).toMatch(/approved one is also on the design/);
    // The approved one shown without its country code still counts as shown.
    const local = byRule(run({ detections: withText("Call 04 123 4567 or +971 4 999 0000") }), "content.contact_details");
    expect(local.find((f) => f.detected === "+971 4 999 0000")).toMatchObject({ severity: "major" });
    // Per kind: an approved phone doesn't make an unknown email "intended".
    const otherKind = byRule(run({ detections: withText("Call +971 4 123 4567", "info@other.com") }), "content.contact_details");
    expect(otherKind.find((f) => f.title === "Email address")).toMatchObject({ status: "failed", severity: "critical" });
    // No approved phone anywhere: still CRITICAL — people would be sent to the wrong place.
    expect(only(run({ detections: withText("Call +971 4 999 0000") }), "content.contact_details")).toMatchObject({ severity: "critical", suggestedFix: "Replace it with +971 4 123 4567." });
  });

  it("contact details: the optional additional phone is an approved number too", () => {
    const withExtra = company({ contact: { phone: "+971 4 123 4567", additional_phone: "+971 4 222 3333", whatsapp: null, email: null, website: null } });
    const findings = byRule(run({ company: withExtra, detections: withText("Call +971 4 222 3333") }), "content.contact_details");
    expect(findings.map((f) => f.status)).toEqual(["passed"]);
    const wrong = only(run({ company: withExtra, detections: withText("Call +971 4 999 0000") }), "content.contact_details");
    expect(wrong).toMatchObject({ status: "failed", expected: "+971 4 123 4567 or +971 4 222 3333" });
    // Only the additional phone saved: still compared, not "nothing saved".
    const onlyExtra = company({ contact: { phone: null, additional_phone: "+971 4 222 3333", whatsapp: null, email: null, website: null } });
    expect(only(run({ company: onlyExtra, detections: withText("Call +971 4 222 3333") }), "content.contact_details").status).toBe("passed");
  });

  it("contact details from the brief are accepted too", () => {
    const findings = byRule(
      run({ detections: withText("Call +971 4 222 3333"), requirements: [requirement("phone", "+971 4 222 3333")] }),
      "content.contact_details"
    );
    expect(findings.map((f) => f.status)).toEqual(["passed"]);
  });

  it("contact details: nothing saved to compare → not verified; none shown → not applicable", () => {
    const noContact = company({ contact: { phone: null, additional_phone: null, whatsapp: null, email: null, website: null } });
    expect(only(run({ company: noContact, detections: withText("Call +971 4 123 4567") }), "content.contact_details")).toMatchObject({ status: "unverified" });
    expect(only(run({ detections: withText("Summer sale") }), "content.contact_details")).toMatchObject({ status: "not_applicable" });
  });

  it("company name: exact passes, misspelt is MAJOR, absent is not applicable", () => {
    expect(only(run({ detections: withText("Stay at Skybook Villas") }), "content.company_name").status).toBe("passed");
    expect(only(run({ detections: withText("Stay at Skybok Villas") }), "content.company_name")).toMatchObject({ status: "failed", severity: "major", detected: "skybok villas" });
    expect(only(run({ detections: withText("Summer sale") }), "content.company_name").status).toBe("not_applicable");
  });

  it("placeholder text left in is CRITICAL", () => {
    for (const placeholder of ["Lorem ipsum dolor", "Your headline here", "Call [insert number]", "Price: XXX", "Dates TBC", "Hello {{first_name}}"]) {
      expect(only(run({ detections: withText(placeholder) }), "content.placeholder"), placeholder).toMatchObject({ status: "failed", severity: "critical" });
    }
    expect(only(run({ detections: withText("Book your villa today") }), "content.placeholder").status).toBe("passed");
  });

  it("an accidentally repeated word is MINOR", () => {
    expect(only(run({ detections: withText("Book the the best villa") }), "content.repeated_word")).toMatchObject({ status: "failed", severity: "minor", detected: "the the" });
    expect(only(run({ detections: withText("Book the best villa") }), "content.repeated_word").status).toBe("passed");
  });

  it("video: what is SAID counts too", () => {
    const d = detections({ texts: [], speech: [{ text: "call us on +971 4 999 0000", startMs: 0, endMs: 2000, confidence: 0.9 }] });
    expect(byRule(run({ detections: d }, "reel_short"), "content.contact_details")[0]).toMatchObject({ status: "failed", severity: "critical" });
  });

  it("no detections → every content check is NOT VERIFIED (5.13)", () => {
    const findings = byRule(run(), "content");
    expect(findings.length).toBe(4);
    expect(findings.every((f) => f.status === "unverified" && f.confidence === 0)).toBe(true);
  });
});
