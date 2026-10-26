import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import { patternCandidates } from "@/lib/analysis/information";
import {
  capitalizationDifference,
  containsText,
  datesWrittenOneWay,
  findDates,
  findName,
  findPercentages,
  findPrices,
  findTimes,
  normalizeWords,
  oldPrices,
  parsePrice,
} from "@/lib/qc/compare";
import { consolidateFindings } from "@/lib/qc/consolidate";
import type { ContentDetections } from "@/lib/qc/detections";
import type { Finding } from "@/lib/qc/findings";
import type { QcContext } from "@/lib/qc/rules/context";
import { resultDisplay, scoreFindings } from "@/lib/qc/scoring";
import { byRule, company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 — text and value matching (3.1–3.9): the same words and values compare equal however they're
 * written, and different ones never do. Each block names the problem it guards against.
 */

const counted = (fs: Finding[]) => fs.filter((f) => f.status === "failed");
/** What the app does: rules → confidence policy → consolidate. */
function results(over: Partial<QcContext>, provider: "google" | "gemini" = "google") {
  const d = (over.detections ?? null) as ContentDetections | null;
  return consolidateFindings(applyConfidencePolicy(run(over), d, { state: "done" }, { provider }));
}
const read = (words: string, over = {}) => detections({ texts: [text(words, over)], textCoverage: 0.95 });

describe("3.1 a possessive is the name itself, not a misspelling", () => {
  it("'Villas's' and 'Villas’' are the company name and the approved term, exactly", () => {
    for (const shown of ["Discover Skybook Villas's new homes", "Discover Skybook Villas’ new homes", "Skybook Villas’s offer"]) {
      expect([shown, findName(shown, "Skybook Villas").status]).toEqual([shown, "exact"]);
      const fs = results({ detections: read(shown) });
      expect([shown, counted(fs).map((f) => f.ruleId)]).toEqual([shown, []]);
    }
  });

  it("real misspellings are still flagged", () => {
    expect(findName("Discover Skybok Villas", "Skybook Villas")).toMatchObject({ status: "misspelt" });
    expect(counted(results({ detections: read("Discover Skybok Villas") })).map((f) => f.ruleId)).toContain("content.company_name");
  });
});

describe("3.2 a different number is a wrong value, not a misspelling", () => {
  it("'iPhone 15' for 'iPhone 16' is a different value; the same model still matches", () => {
    expect(findName("Get the iPhone 15 today", "iPhone 16")).toEqual({ status: "different", found: "iphone 15" });
    expect(findName("Galaxy S24 Ultra in stock", "Galaxy S24 Ultra")).toEqual({ status: "exact" });
    expect(findName("Get the iPhon 16 today", "iPhone 16")).toMatchObject({ status: "misspelt" }); // a typo, same number
  });

  it("brief: shown as the content showing a different value, never 'written differently'", () => {
    const [f] = byRule(run({ requirements: [requirement("product_name", "iPhone 16", { mandatory: false })], detections: read("Get the iPhone 15 today") }), "brief.requirement");
    expect(f).toMatchObject({ status: "failed", severity: "major", detected: "iphone 15" });
    expect(f.explanation).toMatch(/different product name/);
    expect(f.explanation).not.toMatch(/written differently/);
  });

  it("mandatory: the existing process — a clear text reading counts, AI evidence goes to a person as a possible critical issue", () => {
    const req = [requirement("product_name", "iPhone 16", { mandatory: true })];
    const ocr = byRule(results({ requirements: req, detections: read("Get the iPhone 15 today") }, "google"), "brief.requirement");
    expect(ocr[0]).toMatchObject({ status: "failed", severity: "critical" });
    const gemini = results({ requirements: req, detections: read("Get the iPhone 15 today", { confidence: 0.9 }) }, "gemini");
    const g = byRule(gemini, "brief.requirement")[0];
    expect(g).toMatchObject({ status: "unverified", severity: "critical" });
    expect(g.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(resultDisplay(scoreFindings(gemini))).toBe("check_before_sending");
  });

  it("the company name with other numbers is another name (not checked); a Golden Rule product name says it's a different product", () => {
    const studio = company({ company: { ...company().company, name: "Studio 54" }, brand: { ...company().brand, terms: [] } });
    expect(byRule(run({ company: studio, detections: read("Welcome to Studio 55") }), "content.company_name")[0].status).toBe("not_applicable");
    const rule = company({ goldenRules: [golden({ category: "approved_product_name", approved_value: "iPhone 16", mandatory: false })] });
    const [g] = byRule(run({ company: rule, detections: read("Get the iPhone 15 today") }), "golden_rules");
    expect(g).toMatchObject({ status: "failed", detected: "iphone 15" });
    expect(g.explanation).toMatch(/different product/);
  });
});

describe("3.3 Arabic (and Hindi) words compare equal however they're written", () => {
  it("vowel marks, alef forms, alef maqsura and tatweel don't matter; teh marbuta stays its own letter", () => {
    expect(normalizeWords("مَرْحَبًا")).toBe("مرحبا");
    expect(containsText("مَرْحَبًا بكم", "مرحبا")).toBe(true);
    expect(containsText("أهلا وسهلا", "اهلا وسهلا")).toBe(true);
    expect(containsText("إلى دبي", "الي دبي")).toBe(true);
    expect(containsText("عـــرض", "عرض")).toBe(true);
    expect(containsText("مدرسة", "مدرسه")).toBe(false); // ة is not ه
    expect(containsText("عرض الصيف", "عرض الشتاء")).toBe(false); // different words stay different
  });

  it("Hindi letters with their vowel signs stay one word", () => {
    expect(normalizeWords("नमस्ते दुबई")).toBe("नमस्ते दुबई");
    expect(containsText("नमस्ते दुबई", "नमस्ते")).toBe(true);
    expect(containsText("कम", "काम")).toBe(false);
  });

  it("an Arabic disclaimer Golden Rule and an Arabic brief headline pass end to end with vowel marks on the design", () => {
    const c = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "تطبق الشروط والأحكام" })] });
    const fs = results({ company: c, requirements: [requirement("headline", "عرض الصيف")], detections: read("عَرْضُ الصَّيْفِ — تُطَبَّقُ الشُّرُوطُ وَالْأَحْكَامُ") });
    expect(byRule(fs, "golden_rules")[0].status).toBe("passed");
    expect(byRule(fs, "brief.requirement")[0].status).toBe("passed");
  });
});

