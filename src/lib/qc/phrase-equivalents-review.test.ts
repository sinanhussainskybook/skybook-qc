import { describe, expect, it } from "vitest";
import { HUMAN_CHECK_CRITICAL, isHumanCheck } from "@/lib/analysis/policy";
import { wordSequenceMatches } from "@/lib/qc/compare";
import { matchEquivalent, PHRASE_FAMILIES, PHRASE_OVERLAPS } from "@/lib/qc/phrase-equivalents";
import { byRule, company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";
import type { Box } from "@/lib/qc/detections";

/**
 * A5 review fixes (approved 2026-11-10):
 *   1. same-language checks first — an approved equivalent never hides a typo or a wrong date / price;
 *   2. overlapping phrases — the approved decisions, and unlisted legal extensions go to a person;
 *   3. a date / price on the line after the phrase (reading order), only at that line's start;
 *   4. more negation words, immediately before only, and punctuation never makes a false failure.
 */

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
const kindOf = (required: string, ...shown: string[]) => matchEquivalent(required, shown)?.kind ?? null;
const brief = (type: string, value: string, lines: string[], over = {}) =>
  byRule(run({ requirements: [requirement(type, value, over)], detections: read(...lines) }), "brief.requirement")[0];
const disclaimer = (value: string, lines: string[], over = {}) =>
  byRule(run({ requirements: [requirement("disclaimer", value, over)], detections: read(...lines) }), "legal.disclaimer")[0];
const goldenRule = (category: "mandatory_disclaimer" | "approved_cta", value: string, d: ReturnType<typeof read>) =>
  byRule(run({ company: company({ goldenRules: [golden({ category, approved_value: value })] }), detections: d }), "golden_rules")[0];

describe("Fix 1 — same-language checks first: A5 never hides a typo or a wrong value", () => {
  it("brief CTA: an English typo beside the correct Arabic is still a typo, with the Arabic mentioned", () => {
    const f = brief("cta", "Book now", ["Book nwo", "احجز الآن"]);
    expect([f.status, f.detected]).toEqual(["failed", "book nwo"]);
    expect(f.explanation).toContain('An approved Arabic equivalent is also shown correctly ("احجز الآن"), but the English wording still needs correcting.');
  });

  it("brief CTA: another English CTA beside the correct Arabic is still a different CTA", () => {
    const d = detections({ texts: [text("Book today", { role: "cta" }), text("احجز الآن", { role: "cta" })], textCoverage: 0.95 });
    const [f] = byRule(run({ requirements: [requirement("cta", "Book now")], detections: d }), "brief.requirement");
    expect([f.status, f.detected]).toEqual(["failed", "Book today"]);
    expect(f.explanation).toContain("An approved Arabic equivalent is also shown correctly");
  });

  it("brief wording: a wrong English date beside the correct Arabic is still a wrong date", () => {
    const f = brief("required_text", "Offer valid until 31 Dec 2026", ["Offer valid until 30 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦"], { mandatory: false });
    expect(f.status).toBe("failed");
    expect(f.detected).toMatch(/30/);
    expect(f.explanation).toContain("An approved Arabic equivalent is also shown correctly");
  });

  it("brief wording: a wrong English price beside the correct Arabic is still a wrong price", () => {
    const f = brief("required_text", "Starting from AED 99", ["Starting from AED 120", "ابتداءً من ٩٩ درهم"], { mandatory: false });
    expect(f.status).toBe("failed");
    // Reported exactly as with the English alone (the existing same-language result), plus the note.
    const englishOnly = brief("required_text", "Starting from AED 99", ["Starting from AED 120"], { mandatory: false });
    expect([f.status, f.detected]).toEqual([englishOnly.status, englishOnly.detected]);
    expect(f.explanation).toContain("An approved Arabic equivalent is also shown correctly");
  });

  it("legal disclaimer: an English typo beside the correct Arabic is still not word for word", () => {
    const f = disclaimer("Terms and conditions apply", ["Terms and condtions apply", "تطبق الشروط والأحكام"], { mandatory: false });
    expect([f.status, f.detected]).toEqual(["failed", "terms and condtions apply"]);
    expect(f.explanation).toContain("An approved Arabic equivalent is also shown correctly");
  });

  it("Golden Rules: a misspelt disclaimer and a different English CTA stay failures beside correct Arabic", () => {
    const legal = goldenRule("mandatory_disclaimer", "Terms and conditions apply", read("Terms and condtions apply", "تطبق الشروط والأحكام"));
    expect(legal.status).toBe("failed");
    expect(legal.explanation).toContain("An approved Arabic equivalent is also shown correctly");
    const cta = goldenRule("approved_cta", "Book now", detections({ texts: [text("Book today", { role: "cta" }), text("احجز الآن", { role: "cta" })], textCoverage: 0.95 }));
    expect([cta.status, cta.detected]).toEqual(["failed", "Book today"]);
  });

  it("with nothing in the brief's language, A5 still works as approved", () => {
    expect(brief("cta", "Book now", ["احجز الآن"]).status).toBe("passed");
    expect(disclaimer("Subject to availability", ["حسب التوفر"], { mandatory: false }).status).toBe("passed");
  });
});

describe("Fix 2 — overlapping phrases: the approved decisions", () => {
  it("every overlap in the list has an approved decision (none handled silently)", () => {
    const pairs = new Set<string>();
    for (const inner of PHRASE_FAMILIES) {
      for (const outer of PHRASE_FAMILIES) {
        if (inner.id === outer.id) continue;
        for (const lang of ["en", "ar"] as const) {
          for (const i of inner[lang]) {
            for (const o of outer[lang]) {
              const [iv, ov] = [i.replace("{value}", "").trim(), o.replace("{value}", "").trim()];
              if (iv !== ov && wordSequenceMatches(ov, iv).length) pairs.add(`${inner.id} ⊂ ${outer.id}`);
            }
          }
        }
      }
    }
    expect([...pairs].sort()).toEqual(PHRASE_OVERLAPS.map((o) => `${o.inner} ⊂ ${o.outer}`).sort());
  });

  it("D2 inside D1 counts — both directions", () => {
    expect(kindOf("Conditions apply", "تطبق الشروط والأحكام")).toBe("present");
    expect(kindOf("تطبق الشروط", "Terms and conditions apply")).toBe("present");
  });

  it("D11 with 'without notice' counts", () => {
    expect(kindOf("Prices are subject to change", "الأسعار قابلة للتغيير دون إشعار مسبق")).toBe("present");
    expect(kindOf("Prices are subject to change", "الأسعار قابلة للتغيير بدون إشعار مسبق")).toBe("present");
    expect(kindOf("الأسعار قابلة للتغيير", "Prices are subject to change without prior notice")).toBe("present");
  });

  it("C15 with 'now' counts; C1 followed by a promotional clause counts", () => {
    expect(kindOf("Download the app", "حمّل التطبيق الآن")).toBe("present");
    expect(kindOf("Book now", "احجز الآن واحصل على خصم ٢٠٪")).toBe("present");
  });

  it("D13 inside D14 → Needs a human check — both directions", () => {
    expect(kindOf("Per person", "للشخص الواحد على أساس غرفة مزدوجة")).toBe("needs_check");
    expect(kindOf("للشخص الواحد", "Per person, twin sharing")).toBe("needs_check");
  });

  it("C7b inside C7 → Needs a human check — both directions", () => {
    expect(kindOf("Call us", "اتصل بنا الآن")).toBe("needs_check");
    expect(kindOf("اتصل بنا", "Call us now")).toBe("needs_check");
  });

  it("C8 inside C9 → Needs a human check", () => {
    expect(kindOf("Contact us", "تواصل معنا عبر واتساب")).toBe("needs_check");
    expect(kindOf("Contact us", "تواصل معنا عبر الواتساب")).toBe("needs_check");
  });

  it("the shorter phrase on its own still matches", () => {
    expect(kindOf("Call us", "اتصل بنا")).toBe("present");
    expect(kindOf("Per person", "للشخص الواحد")).toBe("present");
    expect(kindOf("Contact us", "تواصل معنا")).toBe("present");
  });

  it("unlisted legal extensions → Needs a human check, never an automatic pass", () => {
    expect(kindOf("Per person", "للشخص الواحد في الليلة")).toBe("needs_check");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة باستثناء الرسوم")).toBe("needs_check");
    expect(kindOf("Non-refundable", "غير قابل للاسترداد أو التحويل")).toBe("needs_check");
    expect(kindOf("Conditions apply", "تطبق الشروط والأحكام باستثناء العطل")).toBe("needs_check"); // after the longer D1 too
  });

  it("legal wording that ends the clause, or is followed by another approved phrase, is complete", () => {
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة.")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، احجز الآن")).toBe("present");
    expect(kindOf("Terms and conditions apply", "تطبق الشروط والأحكام حتى نفاد الكمية")).toBe("present");
    expect(kindOf("Starting from AED 99", "ابتداءً من ٩٩ درهم للشخص الواحد")).toBe("present");
  });

  it("a date / price phrase with more wording after its value → Needs a human check", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦ أو حتى انتهاء الموسم")).toBe("needs_check");
  });

  it("end to end: an overlap is never passed — Needs a human check, even for optional items", () => {
    const cta = brief("cta", "Call us", ["اتصل بنا الآن"]);
    expect(cta.status).toBe("unverified");
    expect(isHumanCheck(cta)).toBe(true);
    expect(cta.explanation).toContain("as part of a longer phrase");
    const optional = brief("required_text", "Per person", ["للشخص الواحد على أساس غرفة مزدوجة"], { mandatory: false });
    expect(optional.status).toBe("unverified");
    const legal = disclaimer("Prices include VAT", ["الأسعار شاملة ضريبة القيمة المضافة باستثناء الرسوم"], { mandatory: false });
    expect([legal.status, legal.explanation.includes("with more wording after it")]).toEqual(["unverified", true]);
    const goldenCta = goldenRule("approved_cta", "Contact us", read("تواصل معنا عبر واتساب"));
    expect(goldenCta.status).toBe("unverified");
    expect(goldenCta.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
  });
});

