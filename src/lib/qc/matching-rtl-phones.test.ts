import { describe, expect, it } from "vitest";
import { patternCandidates } from "@/lib/analysis/information";
import { findPhones, phonesMatch } from "@/lib/qc/compare";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3, Track A1 follow-up (S30) — "+971 4 123 4567" read from right-to-left text often comes out with the
 * "+" after the country code: "٩٧١+ ٤ ١٢٣ ٤٥٦٧" (Gemini's actual reading of validation design S30). It is the
 * international number only when the context says it's a phone number; it is always shown as written.
 */

const S30_LINE = "للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧"; // Gemini's reading of S30, character for character
const S30_PHONE = "٩٧١+ ٤ ١٢٣ ٤٥٦٧";
const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
const RLM = "‏";
/** Numbers taken with a right-to-left "+" (a digit followed by "+"). Other findings are the existing behaviour. */
const plus = (found: string[]) => found.filter((p) => /[0-9٠-٩۰-۹]\+/.test(p));

describe("S30: the right-to-left '+' after the country code", () => {
  it("Gemini's S30 reading is one international number, shown exactly as written", () => {
    expect(findPhones(S30_LINE)).toEqual([S30_PHONE]);
    expect(phonesMatch("+971 4 123 4567", S30_PHONE)).toBe("match"); // was: match_without_country_code
  });

  it("S30 end to end: the brief phone requirement passes, the shown text is unchanged", () => {
    const d = read("Skybook Villas", "عرض الشتاء", "فقط ٩٩ ريال", "حتى ٣١ ديسمبر ٢٠٢٦", S30_LINE, "Terms and condi-", "tions apply");
    const [f] = byRule(run({ requirements: [requirement("phone", "+971 4 123 4567", { mandatory: false })], detections: d }), "brief.requirement");
    expect(f.status).toBe("passed");
    expect(f.detected).toContain(S30_PHONE);
  });

  it("company contact details: the approved phone written right to left passes", () => {
    const phone = byRule(run({ detections: read(S30_LINE) }), "content.contact_details").filter((f) => f.ruleId === "content.contact_details.phone");
    expect(phone.map((f) => f.status)).toEqual(["passed"]);
  });

  it("brief reading (no AI): the number is found in the brief, kept as written", () => {
    expect(patternCandidates(S30_LINE).filter((c) => c.type === "phone")).toEqual([{ type: "phone", label: null, value: S30_PHONE }]);
  });
});

describe("Arabic and Persian digits, Western digits on an Arabic line, direction marks", () => {
  it("Persian (Eastern Arabic) digits", () => {
    expect(findPhones("تماس: ۹۷۱+ ۴ ۱۲۳ ۴۵۶۷")).toEqual(["۹۷۱+ ۴ ۱۲۳ ۴۵۶۷"]);
    expect(phonesMatch("+971 4 123 4567", "۹۷۱+ ۴ ۱۲۳ ۴۵۶۷")).toBe("match");
  });

  it("Iran (two-digit code) with a Persian phone word", () => {
    expect(findPhones("تماس: ۹۸+ ۲۱ ۱۲۳۴ ۵۶۷۸")).toEqual(["۹۸+ ۲۱ ۱۲۳۴ ۵۶۷۸"]);
    expect(phonesMatch("+98 21 1234 5678", "۹۸+ ۲۱ ۱۲۳۴ ۵۶۷۸")).toBe("match");
  });

  it("Egypt (two-digit code) with an Arabic phone word", () => {
    expect(findPhones("اتصل ٢٠+ ١٠ ١٢٣٤ ٥٦٧٨")).toEqual(["٢٠+ ١٠ ١٢٣٤ ٥٦٧٨"]);
  });

  it("Western digits on an Arabic line", () => {
    expect(findPhones("للحجز: 971+ 4 123 4567")).toEqual(["971+ 4 123 4567"]);
    expect(phonesMatch("+971 4 123 4567", "971+ 4 123 4567")).toBe("match");
  });

  it("other Gulf numbers, dashes, and invisible direction marks", () => {
    expect(findPhones("واتساب ٩٦٦+ ٥٠-١٢٣-٤٥٦٧")).toEqual(["٩٦٦+ ٥٠-١٢٣-٤٥٦٧"]);
    expect(findPhones(`للحجز ٩٧١+${RLM} ٤ ١٢٣ ٤٥٦٧`)).toEqual([`٩٧١+${RLM} ٤ ١٢٣ ٤٥٦٧`]);
    expect(phonesMatch("+971 4 123 4567", `٩٧١+${RLM} ٤ ١٢٣ ٤٥٦٧`)).toBe("match");
  });

  it("several numbers on one line keep their order", () => {
    expect(findPhones("اتصل ٩٧١+ ٤ ١٢٣ ٤٥٦٧ أو ٠٥٠ ٧٦٥ ٤٣٢١")).toEqual(["٩٧١+ ٤ ١٢٣ ٤٥٦٧", "٠٥٠ ٧٦٥ ٤٣٢١"]);
  });

  it("a different number, or another country, is still a different number", () => {
    expect(phonesMatch("+971 4 123 4567", "٩٧١+ ٤ ٩٩٩ ٠٠٠٠")).toBe("mismatch");
    expect(phonesMatch("+971 4 123 4567", "٩٦٦+ ٤ ١٢٣ ٤٥٦٧")).toBe("mismatch");
    const [f] = byRule(run({ requirements: [requirement("phone", "+971 4 123 4567")], detections: read("للحجز: ٩٦٦+ ٤ ١٢٣ ٤٥٦٧") }), "brief.requirement");
    expect(f.status).toBe("failed");
    expect(f.detected).toContain("٩٦٦+ ٤ ١٢٣ ٤٥٦٧");
  });
});

describe("not phone numbers: the trailing '+' is NOT taken as a country code", () => {
  it("ages", () => {
    expect(findPhones("الدخول للبالغين ١٨+ فقط")).toEqual([]);
    expect(findPhones("+١٨ للكبار فقط")).toEqual([]);
  });

  it("counts (not a country code, or written with thousands separators)", () => {
    expect(findPhones("أكثر من ٥٠٠+ عميل سعيد")).toEqual([]);
    expect(plus(findPhones("انضم إلى ١٠٠+ ١٢٠٠٠٠٠ عضو"))).toEqual([]); // 100 isn't a country code
    expect(findPhones("٩٦٦+ ١٬٢٠٠٬٠٠٠ زائر")).toEqual([]);
  });

  it("two-digit codes without a phone word (Egypt 20, Iran 98) stay counts", () => {
    expect(plus(findPhones("أكثر من ٢٠+ ١٢٣٤٥٦٧٨ قطعة"))).toEqual([]);
    expect(plus(findPhones("بیش از ۹۸+ ۱۲۳۴۵۶۷۸ نفر"))).toEqual([]);
  });

  it("prices: a currency straight after the number", () => {
    expect(plus(findPhones("السعر ٩٧١+ ١٢٣٤٥٦٧ ريال"))).toEqual([]);
    expect(plus(findPhones("٩٧١+ ١٢٣٤٥٦٧ درهم"))).toEqual([]);
    expect(plus(findPhones("٩٧١+ ١٢٣٤٥٦٧ AED"))).toEqual([]);
    expect(findPhones("فقط ٩٩+ ريال")).toEqual([]);
  });

  it("percentages", () => {
    expect(plus(findPhones("خصم ٩٧١+ ١٢٣٤٥٦٧٪"))).toEqual([]);
    expect(plus(findPhones("نمو ٩٧١+ ١٢٣٤٥٦٧ %"))).toEqual([]);
  });

  it("arithmetic and joined digits", () => {
    expect(findPhones("٢+١ مجاناً")).toEqual([]);
    expect(plus(findPhones("٣×٩٧١+ ٤ ١٢٣ ٤٥٦٧"))).toEqual([]);
    expect(plus(findPhones("١٩٧١+ ٤ ١٢٣ ٤٥٦٧"))).toEqual([]); // part of a longer number
    // No space after the '+': not the right-to-left form ("+٤١٢٣٤٥٦٧" is still found, as before this change).
    expect(plus(findPhones("٩٧١+٤١٢٣٤٥٦٧ عرض"))).toEqual([]);
    expect(plus(findPhones("+٩٧١+ ٤ ١٢٣ ٤٥٦٧"))).toEqual([]);
  });

  it("a sum with spaces around the sign: the old reading (local number), not the country code", () => {
    for (const sum of ["٥ + ٩٧١+ ٤ ١٢٣ ٤٥٦٧", "٥ × ٩٧١+ ٤ ١٢٣ ٤٥٦٧", "٥ = ٩٧١+ ٤ ١٢٣ ٤٥٦٧", "٥ ÷ ٩٧١+ ٤ ١٢٣ ٤٥٦٧", "5 + 971+ 4 123 4567 عرض"]) {
      expect([sum, plus(findPhones(sum))]).toEqual([sum, []]);
    }
    expect(findPhones("٥ + ٩٧١+ ٤ ١٢٣ ٤٥٦٧")).toEqual(["٤ ١٢٣ ٤٥٦٧"]); // as before this change
  });

  it("two numbers separated by '/' are both still read right to left", () => {
    expect(findPhones("هاتف: ٩٧١+ ٤ ١٢٣ ٤٥٦٧ / ٩٧١+ ٥٠ ٧٦٥ ٤٣٢١")).toEqual(["٩٧١+ ٤ ١٢٣ ٤٥٦٧", "٩٧١+ ٥٠ ٧٦٥ ٤٣٢١"]);
  });

  it("dates, year spans and short tails", () => {
    expect(findPhones("٩٧١+ ٢٠٢٦/١٢/٣١ عرض")).toEqual([]);
    expect(findPhones("٩٧١+ ٢٠٢٥ - ٢٠٢٦ عرض")).toEqual([]);
    expect(findPhones("٩٧١+ ١٢٣ ٤٥ عرض")).toEqual([]);
  });

  it("no Arabic script on the number's line: unchanged (local number only, as before)", () => {
    expect(findPhones("Call 971+ 4 123 4567")).toEqual(["4 123 4567"]);
    expect(findPhones("عرض الشتاء\n971+ 4 123 4567")).toEqual(["4 123 4567"]);
    expect(phonesMatch("+971 4 123 4567", "4 123 4567")).toBe("match_without_country_code");
  });

  it("the number never runs into the next line", () => {
    expect(findPhones("للحجز: ٩٧١+ ٤ ١٢٣ ٤٥٦٧\nAED 99")).toEqual([S30_PHONE]);
  });
});