describe("3.4 '&' is the word 'and'", () => {
  it("'T&C apply' = 'T and C apply' = 'T & C apply'", () => {
    for (const shown of ["T and C apply", "T & C apply", "T&C apply"]) expect([shown, containsText(shown, "T&C apply")]).toEqual([shown, true]);
    expect(containsText("Terms & conditions apply", "Terms and conditions apply")).toBe(true);
  });

  it("the capitals check is unchanged: real capitals differences only", () => {
    expect(capitalizationDifference("T&C Apply", "T&C apply")).toBe("T&C Apply");
    expect(capitalizationDifference("T and C apply", "T&C apply")).toBeNull(); // & ↔ and, same capitals
    expect(capitalizationDifference("T&C APPLY", "T&C apply")).toBeNull(); // ALL CAPS styling
    expect(capitalizationDifference("T and C Apply", "T&C apply")).toBe("T and C Apply");
  });

  it("a brief disclaimer 'T&C apply' passes on 'T and C apply'", () => {
    const [f] = byRule(run({ requirements: [requirement("disclaimer", "T&C apply")], detections: read("Book now. T and C apply") }), "legal.disclaimer");
    expect(f.status).toBe("passed");
  });
});

describe("3.5 Arabic-Indic prices and Arabic currency words", () => {
  it("'١٬٢٩٩ درهم' is AED 1,299, shown as written; '٢٠٪' is 20%", () => {
    expect(findPrices("فقط ١٬٢٩٩ درهم")).toEqual([{ amount: 1299, currency: "AED", text: "١٬٢٩٩ درهم" }]);
    expect(findPrices("١٬٢٩٩ د.إ")).toMatchObject([{ amount: 1299, currency: "AED" }]);
    expect(findPrices("٤٥٠ ر.س")).toMatchObject([{ amount: 450, currency: "SAR" }]);
    expect(findPercentages("خصم ٢٠٪")).toEqual([20]);
    expect(parsePrice("١٢٩٩")).toMatchObject({ amount: 1299 });
  });

  it("a bilingual brief and design match in either digit style", () => {
    for (const [briefValue, shown] of [["AED 1,299", "فقط ١٬٢٩٩ درهم"], ["١٬٢٩٩ درهم", "Only AED 1,299"], ["20%", "خصم ٢٠٪"]] as const) {
      const type = briefValue.includes("%") ? "percentage" : "price";
      const [f] = byRule(run({ requirements: [requirement(type, briefValue)], detections: read(shown) }), "brief.requirement");
      expect([briefValue, shown, f.status]).toEqual([briefValue, shown, "passed"]);
    }
  });

  it("brief extraction finds Arabic prices too, keeping their own text", () => {
    expect(patternCandidates("السعر: ١٬٢٩٩ درهم").filter((c) => c.type === "price").map((c) => c.value)).toEqual(["١٬٢٩٩ درهم"]);
  });
});