describe("Fix 3 — a date / price on the line after the phrase", () => {
  it("correct value at the start of the next line → present; a different one → wrong", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى\n٣١ ديسمبر ٢٠٢٦")).toBe("present");
    expect(kindOf("Starting from AED 99", "ابتداءً من\n٩٩ درهم")).toBe("present");
    expect(matchEquivalent("Offer valid until 31 Dec 2026", ["العرض ساري حتى\n٣٠ ديسمبر ٢٠٢٦"])).toMatchObject({ kind: "value_differs", shown: "العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦" });
    expect(kindOf("Starting from AED 99", "ابتداءً من\n١٢٠ درهم")).toBe("value_differs");
    expect(kindOf("العرض ساري حتى ٣١ ديسمبر ٢٠٢٦", "Offer ends\n31 December 2026")).toBe("present");
  });

  it("only when the next line BEGINS with the value; never further away", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى\nحتى ٣١ ديسمبر ٢٠٢٦")).toBeNull();
    expect(kindOf("Starting from AED 99", "ابتداءً من\nفقط ٩٩ درهم")).toBeNull();
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى\nاحجز الآن\n٣١ ديسمبر ٢٠٢٦")).toBeNull();
    expect(kindOf("Starting from AED 99", "ابتداءً من\nاتصل بنا\n٩٩ درهم")).toBeNull();
  });

  it("a value on the phrase's own line is used first (the next line isn't looked at)", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦\n٣٠ ديسمبر ٢٠٢٦")).toBe("present");
  });

  it("A4 reading order: the date block listed BEFORE the phrase block still follows it on the design", () => {
    const at = (y: number): Box => ({ x: 0.2, y, w: 0.6, h: 0.04 });
    const d = detections({ texts: [text("٣١ ديسمبر ٢٠٢٦", { box: at(0.56) }), text("العرض ساري حتى", { box: at(0.5) })], textCoverage: 0.95 });
    const [f] = byRule(run({ requirements: [requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false })], detections: d }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("no positions: the listed order is used (fallback)", () => {
    expect(brief("required_text", "Offer valid until 31 Dec 2026", ["العرض ساري حتى", "٣١ ديسمبر ٢٠٢٦"], { mandatory: false }).status).toBe("passed");
    const wrong = brief("required_text", "Offer valid until 31 Dec 2026", ["العرض ساري حتى", "٣٠ ديسمبر ٢٠٢٦"], { mandatory: false });
    expect([wrong.status, wrong.detected]).toEqual(["failed", "العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦"]);
  });
});

