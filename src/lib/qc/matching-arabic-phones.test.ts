import { describe, expect, it } from "vitest";
import { patternCandidates } from "@/lib/analysis/information";
import { findPhones, phonesMatch } from "@/lib/qc/compare";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 (designer feedback), Track A1 — phone numbers written in Arabic-Indic (٠–٩) or Eastern Arabic
 * (۰–۹) digits are found and compared like the same number in Western digits, and are always shown as
 * written. Western-digit behaviour is unchanged.
 */

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
const RLM = "‏";
const LRM = "‎";
const ALM = "؜";

describe("A1 finding phone numbers in Arabic digits", () => {
  it("Arabic-Indic and Eastern Arabic digits are found, and returned exactly as written", () => {
    expect(findPhones("اتصل على ٠٤ ١٢٣ ٤٥٦٧")).toEqual(["٠٤ ١٢٣ ٤٥٦٧"]);
    expect(findPhones("هاتف: +٩٧١ ٤ ١٢٣ ٤٥٦٧")).toEqual(["+٩٧١ ٤ ١٢٣ ٤٥٦٧"]);
    expect(findPhones("تماس ۰۴ ۱۲۳ ۴۵۶۷")).toEqual(["۰۴ ۱۲۳ ۴۵۶۷"]);
    expect(findPhones("٠٠٩٧١-٤-١٢٣-٤٥٦٧")).toEqual(["٠٠٩٧١-٤-١٢٣-٤٥٦٧"]);
    expect(findPhones("(٠٤) ١٢٣ ٤٥٦٧")).toEqual(["(٠٤) ١٢٣ ٤٥٦٧"]);
  });

  it("a number with invisible direction marks inside (copied Arabic text) is one number, shown as written", () => {
    expect(findPhones(`+971${RLM} 4 123 4567`)).toEqual([`+971${RLM} 4 123 4567`]);
    expect(findPhones(`+٩٧١${LRM} ٤ ١٢٣${ALM} ٤٥٦٧`)).toEqual([`+٩٧١${LRM} ٤ ١٢٣${ALM} ٤٥٦٧`]);
  });

  it("Arabic and Western numbers on one line are each found", () => {
    expect(findPhones("Call +971 4 123 4567 أو ٠٥٠ ٧٦٥ ٤٣٢١")).toEqual(["+971 4 123 4567", "٠٥٠ ٧٦٥ ٤٣٢١"]);
  });

  it("dates, year spans, prices and short numbers in Arabic digits are not phone numbers", () => {
    expect(findPhones("٢٠٢٦/١٢/٣١")).toEqual([]);
    expect(findPhones("٣١-١٢-٢٠٢٦")).toEqual([]);
    expect(findPhones("٢٠٢٥ - ٢٠٢٦")).toEqual([]);
    expect(findPhones("١٬٢٩٩ درهم")).toEqual([]);
    expect(findPhones("خصم ٢٠٪")).toEqual([]);
    expect(findPhones("١٢٣ ٤٥")).toEqual([]); // too few digits
    expect(findPhones("١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦")).toEqual([]); // too many
  });
});

describe("A1 comparing phone numbers across digit styles", () => {
  it("the same number in either digit style matches, both ways", () => {
    expect(phonesMatch("+971 4 123 4567", "+٩٧١ ٤ ١٢٣ ٤٥٦٧")).toBe("match");
    expect(phonesMatch("+٩٧١ ٤ ١٢٣ ٤٥٦٧", "+971 4 123 4567")).toBe("match");
    expect(phonesMatch("+971 4 123 4567", "+۹۷۱ ۴ ۱۲۳ ۴۵۶۷")).toBe("match");
    expect(phonesMatch("٠٠٩٧١٤١٢٣٤٥٦٧", "+971 4 123 4567")).toBe("match");
  });

  it("a local number in Arabic digits matches the international one, but says so (as in Western digits)", () => {
    expect(phonesMatch("+971 4 123 4567", "٠٤ ١٢٣ ٤٥٦٧")).toBe("match_without_country_code");
    expect(phonesMatch("+971 4 123 4567", "04 123 4567")).toBe("match_without_country_code");
  });

  it("a different number is still different, in any digit style", () => {
    expect(phonesMatch("+971 4 123 4567", "+٩٧١ ٤ ٩٩٩ ٠٠٠٠")).toBe("mismatch");
    expect(phonesMatch("+971 4 123 4567", "+٩٦٦ ٤ ١٢٣ ٤٥٦٧")).toBe("mismatch");
    expect(phonesMatch("+971 4 123 4567", "٠٤ ٩٩٩ ٠٠٠٠")).toBe("mismatch");
  });

  it("direction marks inside a number don't change it", () => {
    expect(phonesMatch("+971 4 123 4567", `+٩٧١${RLM} ٤ ١٢٣ ٤٥٦٧`)).toBe("match");
  });
});

describe("A1 end to end: the brief and contact-details checks", () => {
  it("brief phone requirement in Western digits, design in Arabic digits → present (was: missing)", () => {
    const [f] = byRule(run({ requirements: [requirement("phone", "+971 4 123 4567")], detections: read("للحجز اتصل +٩٧١ ٤ ١٢٣ ٤٥٦٧") }), "brief.requirement");
    expect(f.status).toBe("passed");
    expect(f.detected).toContain("+٩٧١ ٤ ١٢٣ ٤٥٦٧"); // shown as written
  });

  it("brief phone in Arabic digits, design in Western digits → present", () => {
    const [f] = byRule(run({ requirements: [requirement("phone", "٠٤ ١٢٣ ٤٥٦٧")], detections: read("Call 04 123 4567") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("brief phone, design shows a different number in Arabic digits → wrong (never passed)", () => {
    const [f] = byRule(run({ requirements: [requirement("phone", "+971 4 123 4567")], detections: read("اتصل +٩٧١ ٤ ٩٩٩ ٠٠٠٠") }), "brief.requirement");
    expect(f.status).toBe("failed");
    expect(f.detected).toContain("+٩٧١ ٤ ٩٩٩ ٠٠٠٠");
  });

  it("company contact details: the approved phone in Arabic digits passes; a different one is reported as written", () => {
    const ok = byRule(run({ detections: read("اتصل +٩٧١ ٤ ١٢٣ ٤٥٦٧") }), "content.contact_details").filter((f) => f.ruleId === "content.contact_details.phone");
    expect(ok.map((f) => f.status)).toEqual(["passed"]);
    const wrong = byRule(run({ detections: read("اتصل +٩٧١ ٤ ٩٩٩ ٠٠٠٠") }), "content.contact_details").filter((f) => f.ruleId === "content.contact_details.phone");
    expect(wrong.map((f) => [f.status, f.severity, f.detected])).toEqual([["failed", "critical", "+٩٧١ ٤ ٩٩٩ ٠٠٠٠"]]);
  });

  it("brief reading (no AI): a phone in Arabic digits is found in the brief, kept as written", () => {
    expect(patternCandidates("للتواصل: ٠٤ ١٢٣ ٤٥٦٧").filter((c) => c.type === "phone")).toEqual([{ type: "phone", label: null, value: "٠٤ ١٢٣ ٤٥٦٧" }]);
  });
});