describe("3.6 a price is never a time", () => {
  it("'AED 12.50' and '$7.30' aren't times; real times still are", () => {
    expect(findTimes("Only AED 12.50 per day")).toEqual([]);
    expect(findTimes("From $7.30")).toEqual([]);
    expect(findTimes("Doors 7 PM, show 19:30, ends 11.15 p.m.")).toEqual([19 * 60, 19 * 60 + 30, 23 * 60 + 15]);
    expect(findTimes("Opens 7.30pm")).toEqual([19 * 60 + 30]);
  });

  it("a word ending in a currency's letters isn't a currency ('Doors 7' isn't 'Rs 7')", () => {
    expect(findPrices("Doors 7 PM")).toEqual([]);
    expect(findPrices("Only Rs 7")).toMatchObject([{ amount: 7, currency: "INR" }]);
    // …so no phantom "unexpected price" either.
    expect(counted(byRule(run({ requirements: [requirement("time", "7 PM")], detections: read("Doors 7 PM") }), "brief"))).toEqual([]);
  });

  it("brief: a time requirement isn't matched or contradicted by a price", () => {
    const [f] = byRule(run({ requirements: [requirement("time", "12:50")], detections: read("Only AED 12.50") }), "brief.requirement");
    expect(f).toMatchObject({ status: "failed", detected: "Not found" });
  });
});

describe("3.7 an offer's old price isn't a stray price", () => {
  const unexpected = (shown: string, brief = "AED 1,299") => byRule(run({ requirements: [requirement("price", brief)], detections: read(shown) }), "brief.unexpected");

  it("'Was AED 1,500 now AED 1,299' and Arabic 'بدلاً من' → not counted, and the pass says why", () => {
    for (const shown of ["Was AED 1,500 now AED 1,299", "Now AED 1,299 (was AED 1,500)", "AED 1,299 instead of AED 1,500", "Regular price AED 1,500 — now AED 1,299", "١٬٢٩٩ درهم بدلاً من ١٬٥٠٠ درهم"]) {
      const [f] = unexpected(shown);
      expect([shown, f.status]).toEqual([shown, "passed"]);
      expect(f.explanation).toMatch(/old price/);
    }
    expect(oldPrices("Was AED 1,500 now AED 1,299").map((p) => p.text)).toEqual(["AED 1,500"]);
  });

  it("still counted: a stray price with no old-price word, an 'old' price lower than the new one, or an old price without the brief's price", () => {
    expect(unexpected("Now AED 1,299 · AED 999").map((f) => [f.status, f.detected])).toEqual([["failed", "AED 999"]]);
    expect(unexpected("Was AED 999 now AED 1,299").map((f) => [f.status, f.detected])).toEqual([["failed", "AED 999"]]);
    // The brief's price isn't shown: the wrong price is reported once, under its requirement.
    const noBrief = run({ requirements: [requirement("price", "AED 1,299")], detections: read("Was AED 1,500 now AED 1,199") });
    expect(counted(byRule(noBrief, "brief")).map((f) => f.ruleId)).toEqual(["brief.requirement.price"]);
  });
});