describe("Fix 4 — negation: more words, immediately before only", () => {
  it.each(["don't", "doesn't", "won't", "isn't", "aren't", "can't", "cannot", "don’t"])("English '%s' right before the phrase breaks it", (word) => {
    expect(kindOf("احجز الآن", `${word} book now`)).toBeNull();
  });

  it.each(["بدون", "دون", "بلا", "ما", "مو", "مش", "مب"])("Arabic '%s' right before the phrase breaks it", (word) => {
    expect(kindOf("Terms and conditions apply", `${word} تطبق الشروط والأحكام`)).toBeNull();
  });

  it("punctuation between the word and the phrase: not a negation of it (no false failure)", () => {
    expect(kindOf("Terms and conditions apply", "لا، تطبق الشروط والأحكام")).toBe("present");
    expect(kindOf("احجز الآن", "No, book now")).toBe("present");
    expect(kindOf("احجز الآن", "Don't wait — book now")).toBe("present");
    expect(kindOf("Book now", "ما تنتظر؟ احجز الآن")).toBe("present");
  });

  it("a negation word further back is not looked at (immediately-before only, as approved)", () => {
    expect(kindOf("احجز الآن", "Don't forget to book now")).toBe("present");
  });

  it("approved phrases that themselves start with one of these words still work", () => {
    expect(kindOf("While stocks last", "ما دامت الكمية متوفرة")).toBe("present");
    expect(kindOf("Prices exclude VAT", "لا تشمل ضريبة القيمة المضافة")).toBe("present");
    expect(kindOf("Cannot be combined with other offers", "لا يُجمع مع عروض أخرى")).toBe("present");
  });
});

