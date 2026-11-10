import { describe, expect, it } from "vitest";
import { applyConfidencePolicy } from "@/lib/analysis/policy";
import { datesMatch, datesWrittenOneWay, findDates } from "@/lib/qc/compare";
import { consolidateFindings } from "@/lib/qc/consolidate";
import type { ContentDetections } from "@/lib/qc/detections";
import type { QcContext } from "@/lib/qc/rules/context";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 (designer feedback), Track A2 — dates written with Arabic month names (Gulf / Egyptian and
 * Levantine), in Arabic-Indic or Western digits, with or without a year, are found and compared like the
 * same date in English; findings show them exactly as written. English dates behave as before.
 */

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
/** One date mention's reading(s), without the written text. */
const values = (s: string) => findDates(s).map((m) => m.map(({ day, month, year }) => ({ day, month, year })));
const one = (s: string) => {
  const found = findDates(s);
  expect(found, s).toHaveLength(1);
  return found[0][0];
};
function results(over: Partial<QcContext>) {
  const d = (over.detections ?? null) as ContentDetections | null;
  return consolidateFindings(applyConfidencePolicy(run(over), d, { state: "done" }, { provider: "google" }));
}

describe("A2 Arabic month names: every month, both naming systems", () => {
  const gulf = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  const levantine = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];

  it("Gulf / Egyptian names, months 1–12", () => {
    gulf.forEach((name, i) => expect(one(`١٥ ${name} ٢٠٢٦`), name).toMatchObject({ day: 15, month: i + 1, year: 2026 }));
  });

  it("Levantine names, months 1–12", () => {
    levantine.forEach((name, i) => expect(one(`١٥ ${name} ٢٠٢٦`), name).toMatchObject({ day: 15, month: i + 1, year: 2026 }));
  });

  it("common spelling variants: any alef form, يونيه / يوليه, without ال, alef without hamza", () => {
    for (const [name, month] of [
      ["ابريل", 4], ["إبريل", 4], ["يونيه", 6], ["يوليه", 7], ["اغسطس", 8], ["اكتوبر", 10],
      ["اذار", 3], ["ايار", 5], ["اب", 8], ["ايلول", 9],
      ["تشرين أول", 10], ["تشرين اول", 10], ["تشرين ثاني", 11], ["كانون ثاني", 1], ["كانون أول", 12], ["كانون الاول", 12],
    ] as const) {
      expect(one(`٣ ${name} ٢٠٢٦`), name).toMatchObject({ day: 3, month, year: 2026 });
    }
  });
});

describe("A2 digits, years and the ways a date is written", () => {
  it("Arabic-Indic or Western digits", () => {
    expect(values("٣١ ديسمبر ٢٠٢٦")).toEqual([[{ day: 31, month: 12, year: 2026 }]]);
    expect(values("31 ديسمبر 2026")).toEqual([[{ day: 31, month: 12, year: 2026 }]]);
    expect(values("٣١ ديسمبر 2026")).toEqual([[{ day: 31, month: 12, year: 2026 }]]);
  });

  it("with and without a year", () => {
    expect(values("حتى ١٨ أكتوبر")).toEqual([[{ day: 18, month: 10, year: undefined }]]);
    expect(values("حتى ١٨ أكتوبر ٢٠٢٦")).toEqual([[{ day: 18, month: 10, year: 2026 }]]);
  });

  it("'من' / 'شهر', a comma, 'عام' / 'سنة', a trailing 'م', and the other month name in brackets or after a slash", () => {
    for (const s of [
      "١٥ من ديسمبر ٢٠٢٦",
      "١٥ من شهر ديسمبر ٢٠٢٦",
      "١٥ ديسمبر، ٢٠٢٦",
      "١٥ ديسمبر عام ٢٠٢٦",
      "١٥ ديسمبر سنة ٢٠٢٦",
      "١٥ ديسمبر ٢٠٢٦م",
      "١٥ ديسمبر ٢٠٢٦ م",
      "١٥ كانون الأول (ديسمبر) ٢٠٢٦",
      "١٥ كانون الأول/ديسمبر ٢٠٢٦",
    ]) {
      expect(values(s), s).toEqual([[{ day: 15, month: 12, year: 2026 }]]);
    }
  });

  it("the date is kept exactly as written (for findings), surrounding words left out", () => {
    expect(one("العرض ساري حتى ٣١ ديسمبر ٢٠٢٦ فقط").text).toBe("٣١ ديسمبر ٢٠٢٦");
    expect(one("و٣١ كانون الأول ٢٠٢٦م").text).toBe("٣١ كانون الأول ٢٠٢٦م");
    expect(one("Valid until 31 ديسمبر").text).toBe("31 ديسمبر");
  });

  it("a mixed line finds the English and the Arabic date, each once", () => {
    expect(values("Until 31 Dec 2026 / حتى ٣١ ديسمبر ٢٠٢٦")).toEqual([
      [{ day: 31, month: 12, year: 2026 }],
      [{ day: 31, month: 12, year: 2026 }],
    ]);
  });
});

