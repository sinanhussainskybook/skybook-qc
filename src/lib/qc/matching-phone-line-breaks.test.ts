import { describe, expect, it } from "vitest";
import { patternCandidates } from "@/lib/analysis/information";
import { findPhones, phonesMatch } from "@/lib/qc/compare";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Live release test (2026-11-11): a brief with a numbered list gave the phone requirement "+971 4 123 4567 2" —
 * the phone number ran on across the line break into "2. Event date". A phone number now stays on its line, in
 * the general and the right-to-left (S30) patterns. Numbers within a line are unchanged.
 */

const briefPhones = (brief: string) => patternCandidates(brief).filter((c) => c.type === "phone").map((c) => c.value);

describe("a phone number never runs on to the next numbered brief item", () => {
  it("'2.', '2)' and '2 ' on the next line", () => {
    expect(briefPhones("Phone: +971 4 123 4567\n2. Event date: 15 December 2026")).toEqual(["+971 4 123 4567"]);
    expect(briefPhones("1) Phone +971 4 123 4567\n2) Date 15 December 2026")).toEqual(["+971 4 123 4567"]);
    expect(briefPhones("Phone: +971 4 123 4567\n2 Event date")).toEqual(["+971 4 123 4567"]);
  });

  it("Windows line breaks, local numbers, and a list item with two digits", () => {
    expect(briefPhones("Phone: +971 4 123 4567\r\n2. Event date")).toEqual(["+971 4 123 4567"]);
    expect(briefPhones("Call 04 123 4567\n3) Price: AED 99")).toEqual(["04 123 4567"]);
    expect(briefPhones("Phone: 050 765 4321\n12. Website")).toEqual(["050 765 4321"]);
  });

  it("Arabic and Persian digits, and the right-to-left form (S30)", () => {
    expect(briefPhones("هاتف: +٩٧١ ٤ ١٢٣ ٤٥٦٧\n٢. تاريخ الفعالية")).toEqual(["+٩٧١ ٤ ١٢٣ ٤٥٦٧"]);
    expect(briefPhones("تماس: ۰۴ ۱۲۳ ۴۵۶۷\n۲) تاریخ")).toEqual(["۰۴ ۱۲۳ ۴۵۶۷"]);
    expect(briefPhones("للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧\n٢. تاريخ الفعالية")).toEqual(["٩٧١+ ٤ ١٢٣ ٤٥٦٧"]);
    expect(briefPhones("للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧\n2 Event date")).toEqual(["٩٧١+ ٤ ١٢٣ ٤٥٦٧"]);
  });

  it("the extracted value then matches the phone shown on the design", () => {
    const [value] = briefPhones("Phone: +971 4 123 4567\n2. Event date: 15 December 2026");
    expect(phonesMatch(value, "٩٧١+ ٤ ١٢٣ ٤٥٦٧")).toBe("match");
    expect(phonesMatch(value, "+971 4 123 4567")).toBe("match");
  });

  it("on the design: a phone line followed by a line starting with a number", () => {
    const d = detections({ texts: [text("للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧"), text("2026 offer")], textCoverage: 0.95 });
    const [f] = byRule(run({ requirements: [requirement("phone", "+971 4 123 4567")], detections: d }), "brief.requirement");
    expect([f.status, f.detected]).toEqual(["passed", "٩٧١+ ٤ ١٢٣ ٤٥٦٧"]);
    expect(findPhones("Call 04 123 4567\n2026 offer")).toEqual(["04 123 4567"]);
  });

  it("a number broken over two lines is no longer joined into one (each line is read on its own)", () => {
    expect(findPhones("+971 4\n123 4567")).toEqual(["123 4567"]); // "+971 4" alone is too short; the 7-digit line is a run of its own
  });
});

describe("phone numbers on one line are unchanged", () => {
  it("Western formats", () => {
    expect(findPhones("+971 4 123 4567")).toEqual(["+971 4 123 4567"]);
    expect(findPhones("+971-4-123-4567")).toEqual(["+971-4-123-4567"]);
    expect(findPhones("(04) 123 4567")).toEqual(["(04) 123 4567"]);
    expect(findPhones("00971 4 123 4567")).toEqual(["00971 4 123 4567"]);
    expect(findPhones("+971.4.123.4567")).toEqual(["+971.4.123.4567"]);
    expect(findPhones("Call +971 4 123 4567 or 050 765 4321")).toEqual(["+971 4 123 4567", "050 765 4321"]);
  });

  it("tabs and non-breaking spaces between groups still count as the same line", () => {
    expect(findPhones("+971\t4\t123\t4567")).toEqual(["+971\t4\t123\t4567"]);
    const nbsp = String.fromCharCode(0xa0);
    expect(findPhones(`+971${nbsp}4${nbsp}123${nbsp}4567`)).toEqual([`+971${nbsp}4${nbsp}123${nbsp}4567`]);
  });

  it("Arabic, Persian and the right-to-left form (S30)", () => {
    expect(findPhones("هاتف: +٩٧١ ٤ ١٢٣ ٤٥٦٧")).toEqual(["+٩٧١ ٤ ١٢٣ ٤٥٦٧"]);
    expect(findPhones("تماس ۰۴ ۱۲۳ ۴۵۶۷")).toEqual(["۰۴ ۱۲۳ ۴۵۶۷"]);
    expect(findPhones("للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧")).toEqual(["٩٧١+ ٤ ١٢٣ ٤٥٦٧"]);
    expect(phonesMatch("+971 4 123 4567", "٩٧١+ ٤ ١٢٣ ٤٥٦٧")).toBe("match");
  });

  it("dates and years are still not phone numbers", () => {
    expect(findPhones("31/12/2026")).toEqual([]);
    expect(findPhones("2025 - 2026")).toEqual([]);
  });
});