describe("Second review fix 1 — exceptions after punctuation", () => {
  it("an exception after a comma (Arabic or Western), full stop, dash, semicolon or bracket → Needs a human check", () => {
    for (const shown of [
      "الأسعار شاملة ضريبة القيمة المضافة، باستثناء الرسوم",
      "الأسعار شاملة ضريبة القيمة المضافة, باستثناء الرسوم",
      "الأسعار شاملة ضريبة القيمة المضافة. باستثناء الرسوم",
      "الأسعار شاملة ضريبة القيمة المضافة – باستثناء الرسوم",
      "الأسعار شاملة ضريبة القيمة المضافة؛ ما عدا الرسوم",
      "الأسعار شاملة ضريبة القيمة المضافة (باستثناء الرسوم)",
      "الأسعار شاملة ضريبة القيمة المضافة، بإستثناء الرسوم", // hamza form folds to the same word
    ]) {
      expect(kindOf("Prices include VAT", shown), shown).toBe("needs_check");
    }
    for (const shown of ["Prices include VAT, except service charges", "Prices include VAT - excluding fees", "Prices include VAT (Excluding fees)"]) {
      expect(kindOf("الأسعار شاملة ضريبة القيمة المضافة", shown), shown).toBe("needs_check");
    }
  });

  it("the review example, end to end: Needs a human check, not Pass", () => {
    const f = disclaimer("Prices include VAT", ["الأسعار شاملة ضريبة القيمة المضافة، باستثناء الرسوم"], { mandatory: false });
    expect(f.status).toBe("unverified");
    expect(isHumanCheck(f)).toBe(true);
    expect(f.detected).toBe("الأسعار شاملة ضريبة القيمة المضافة باستثناء الرسوم");
  });

  it("also after the value of a date / price phrase, and after a longer phrase that counts (D2 in D1)", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦، باستثناء العطل")).toBe("needs_check");
    expect(kindOf("Starting from AED 99", "ابتداءً من ٩٩ درهم، except weekends")).toBe("needs_check");
    expect(kindOf("Conditions apply", "تطبق الشروط والأحكام، ما عدا العروض الخاصة")).toBe("needs_check");
  });

  it("ordinary approved wording after punctuation still passes", () => {
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة.")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، احجز الآن")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، تطبق الشروط والأحكام")).toBe("present");
    expect(kindOf("Terms and conditions apply", "تطبق الشروط والأحكام، حتى نفاد الكمية")).toBe("present");
    expect(kindOf("Prices are subject to change", "الأسعار قابلة للتغيير دون إشعار مسبق.")).toBe("present");
  });

  it("an exception word that doesn't START the later clause, or is on another line, isn't picked up", () => {
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، العرض للجميع باستثناء")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة\nباستثناء الرسوم")).toBe("present");
  });

  it("calls to action are unchanged (exceptions are a legal-wording rule)", () => {
    expect(kindOf("Book now", "احجز الآن، باستثناء أيام العطل")).toBe("present");
  });
});