describe("A2 not dates: prices, times, other numbers and words that only look like month names", () => {
  it("never a date", () => {
    for (const s of [
      "٣١ درهم",
      "خصم ٢٠٪",
      "٢ مايونيز", // mayonnaise starts like مايو
      "٣ آبار", // wells start like آب
      "٥ ابريليات",
      "١٢٣ ديسمبر", // part of a longer number
      "٢٠٢٦ مارس", // a year, not a day
      "١٠:٣٠ مارس", // after a time
      "١٢٫٥ مارس", // a decimal
      "1,299 مايو",
      "مايو ٢٠٢٦", // month and year, no day
      "٣٢ ديسمبر", // no 32nd
      "٠ يناير",
      "شهر رمضان ٢٠٢٦",
    ]) {
      expect(findDates(s), s).toEqual([]);
    }
  });

  it("Arabic numbers that aren't next to a month name are unaffected", () => {
    expect(findDates("خصم ٥٠٪ لمدة ٣ أيام فقط — اتصل ٠٤ ١٢٣ ٤٥٦٧")).toEqual([]);
  });
});

describe("A2 comparing and writing dates one way", () => {
  it("the same date in English and Arabic matches, both ways and in both naming systems", () => {
    const [english] = findDates("31 Dec 2026");
    for (const s of ["٣١ ديسمبر ٢٠٢٦", "31 كانون الأول 2026", "٣١ كانون أول"]) {
      const [arabic] = findDates(s, { withoutYear: true });
      expect(datesMatch(english, arabic), s).toBe(true);
      expect(datesMatch(arabic, english), s).toBe(true);
    }
    expect(datesMatch(english, findDates("٣٠ ديسمبر ٢٠٢٦")[0])).toBe(false);
    expect(datesMatch(english, findDates("٣١ نوفمبر ٢٠٢٦")[0])).toBe(false);
  });

  it("datesWrittenOneWay: Arabic month dates read the same as every other way of writing them", () => {
    expect(datesWrittenOneWay("العرض ساري حتى ٣١ ديسمبر ٢٠٢٦")).toBe("العرض ساري حتى 31/12/2026");
    expect(datesWrittenOneWay("حتى ٣١ كانون الأول")).toBe("حتى 31/12");
    expect(datesWrittenOneWay("حتى 31 Dec 2026")).toBe("حتى 31/12/2026");
    // Not a date: left as it was.
    expect(datesWrittenOneWay("٢ مايونيز")).toBe("2 مايونيز");
  });
});

describe("A2 end to end", () => {
  it("brief date in English, design in Arabic → present (was: missing)", () => {
    const [f] = byRule(run({ requirements: [requirement("date", "31 Dec 2026")], detections: read("العرض ساري حتى ٣١ ديسمبر ٢٠٢٦") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("brief date in Arabic (Levantine), design in English or numbers → present", () => {
    for (const shown of ["Offer ends 31 December 2026", "Ends 31/12/2026"]) {
      const [f] = byRule(run({ requirements: [requirement("date", "٣١ كانون الأول ٢٠٢٦")], detections: read(shown) }), "brief.requirement");
      expect(f.status, shown).toBe("passed");
    }
  });

  it("a different Arabic date is wrong, shown exactly as written", () => {
    const [f] = byRule(run({ requirements: [requirement("date", "31 Dec 2026")], detections: read("حتى ٣٠ ديسمبر ٢٠٢٦") }), "brief.requirement");
    expect([f.status, f.detected]).toEqual(["failed", "٣٠ ديسمبر ٢٠٢٦"]);
  });

  it("an Arabic date the brief doesn't give is flagged as unexpected, as written; one it does give isn't", () => {
    const unexpected = byRule(run({ requirements: [requirement("price", "AED 99")], detections: read("AED 99", "حتى ١٥ مارس ٢٠٢٦") }), "brief.unexpected");
    expect(unexpected.filter((f) => f.status === "failed").map((f) => f.detected)).toEqual(["١٥ مارس ٢٠٢٦"]);
    const expected = byRule(run({ requirements: [requirement("date", "15 March 2026")], detections: read("حتى ١٥ آذار ٢٠٢٦") }), "brief.unexpected");
    expect(expected.filter((f) => f.status === "failed")).toEqual([]);
  });

  it("a different Arabic date is one issue (wrong) — never also an unexpected date", () => {
    const counted = results({ requirements: [requirement("date", "31 Dec 2026")], detections: read("حتى ٣٠ ديسمبر ٢٠٢٦") }).filter((f) => f.status === "failed");
    expect(counted.map((f) => f.ruleId)).toEqual(["brief.requirement.date"]);
  });

  it("an Arabic disclaimer with a date passes when the design writes the same date another way", () => {
    const [f] = byRule(
      run({ requirements: [requirement("disclaimer", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦")], detections: read("العرض ساري حتى 31/12/2026") }),
      "legal.disclaimer"
    );
    expect(f.status).toBe("passed");
  });

  it("a worded requirement with a date passes across English and Arabic month names", () => {
    const [f] = byRule(run({ requirements: [requirement("required_text", "حتى ٣١ ديسمبر")], detections: read("حتى ٣١ كانون الأول") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });
});