describe("3.8 thousands separators by currency", () => {
  it("'EUR 1.299' is 1,299; 'KWD / BHD / OMR 1.299' stay 1.299 (three-decimal currencies)", () => {
    expect(findPrices("EUR 1.299")).toMatchObject([{ amount: 1299, currency: "EUR" }]);
    expect(findPrices("AED 1.299")).toMatchObject([{ amount: 1299 }]);
    for (const c of ["KWD", "BHD", "OMR"]) expect(findPrices(`${c} 1.299`)).toMatchObject([{ amount: 1.299, currency: c }]);
    expect(findPrices("KWD 1,299.500")).toMatchObject([{ amount: 1299.5 }]);
  });

  it("'1.299,50' and '1,299.50' are the same amount; plain decimals unchanged", () => {
    expect(findPrices("EUR 1.299,50")).toMatchObject([{ amount: 1299.5 }]);
    expect(findPrices("$1,299.50")).toMatchObject([{ amount: 1299.5 }]);
    expect(findPrices("EUR 12,50")).toMatchObject([{ amount: 12.5 }]);
    expect(findPrices("$49.99")).toMatchObject([{ amount: 49.99 }]);
    expect(findPrices("AED 1,299")).toMatchObject([{ amount: 1299 }]);
  });
});

describe("3.9 a date without a year matches the brief's date, but is never an unexpected one", () => {
  it("a brief '18/10' matches '18/10/2026' and '18 October'; the design's '18/10' matches a brief '18 Oct 2026'", () => {
    for (const shown of ["Valid till 18/10/2026", "Valid till 18 October", "Valid till 18/10"]) {
      const [f] = byRule(run({ requirements: [requirement("date", "18/10")], detections: read(shown) }), "brief.requirement");
      expect([shown, f.status]).toEqual([shown, "passed"]);
    }
    const [f] = byRule(run({ requirements: [requirement("date", "18 Oct 2026")], detections: read("Ends 18/10") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("'24/7', '3/4' and prices are never unexpected dates; full numeric dates still are", () => {
    const unexpectedDates = (shown: string) => counted(byRule(run({ detections: read(shown) }), "brief.unexpected")).filter((f) => /date/.test(f.expected ?? ""));
    for (const shown of ["Open 24/7", "Serves 3/4 people", "Only AED 12.50"]) expect([shown, unexpectedDates(shown)]).toEqual([shown, []]);
    expect(findDates("Open 24/7")).toEqual([]);
    expect(findDates("Open 24/7", { withoutYear: true })).toEqual([[{ day: 24, month: 7 }]]);
    expect(unexpectedDates("Ends 18/10/2026").map((f) => f.detected)).toEqual(["18/10/2026"]);
  });
});

describe("cross-checks: two companies, both content types, Stage 2 and the safeguards unchanged", () => {
  const bilingual = () =>
    company({
      company: { ...company().company, id: "c0000000-0000-4000-8000-000000000003", name: "Al Noor Travel" },
      brand: { ...company().brand, terms: [{ ...company().brand.terms[0], term: "Al Noor Travel" }] },
      goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "تطبق الشروط والأحكام", mandatory: true })],
    });

  for (const contentType of ["design_poster", "social_post"] as const) {
    it(`${contentType}: an English brand's possessive and a bilingual brand's Arabic design have no false issues`, () => {
      const english = results({ contentType, requirements: [requirement("price", "AED 1,299", { id: "p" })], detections: read("Skybook Villas's summer offer: AED 1,299. T and C apply") });
      expect(counted(english).map((f) => f.ruleId)).toEqual([]);
      const arabic = results({
        contentType,
        company: bilingual(),
        requirements: [requirement("price", "AED 1,299", { id: "p" }), requirement("percentage", "٢٠٪", { id: "o" })],
        detections: read("Al Noor Travel's offer — ٢٠٪ خصم — فقط ١٬٢٩٩ درهم بدلاً من ١٬٥٠٠ درهم — تُطَبَّقُ الشُّرُوطُ وَالْأَحْكَامُ"),
      });
      expect(counted(arabic).map((f) => f.ruleId)).toEqual([]);
    });
  }

  it("Stage 2: overlapping brief values written in different digit styles are still one issue", () => {
    // The same words, Western and Arabic-Indic digits: "AED 1,299" inside "From AED ١٬٢٩٩".
    const fs = results({ requirements: [requirement("price", "AED 1,299", { id: "a" }), requirement("required_text", "From AED ١٬٢٩٩", { id: "b" })], detections: read("Now AED 1,499") });
    const brief = counted(byRule(fs, "brief"));
    expect(brief).toHaveLength(1);
    expect(brief[0].alsoCovers?.map((c) => c.requirementId)).toEqual(["a"]);
  });

  it("the confidence policy still matches Arabic text to its reading (an unsure reading is a human check, not a fact)", () => {
    // A slightly different Arabic text (one letter extra), read unsurely: the policy finds the reading
    // behind it — vowel marks and all — and sends it to a person instead of counting it.
    const req = [requirement("required_text", "عرض الصيف المميز", { mandatory: false })];
    const policy = (confidence: number) => {
      const d = detections({ texts: [text("عَرْضُ الصَّيْفِ المميزز", { confidence })], textCoverage: 0.95 });
      return byRule(applyConfidencePolicy(run({ requirements: req, detections: d }), d, { state: "done" }, { provider: "google" }), "brief.requirement")[0];
    };
    expect(policy(0.5)).toMatchObject({ status: "unverified", detected: "عرض الصيف المميزز" });
    expect(policy(0.95)).toMatchObject({ status: "failed", severity: "minor" }); // an optional item's typo: MINOR
  });
});

describe("Stage 3 review: values written inside a brief's wording aren't 'unexpected'", () => {
  const unexpected = (reqs: ReturnType<typeof requirement>[], shown: string) =>
    counted(byRule(run({ requirements: reqs, detections: read(shown) }), "brief.unexpected")).map((f) => [f.detected, f.severity]);

  it("brief offer '20% off', design '20%': not unexpected; another percentage still is (major — the brief has one)", () => {
    expect(unexpected([requirement("offer", "20% off")], "Summer sale — 20% off everything")).toEqual([]);
    expect(unexpected([requirement("offer", "20% off")], "Summer sale — 20% off, extra 10% online")).toEqual([["10%", "major"]]);
    expect(unexpected([requirement("required_text", "خصم ٢٠٪")], "خصم 20%")).toEqual([]);
  });

  it("the same for a price or a date written in the brief's words", () => {
    expect(unexpected([requirement("required_text", "From AED 1,299")], "From AED 1,299 per person")).toEqual([]);
    expect(unexpected([requirement("required_text", "From AED 1,299")], "From AED 1,299, kids AED 499")).toEqual([["AED 499", "major"]]);
    expect(unexpected([requirement("offer", "Valid until 31 Dec 2026")], "Valid until 31/12/2026")).toEqual([]);
  });

  it("descriptive brief items (instructions, audience…) never make a value expected", () => {
    expect(unexpected([requirement("special_instruction", "Don't show the 30% discount"), requirement("price", "AED 99")], "AED 99 — 30% off")).toEqual([["30%", "minor"]]);
  });

  it("with no brief at all, a percentage is still flagged (minor — the brief doesn't give one)", () => {
    expect(unexpected([], "Save 15%")).toEqual([["15%", "minor"]]);
  });
});

describe("Stage 3 review: one wrong value in a brief's wording is reported once", () => {
  it("brief offer '20% off', design '25% off': the offer's wrong value only — not again as an unexpected percentage", () => {
    const fs = run({ requirements: [requirement("offer", "20% off", { mandatory: false })], detections: read("Summer sale — 25% off") });
    expect(counted(byRule(fs, "brief")).map((f) => [f.ruleId, f.detected])).toEqual([["brief.requirement.offer", "25% off"]]);
    expect(byRule(fs, "brief.unexpected")[0].status).toBe("not_applicable"); // says it's reported above, doesn't claim a pass
  });

  it("…but an extra percentage beside the right one is still unexpected", () => {
    const fs = run({ requirements: [requirement("offer", "20% off", { mandatory: false })], detections: read("20% off — and 10% cashback") });
    expect(counted(byRule(fs, "brief")).map((f) => [f.ruleId, f.detected])).toEqual([["brief.unexpected", "10%"]]);
  });
});

describe("Stage 3 review: emoji marks are not words", () => {
  it("'Book now ➡️', 'Love it ❤️' and '1️⃣ day only' still match their plain words", () => {
    expect(normalizeWords("Book now ➡️")).toBe("book now");
    expect(containsText("Love it ❤️ — book now", "Love it")).toBe(true);
    expect(normalizeWords("1️⃣ day only")).toBe("1 day only");
    expect(byRule(run({ requirements: [requirement("cta", "Book now")], detections: read("Book now ➡️", { role: "cta" }) }), "brief.requirement")[0].status).toBe("passed");
    expect(capitalizationDifference("T&C apply ✅️ Book now", "T&C apply")).toBeNull();
  });
});

describe("Stage 3 final review: a wrong value in the brief's wording doesn't hide a different extra value", () => {
  it("offer '20% off' shown as '25% off', plus '10% cashback': the offer is wrong AND 10% is still unexpected", () => {
    const fs = run({ requirements: [requirement("offer", "20% off", { mandatory: false })], detections: read("Summer sale — 25% off, and 10% cashback") });
    expect(counted(byRule(fs, "brief")).map((f) => [f.ruleId, f.detected])).toEqual([
      ["brief.requirement.offer", "25% off"],
      ["brief.unexpected", "10%"],
    ]);
  });

  it("the same for prices and dates in the brief's wording", () => {
    const prices = run({ requirements: [requirement("required_text", "From AED 1,299", { mandatory: false })], detections: read("From AED 1,499 — kids AED 499") });
    expect(counted(byRule(prices, "brief")).map((f) => [f.ruleId, f.detected])).toEqual([
      ["brief.requirement.required_text", "from aed 1 499"],
      ["brief.unexpected", "AED 499"],
    ]);
  });
});

describe("Stage 3 final review: wrong dates in the brief's wording", () => {
  it("'Valid until 31 Dec 2026' shown as '30 Dec 2026' is one issue; another date beside it is still unexpected", () => {
    // The same wording with another date — written any way (dates in wording are compared as dates).
    for (const shown of ["Valid until 30 Dec 2026. Early bird ends 15/11/2026", "Valid until 30 Dec 2026 — early bird ends 15 Nov 2026", "Valid until 30/12/2026. Early bird ends 15/11/2026", "Valid until 30 December 2026. Early bird ends 15/11/2026"]) {
      const fs = run({ requirements: [requirement("offer", "Valid until 31 Dec 2026", { mandatory: false })], detections: read(shown) });
      const brief = counted(byRule(fs, "brief")).map((f) => f.ruleId);
      expect([shown, brief]).toEqual([shown, ["brief.requirement.offer", "brief.unexpected"]]);
      expect([shown, byRule(fs, "brief.unexpected").find((f) => f.status === "failed")?.detected]).toEqual([shown, expect.stringMatching(/^15\/11/)]);
    }
  });
});

describe("Stage 3: dates in the brief's wording are compared as dates, however they're written", () => {
  const offer = (value: string, mandatory = false) => [requirement("offer", value, { id: "o", mandatory })];
  const briefOf = (reqs: ReturnType<typeof offer>, shown: string, provider: "google" | "gemini" = "google") => byRule(results({ requirements: reqs, detections: read(shown, provider === "gemini" ? { confidence: 0.9 } : {}) }, provider), "brief");
  const FORMATS = ["31 Dec 2026", "31 December 2026", "31st December 2026", "December 31, 2026", "31/12/2026", "31-12-2026", "2026-12-31", "31.12.2026"];

  it("datesWrittenOneWay: every way of writing 31 December 2026 reads the same; the rest of the text is untouched", () => {
    for (const written of FORMATS) expect([written, datesWrittenOneWay(`Valid until ${written}!`)]).toEqual([written, "Valid until 31/12/2026!"]);
    expect(datesWrittenOneWay("Ends 31 Dec")).toBe("Ends 31/12");
    expect(datesWrittenOneWay("12/31/2026")).toBe("31/12/2026"); // month first, certain (31 > 12)
    expect(datesWrittenOneWay("03/04/2026")).toBe("3/4/2026"); // uncertain: numbers kept in the order written
    // Not dates — left alone.
    for (const other of ["Open 24/7", "Only AED 12.50", "Version 1.2", "Call 04 123 4567", "Book 2 nights"]) expect(datesWrittenOneWay(other)).toBe(other);
  });

  it("brief '31 Dec 2026': present in every format on the design — and the other way round", () => {
    for (const shown of FORMATS) {
      expect([shown, briefOf(offer("Valid until 31 Dec 2026"), `Valid until ${shown}`).map((f) => f.status)]).toEqual([shown, ["passed", "passed"]]);
      expect([shown, briefOf(offer(`Valid until ${shown}`), "Valid until 31 Dec 2026").map((f) => f.status)]).toEqual([shown, ["passed", "passed"]]);
    }
  });

  it("a genuinely different date is reported once, as WRONG — never missing plus an unexpected date", () => {
    for (const shown of ["30 Dec 2026", "30 December 2026", "30/12/2026", "December 30, 2026", "31 Jan 2027"]) {
      const fs = briefOf(offer("Valid until 31 Dec 2026"), `Valid until ${shown}`);
      const failed = counted(fs);
      expect([shown, failed.map((f) => f.ruleId)]).toEqual([shown, ["brief.requirement.offer"]]);
      expect([shown, failed[0].detected]).not.toEqual([shown, "Not found"]);
      expect([shown, failed[0].explanation]).toEqual([shown, expect.stringMatching(/different offer/)]);
      expect(fs.find((f) => f.ruleId === "brief.unexpected")?.status).toBe("not_applicable"); // reported above, not again
    }
  });

  it("a wording that doesn't give the date at all is still missing; an extra date beside the right one is still unexpected", () => {
    expect(counted(briefOf(offer("Valid until 31 Dec 2026"), "Book now")).map((f) => [f.ruleId, f.detected])).toEqual([["brief.requirement.offer", "Not found"]]);
    expect(counted(briefOf(offer("Valid until 31 Dec 2026"), "Valid until 31/12/2026. Early bird ends 15/11/2026")).map((f) => [f.ruleId, f.detected])).toEqual([["brief.unexpected", "15/11/2026"]]);
  });

  it("mandatory: a different date is critical; with Gemini it's a possible critical issue → CHECK BEFORE SENDING", () => {
    expect(counted(briefOf(offer("Valid until 31 Dec 2026", true), "Valid until 30/12/2026"))).toMatchObject([{ ruleId: "brief.requirement.offer", severity: "critical" }]);
    const gemini = results({ requirements: offer("Valid until 31 Dec 2026", true), detections: read("Valid until 30/12/2026", { confidence: 0.9 }) }, "gemini");
    expect(byRule(gemini, "brief.requirement")[0]).toMatchObject({ status: "unverified", severity: "critical" });
    expect(resultDisplay(scoreFindings(gemini))).toBe("check_before_sending");
  });

  it("a brief disclaimer with a date: the same date in another format passes; another date is reported with its own words", () => {
    const disclaimer = (shown: string) => byRule(run({ requirements: [requirement("disclaimer", "Offer valid until 31 Dec 2026")], detections: read(shown) }), "legal.disclaimer")[0];
    expect(disclaimer("Offer valid until 31/12/2026").status).toBe("passed");
    expect(disclaimer("Offer valid until 31 December 2026").status).toBe("passed");
    expect(disclaimer("Offer valid until 30/12/2026")).toMatchObject({ status: "failed", explanation: expect.stringMatching(/different numbers/) });
  });

  it("a typed date requirement and the same date in an offer: one issue when wrong (Stage 2), none when right", () => {
    const reqs = [requirement("date", "31/12/2026", { id: "d" }), requirement("offer", "Valid until 31 Dec 2026", { id: "o" })];
    expect(counted(briefOf(reqs, "Valid until 31 December 2026"))).toEqual([]);
    const wrong = counted(briefOf(reqs, "Valid until 30 December 2026"));
    expect(wrong.map((f) => f.ruleId).filter((id) => id.startsWith("brief.requirement"))).toHaveLength(1);
  });
});
