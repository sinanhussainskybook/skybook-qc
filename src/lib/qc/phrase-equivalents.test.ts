import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, HUMAN_CHECK, HUMAN_CHECK_CRITICAL, isHumanCheck } from "@/lib/analysis/policy";
import { consolidateFindings } from "@/lib/qc/consolidate";
import type { ContentDetections } from "@/lib/qc/detections";
import type { QcContext } from "@/lib/qc/rules/context";
import { identifyPhrase, matchEquivalent, PHRASE_FAMILIES, type PhraseFamily } from "@/lib/qc/phrase-equivalents";
import { byRule, company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 (designer feedback), Track A5 — the approved English ↔ Arabic phrase list: every family in both
 * directions, the approved decisions and adjustments, negation, date / price mismatches, and how the brief,
 * legal and Golden Rules checks use it.
 */

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
const fill = (form: string, family: PhraseFamily, language: "en" | "ar") =>
  form.replace("{value}", family.slot === "date" ? (language === "en" ? "31 Dec 2026" : "٣١ ديسمبر ٢٠٢٦") : language === "en" ? "AED 99" : "٩٩ درهم");
const results = (over: Partial<QcContext>) => {
  const d = (over.detections ?? null) as ContentDetections | null;
  return consolidateFindings(applyConfidencePolicy(run(over), d, { state: "done" }, { provider: "google" }));
};

describe("A5 every approved family, both directions", () => {
  for (const family of PHRASE_FAMILIES) {
    it(`${family.id}: each English form matches each Arabic form shown, and the reverse`, () => {
      for (const en of family.en) {
        for (const ar of family.ar) {
          const english = fill(en, family, "en");
          const arabic = fill(ar, family, "ar");
          expect(identifyPhrase(english)?.family.id, english).toBe(family.id);
          expect(matchEquivalent(english, [`نص قبل\n${arabic}\nنص بعد`]), `${english} ← ${arabic}`).toMatchObject({ kind: "present", shownLanguage: "ar" });
          expect(matchEquivalent(arabic, [`Before\n${english}\nAfter`]), `${arabic} ← ${english}`).toMatchObject({ kind: "present", shownLanguage: "en" });
        }
      }
    });
  }

  it("the shown text is reported exactly as written", () => {
    expect(matchEquivalent("Book now", ["احجز الآن!"])).toMatchObject({ shown: "احجز الآن" });
    expect(matchEquivalent("Terms and conditions apply", ["*تُطبّق الشروط والأحكام"])).toMatchObject({ shown: "تُطبّق الشروط والأحكام" });
  });

  it("vowel marks, tatweel and alef forms don't matter (الآن = الان)", () => {
    expect(matchEquivalent("Book now", ["احجز الان"])?.kind).toBe("present");
    expect(matchEquivalent("Book now", ["احجـــز الآن"])?.kind).toBe("present");
  });
});

describe("A5 approved decisions", () => {
  it("1. اتصل بنا is Call us — never Contact us", () => {
    expect(matchEquivalent("Call us", ["اتصل بنا"])?.kind).toBe("present");
    expect(matchEquivalent("Contact us", ["اتصل بنا"])).toBeNull();
    expect(matchEquivalent("اتصل بنا", ["Contact us"])).toBeNull();
  });

  it("2. اكتشف المزيد is Discover more — never Learn more", () => {
    expect(matchEquivalent("Discover more", ["اكتشف المزيد"])?.kind).toBe("present");
    expect(matchEquivalent("Learn more", ["اكتشف المزيد"])).toBeNull();
  });

  it("3. الحين, gender and plural forms only where approved for that phrase", () => {
    expect(matchEquivalent("Book now", ["احجز الحين"])?.kind).toBe("present");
    expect(matchEquivalent("Book now", ["احجزي الآن"])?.kind).toBe("present");
    expect(matchEquivalent("Buy now", ["اشتر الحين"])).toBeNull(); // not approved for Buy now
    expect(matchEquivalent("Call us now", ["اتصل بنا الحين"])).toBeNull(); // not approved for Call us now
    expect(matchEquivalent("Start now", ["ابدئي الآن"])).toBeNull(); // feminine not approved for Start now
  });

  it("4. Offer valid until = Offer ends, with the date checked", () => {
    expect(matchEquivalent("Offer valid until 31 Dec 2026", ["ينتهي العرض في ٣١ ديسمبر ٢٠٢٦"])?.kind).toBe("present");
    expect(matchEquivalent("Offer ends 31/12/2026", ["العرض ساري حتى ٣١ كانون الأول ٢٠٢٦"])?.kind).toBe("present");
  });
});

describe("A5 approved adjustments", () => {
  it("D7: 'شاملة الضريبة' (which tax?) is not Prices include VAT", () => {
    expect(matchEquivalent("Prices include VAT", ["الأسعار شاملة الضريبة"])).toBeNull();
    expect(matchEquivalent("Prices include VAT", ["شاملة الضريبة"])).toBeNull();
  });

  it("D14: both per person AND twin sharing are needed; either alone is not enough", () => {
    expect(matchEquivalent("Per person, twin sharing", ["للشخص الواحد على أساس غرفة مزدوجة"])?.kind).toBe("present");
    expect(matchEquivalent("Per person, twin sharing", ["على أساس غرفة مزدوجة"])).toBeNull();
    expect(matchEquivalent("Per person, twin sharing", ["للشخص الواحد"])).toBeNull();
  });

  it("D3: نفاذ الكمية is a valid variation", () => {
    expect(matchEquivalent("While stocks last", ["حتى نفاذ الكمية"])?.kind).toBe("present");
  });

  it("D5/D6: a different or missing date is never a match", () => {
    expect(matchEquivalent("Offer valid until 31 Dec 2026", ["العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦"])).toMatchObject({ kind: "value_differs", shown: "العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦" });
    expect(matchEquivalent("Offer valid until 31 Dec 2026", ["العرض ساري حتى نهاية الشهر"])).toBeNull();
  });

  it("no blanket negation rule: the approved negative phrases work as whole patterns", () => {
    expect(matchEquivalent("Prices exclude VAT", ["الأسعار غير شاملة ضريبة القيمة المضافة"])?.kind).toBe("present");
    expect(matchEquivalent("Prices exclude VAT", ["لا تشمل ضريبة القيمة المضافة"])?.kind).toBe("present");
    expect(matchEquivalent("Non-refundable", ["غير قابل للاسترداد"])?.kind).toBe("present");
    expect(matchEquivalent("غير قابل للاسترداد", ["Non-refundable"])?.kind).toBe("present");
  });
});

describe("A5 negative examples (approved list): never equivalent", () => {
  it.each([
    ["Book now", "احجز اليوم"],
    ["Book now", "احجز مقعدك"],
    ["Buy now", "تسوق الآن"],
    ["Call now", "تواصل معنا"],
    ["Call now", "اتصل بنا الآن"],
    ["Learn more", "اقرأ المزيد"],
    ["Register now", "اشترك الآن"],
    ["Terms and conditions apply", "تطبق الشروط"],
    ["Prices include VAT", "الأسعار غير شاملة ضريبة القيمة المضافة"],
    ["While stocks last", "عرض لفترة محدودة"],
    ["Starting from AED 99", "فقط ٩٩ درهم"],
    ["Per person, twin sharing", "للشخص الواحد"],
    ["Non-refundable", "قابل للاسترداد"],
  ])("%s ≠ %s", (required, shown) => {
    expect(matchEquivalent(required, [shown])).toBeNull();
  });

  it("a negation right before an approved form breaks it", () => {
    expect(matchEquivalent("Terms and conditions apply", ["لا تطبق الشروط والأحكام"])).toBeNull();
    expect(matchEquivalent("Subject to availability", ["غير حسب التوفر"])).toBeNull();
    expect(matchEquivalent("تطبق الشروط والأحكام", ["Not terms and conditions apply"])).toBeNull();
  });

  it("a starting price that differs is reported as different, shown as written", () => {
    expect(matchEquivalent("Starting from AED 99", ["ابتداءً من ١٢٠ درهم"])).toMatchObject({ kind: "value_differs", shown: "ابتداءً من ١٢٠ درهم" });
    expect(matchEquivalent("Starting from AED 99", ["ابتداءً من ٩٩ ريال"])).toMatchObject({ kind: "value_differs" });
  });
});

describe("A5 boundaries: complete phrases only, across languages only", () => {
  it("a requirement that only CONTAINS a phrase is not matched this way", () => {
    expect(identifyPhrase("Book now and save 20%")).toBeNull();
    expect(matchEquivalent("Book now and save 20%", ["احجز الآن ووفر ٢٠٪"])).toBeNull();
  });

  it("never part of a word", () => {
    expect(matchEquivalent("Visit us", ["زورونا"])?.kind).toBe("present");
    expect(matchEquivalent("Visit us", ["زوروناهم"])).toBeNull();
    expect(matchEquivalent("Read more", ["اقرأ المزيدات"])).toBeNull();
  });

  it("same language: never handled by the list (unchanged behaviour)", () => {
    expect(matchEquivalent("احجز الآن", ["احجزوا الآن"])).toBeNull();
    expect(matchEquivalent("Terms and conditions apply", ["T&C apply"])).toBeNull();
  });

  it("not in the list: nothing is guessed", () => {
    expect(matchEquivalent("Hurry up", ["أسرع"])).toBeNull();
    expect(identifyPhrase("Payment plan available")).toBeNull();
  });
});

describe("A5 end to end — brief requirements", () => {
  it("a CTA shown in Arabic passes, saying how it was found", () => {
    const [f] = byRule(run({ requirements: [requirement("cta", "Book now")], detections: read("احجز الآن") }), "brief.requirement");
    expect(f).toMatchObject({ status: "passed", detected: "احجز الآن" });
    expect(f.explanation).toBe('Present in Arabic ("احجز الآن") — an approved equivalent of the brief\'s wording.');
  });

  it("mandatory legal wording translated from the brief's English → Needs a human check (possible critical), never passed", () => {
    const fs = results({ requirements: [requirement("required_text", "Terms and conditions apply")], detections: read("تطبق الشروط والأحكام") });
    const [f] = byRule(fs, "brief.requirement");
    expect(f.status).toBe("unverified");
    expect(isHumanCheck(f)).toBe(true);
    expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(f.detected).toBe("تطبق الشروط والأحكام");
  });

  it("optional legal wording translated → passed", () => {
    const [f] = byRule(run({ requirements: [requirement("required_text", "While stocks last", { mandatory: false })], detections: read("حتى نفاذ الكمية") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("the brief gives the approved Arabic version → that is the reference: both pass", () => {
    const fs = byRule(
      run({ requirements: [requirement("required_text", "Terms and conditions apply"), requirement("required_text", "تطبق الشروط والأحكام")], detections: read("تطبق الشروط والأحكام") }),
      "brief.requirement"
    );
    expect(fs.map((f) => f.status)).toEqual(["passed", "passed"]);
    expect(fs[0].explanation).toMatch(/approved Arabic version is checked as its own requirement/);
  });

  it("an Arabic phrase with a different date is wrong, shown as written", () => {
    const [f] = byRule(run({ requirements: [requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false })], detections: read("العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦") }), "brief.requirement");
    expect([f.status, f.detected]).toEqual(["failed", "العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦"]);
  });

  it("a starting price shown in Arabic: the right price passes, another is wrong", () => {
    const ok = byRule(run({ requirements: [requirement("required_text", "Starting from AED 99", { mandatory: false })], detections: read("ابتداءً من ٩٩ درهم") }), "brief.requirement");
    expect(ok[0].status).toBe("passed");
    const wrong = byRule(run({ requirements: [requirement("required_text", "Starting from AED 99", { mandatory: false })], detections: read("ابتداءً من ١٢٠ درهم") }), "brief.requirement");
    expect([wrong[0].status, wrong[0].detected]).toEqual(["failed", "ابتداءً من ١٢٠ درهم"]);
  });

  it("not equivalent → still missing (e.g. Learn more vs اكتشف المزيد)", () => {
    const [f] = byRule(run({ requirements: [requirement("cta", "Learn more")], detections: read("اكتشف المزيد") }), "brief.requirement");
    expect(f.status).toBe("failed");
  });
});

describe("A5 end to end — legal disclaimers and Golden Rules", () => {
  const disclaimer = (wording: string, shown: string, over = {}, extra: ReturnType<typeof requirement>[] = []) =>
    byRule(run({ requirements: [requirement("disclaimer", wording, over), ...extra], detections: read(shown) }), "legal.disclaimer")[0];

  it("mandatory disclaimer, Arabic only on the design, English only in the brief → Needs a human check", () => {
    const f = disclaimer("Terms and conditions apply", "تطبق الشروط والأحكام");
    expect(f.status).toBe("unverified");
    expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
  });

  it("…with the approved Arabic version in the brief → passed against that reference", () => {
    const f = disclaimer("Terms and conditions apply", "تطبق الشروط والأحكام", {}, [requirement("disclaimer", "تطبق الشروط والأحكام")]);
    expect(f.status).toBe("passed");
  });

  it("optional disclaimer translated → passed; a different date → failed, as written", () => {
    expect(disclaimer("Offer ends 31 Dec 2026", "ينتهي العرض في ٣١ ديسمبر ٢٠٢٦", { mandatory: false }).status).toBe("passed");
    const f = disclaimer("Offer ends 31 Dec 2026", "ينتهي العرض في ٣٠ ديسمبر ٢٠٢٦", { mandatory: false });
    expect([f.status, f.detected]).toEqual(["failed", "ينتهي العرض في ٣٠ ديسمبر ٢٠٢٦"]);
  });

  it("mandatory disclaimer with the matching date, translated → still a human check (the date alone doesn't confirm legal wording)", () => {
    const f = disclaimer("Offer valid until 31 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦");
    expect(f.status).toBe("unverified");
  });

  it("Golden Rule mandatory disclaimer in English, design in Arabic → human check; approved CTA in Arabic → passed", () => {
    const rules = company({
      goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "Prices include VAT" }), golden({ category: "approved_cta", approved_value: "Book now" })],
    });
    const fs = byRule(run({ company: rules, detections: read("الأسعار شاملة ضريبة القيمة المضافة", "احجز الآن") }), "golden_rules");
    const [legal, cta] = [fs.find((f) => f.ruleId.endsWith("mandatory_disclaimer"))!, fs.find((f) => f.ruleId.endsWith("approved_cta"))!];
    expect(legal.status).toBe("unverified");
    expect(legal.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(cta).toMatchObject({ status: "passed", detected: "احجز الآن" });
  });

  it("the human-check wording is the app's standard one", () => {
    const f = disclaimer("Subject to availability", "حسب التوفر", { mandatory: false });
    expect(f.status).toBe("passed");
    expect(HUMAN_CHECK).toBe("Needs a human check");
  });
});