describe("Second review fix 2 — negations joined to و", () => {
  it.each(["ولا", "وبدون", "ولم", "ولن", "وليس", "وغير", "ودون", "وبلا", "وما", "ومو", "ومش", "ومب"])(
    "'%s' right before the phrase breaks it — no automatic pass",
    (word) => {
      expect(kindOf("Subject to availability", `العرض ${word} حسب التوفر`)).toBeNull();
      expect(kindOf("Terms and conditions apply", `${word} تطبق الشروط والأحكام`)).toBeNull();
    }
  );

  it("the review example: 'ولا حسب التوفر' no longer matches", () => {
    expect(kindOf("Subject to availability", "العرض غير مرتبط بأي شرط ولا حسب التوفر")).toBeNull();
  });

  it("end to end: never passed (the English requirement stays not found)", () => {
    const f = disclaimer("Subject to availability", ["العرض ولا حسب التوفر"], { mandatory: false });
    expect(f.status).toBe("failed");
  });

  it("ordinary words joined to و before a phrase are not negations (no false failure)", () => {
    // "واحجز" is the CTA's own verb with و joined — not a listed form (an existing limitation, unrelated to negation).
    expect(kindOf("Book now", "سارع واحجز الآن")).toBeNull();
    expect(kindOf("Subject to availability", "العرض ومتوفر حسب التوفر")).toBe("present");
    expect(kindOf("Book now", "وفر اليوم احجز الآن")).toBe("present"); // وفر (save) starts with و but isn't a negation
    expect(kindOf("Terms and conditions apply", "وأيضاً تطبق الشروط والأحكام")).toBe("present");
  });

  it("approved phrases that begin with لا or ما still match — on their own and after ordinary words", () => {
    expect(kindOf("Prices exclude VAT", "لا تشمل ضريبة القيمة المضافة")).toBe("present");
    expect(kindOf("Prices exclude VAT", "الأسعار لا تشمل ضريبة القيمة المضافة")).toBe("present");
    expect(kindOf("Cannot be combined with other offers", "لا يمكن الجمع بين هذا العرض وأي عرض آخر")).toBe("present");
    expect(kindOf("Cannot be combined with other offers", "العرض لا يسري مع العروض الأخرى")).toBe("present");
    expect(kindOf("While stocks last", "ما دامت الكمية متوفرة")).toBe("present");
    expect(kindOf("While stocks last", "العرض متاح ما دامت الكمية متوفرة")).toBe("present");
  });

  it("…but a negation right before them still breaks them", () => {
    expect(kindOf("While stocks last", "ولا ما دامت الكمية متوفرة")).toBeNull();
    expect(kindOf("Prices exclude VAT", "ولم لا تشمل ضريبة القيمة المضافة")).toBeNull();
  });

  it("punctuation between a و-negation and the phrase: not a negation of it", () => {
    expect(kindOf("Terms and conditions apply", "ولا، تطبق الشروط والأحكام")).toBe("present");
  });
});

describe("Final adjustment — exceptions with و joined (وباستثناء, وما عدا)", () => {
  it("behave exactly like باستثناء / ما عدا, after any punctuation → Needs a human check", () => {
    for (const exception of ["وباستثناء الرسوم", "وما عدا الرسوم", "وبإستثناء الرسوم"]) {
      for (const mark of ["،", ",", ".", "؛", " –", " ("]) {
        const shown = `الأسعار شاملة ضريبة القيمة المضافة${mark} ${exception}`;
        expect(kindOf("Prices include VAT", shown), shown).toBe("needs_check");
      }
    }
  });

  it("…and with no punctuation (more words in the same clause), as before", () => {
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة وباستثناء الرسوم")).toBe("needs_check");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة وما عدا الرسوم")).toBe("needs_check");
  });

  it("after a date / price value and after a longer phrase that counts (D2 in D1)", () => {
    expect(kindOf("Offer valid until 31 Dec 2026", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦، وباستثناء العطل")).toBe("needs_check");
    expect(kindOf("Starting from AED 99", "ابتداءً من ٩٩ درهم، وما عدا عطلة نهاية الأسبوع")).toBe("needs_check");
    expect(kindOf("Conditions apply", "تطبق الشروط والأحكام، وباستثناء العروض الخاصة")).toBe("needs_check");
  });

  it("end to end: a disclaimer with 'وباستثناء' after a comma is Needs a human check, not Pass", () => {
    const f = disclaimer("Prices include VAT", ["الأسعار شاملة ضريبة القيمة المضافة، وباستثناء الرسوم"], { mandatory: false });
    expect(f.status).toBe("unverified");
    expect(isHumanCheck(f)).toBe(true);
  });

  it("ordinary wording is unaffected: other و-words after punctuation still pass; the exception must START the clause", () => {
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، وتطبق الشروط والأحكام")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، وما زال العرض متاحاً")).toBe("present"); // وما + another word
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة، والعرض للجميع وباستثناء")).toBe("present");
    expect(kindOf("Prices include VAT", "الأسعار شاملة ضريبة القيمة المضافة\nوباستثناء الرسوم")).toBe("present"); // another line
    expect(kindOf("Book now", "احجز الآن، وباستثناء أيام العطل")).toBe("present"); // CTAs: legal-only rule
  });

  it("the same-language و-attached CTA limitation is unchanged", () => {
    expect(kindOf("Book now", "سارع واحجز الآن")).toBeNull();
  });
});
