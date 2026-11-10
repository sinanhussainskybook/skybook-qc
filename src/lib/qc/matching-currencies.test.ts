import { describe, expect, it } from "vitest";
import { patternCandidates } from "@/lib/analysis/information";
import { findPrices, parsePrice, pricesMatch, type Price } from "@/lib/qc/compare";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 (designer feedback), Track A3 — prices in Gulf currencies however they're written: Arabic and
 * English full names ("ريال سعودي", "Kuwaiti dinars"), a bare "ريال" / "دينار" (a currency family), "Dhs.",
 * the Gulf abbreviations SR / QR / KD / BD / RO (capitals only), decimals ("AED 99.00" = "AED 99") and
 * trailing "/-" or "*", in Arabic or Western digits. Always shown as written. Existing behaviour unchanged.
 */

const read = (...lines: string[]) => detections({ texts: lines.map((l) => text(l)), textCoverage: 0.95 });
const price = (s: string): Price => {
  const found = findPrices(s);
  expect(found, s).toHaveLength(1);
  return found[0];
};

describe("A3 Arabic currency words", () => {
  it("a bare ريال / دينار is a currency family; with its country it's that currency — shown as written", () => {
    expect(price("٩٩ ريال")).toEqual({ amount: 99, currency: "RIYAL", text: "٩٩ ريال" });
    expect(price("٩٩ ريالاً")).toMatchObject({ amount: 99, currency: "RIYAL", text: "٩٩ ريالاً" });
    expect(price("١٠٠ ريالات")).toMatchObject({ amount: 100, currency: "RIYAL" });
    expect(price("٩٩ ريال سعودي")).toEqual({ amount: 99, currency: "SAR", text: "٩٩ ريال سعودي" });
    expect(price("٩٩ ريال قطري")).toMatchObject({ amount: 99, currency: "QAR" });
    expect(price("٩٫٩٠٠ ريال عماني")).toMatchObject({ amount: 9.9, currency: "OMR" });
    expect(price("٥ دينار")).toMatchObject({ amount: 5, currency: "DINAR" });
    expect(price("٥ دنانير")).toMatchObject({ amount: 5, currency: "DINAR" });
    expect(price("١٫٢٩٩ دينار")).toMatchObject({ amount: 1.299, currency: "DINAR" }); // dinars have three decimals
    expect(price("٥ دينار كويتي")).toMatchObject({ amount: 5, currency: "KWD" });
    expect(price("٥ دينار بحريني")).toMatchObject({ amount: 5, currency: "BHD" });
    expect(price("٩٩ درهم إماراتي")).toMatchObject({ amount: 99, currency: "AED", text: "٩٩ درهم إماراتي" });
    expect(price("٤٩ دولار")).toMatchObject({ amount: 49, currency: "USD" });
    expect(price("٤٩ دولار أمريكي")).toMatchObject({ amount: 49, currency: "USD" });
    expect(price("٥٠ يورو")).toMatchObject({ amount: 50, currency: "EUR" });
    expect(price("١٠٠ جنيه")).toMatchObject({ amount: 100, currency: "EGP" });
    expect(price("١٠٠ جنيه مصري")).toMatchObject({ amount: 100, currency: "EGP" });
  });

  it("the existing Arabic forms still work as before", () => {
    expect(price("١٬٢٩٩ درهم")).toEqual({ amount: 1299, currency: "AED", text: "١٬٢٩٩ درهم" });
    expect(price("١٬٢٩٩ د.إ")).toMatchObject({ amount: 1299, currency: "AED" });
    expect(price("٤٥٠ ر.س")).toMatchObject({ amount: 450, currency: "SAR" });
    expect(price("١٫٥٠٠ د.ك")).toMatchObject({ amount: 1.5, currency: "KWD" });
  });
});

describe("A3 English names and Gulf abbreviations", () => {
  it("full names", () => {
    expect(price("99 Saudi riyals")).toMatchObject({ amount: 99, currency: "SAR", text: "99 Saudi riyals" });
    expect(price("99 Qatari riyals")).toMatchObject({ currency: "QAR" });
    expect(price("9.900 Omani rials")).toMatchObject({ amount: 9.9, currency: "OMR" });
    expect(price("5 Kuwaiti dinars")).toMatchObject({ currency: "KWD" });
    expect(price("5 Bahraini dinars")).toMatchObject({ currency: "BHD" });
    expect(price("99 UAE dirhams")).toMatchObject({ currency: "AED" });
    expect(price("100 Egyptian pounds")).toMatchObject({ currency: "EGP" });
    expect(price("49 US dollars")).toMatchObject({ currency: "USD" });
    expect(price("49 dollars")).toMatchObject({ currency: "USD" });
    expect(price("99 riyals")).toMatchObject({ currency: "RIYAL" });
    expect(price("5 dinars")).toMatchObject({ currency: "DINAR" });
  });

  it("Dhs. / Dh. with a dot, and the capital abbreviations SR, QR, KD, BD, RO", () => {
    expect(price("Dhs. 99")).toEqual({ amount: 99, currency: "AED", text: "Dhs. 99" });
    expect(price("Dh. 99")).toMatchObject({ amount: 99, currency: "AED" });
    expect(price("Dhs 99")).toMatchObject({ amount: 99, currency: "AED" });
    expect(price("SR 99")).toEqual({ amount: 99, currency: "SAR", text: "SR 99" });
    expect(price("99 SR")).toMatchObject({ amount: 99, currency: "SAR" });
    expect(price("QR 99")).toMatchObject({ currency: "QAR" });
    expect(price("KD 5.500")).toMatchObject({ amount: 5.5, currency: "KWD" });
    expect(price("BD 5.500")).toMatchObject({ amount: 5.5, currency: "BHD" });
    expect(price("RO 9.900")).toMatchObject({ amount: 9.9, currency: "OMR" });
    expect(price("SR ٩٩")).toMatchObject({ amount: 99, currency: "SAR", text: "SR ٩٩" });
  });
});

describe("A3 decimals and trailing marks", () => {
  it("'AED 99.00' = 'AED 99' = 'AED 99,00'; '1,299.00' = '1,299'", () => {
    const want = parsePrice("AED 99")!;
    for (const s of ["AED 99.00", "AED 99,00", "AED 99.0", "Dhs. 99.00", "٩٩٫٠٠ درهم"]) expect(pricesMatch(want, price(s)), s).toBe("match");
    expect(pricesMatch(parsePrice("AED 1,299")!, price("AED 1,299.00"))).toBe("match");
    expect(pricesMatch(want, price("AED 99.50"))).toBe("mismatch");
  });

  it("'/-' and '*' after a price: the price is read, shown without the mark", () => {
    expect(findPrices("Only Rs 500/-")).toEqual([{ amount: 500, currency: "INR", text: "Rs 500" }]);
    expect(findPrices("Now AED 99* (*T&C apply)")).toEqual([{ amount: 99, currency: "AED", text: "AED 99" }]);
    expect(findPrices("AED 99.-")).toEqual([{ amount: 99, currency: "AED", text: "AED 99" }]);
  });
});

describe("A3 comparing currencies", () => {
  const p = (s: string) => parsePrice(s)!;

  it("a bare ريال matches Saudi, Qatari or Omani riyals — both ways; never AED, USD or a dinar", () => {
    for (const exact of ["SAR 99", "QAR 99", "OMR 99", "٩٩ ريال سعودي", "SR 99"]) {
      expect(pricesMatch(p(exact), price("٩٩ ريال")), exact).toBe("match");
      expect(pricesMatch(p("٩٩ ريال"), p(exact)), exact).toBe("match");
    }
    for (const other of ["AED 99", "USD 99", "KWD 99", "٩٩ دينار"]) expect(pricesMatch(p(other), price("٩٩ ريال")), other).toBe("mismatch");
  });

  it("a bare دينار matches Kuwaiti or Bahraini dinars; never Omani rials or a riyal", () => {
    expect(pricesMatch(p("KWD 5.500"), price("٥٫٥٠٠ دينار"))).toBe("match");
    expect(pricesMatch(p("BHD 5.500"), price("٥٫٥٠٠ دينار"))).toBe("match");
    expect(pricesMatch(p("OMR 5.500"), price("٥٫٥٠٠ دينار"))).toBe("mismatch");
    expect(pricesMatch(p("٥ ريال"), price("٥ دينار"))).toBe("mismatch");
  });

  it("specific currencies stay specific: Saudi ≠ Qatari, Kuwaiti ≠ Bahraini", () => {
    expect(pricesMatch(p("SAR 99"), price("٩٩ ريال قطري"))).toBe("mismatch");
    expect(pricesMatch(p("KWD 5"), price("BD 5"))).toBe("mismatch");
  });

  it("the same amount and currency in every form matches", () => {
    for (const s of ["Dhs. 99", "99 dirhams", "٩٩ درهم", "٩٩ درهم إماراتي", "99 UAE dirhams", "99 AED"]) expect(pricesMatch(p("AED 99"), price(s)), s).toBe("match");
  });
});

describe("A3 not prices", () => {
  it("lower- or mixed-case two-letter words are not Gulf abbreviations", () => {
    for (const s of ["Sr. 5", "Sr 5", "sr 5", "Kd 5", "ro 3", "Ro 3", "bd 2", "qr 7"]) expect(findPrices(s), s).toEqual([]);
  });

  it("Real Madrid isn't riyals; riyal-like words aren't currencies", () => {
    expect(findPrices("٢ ريال مدريد")).toEqual([]);
    expect(findPrices("تذاكر مباراة ريال مدريد ٣")).toEqual([]);
    expect(findPrices("٥ ريالين")).toEqual([]);
  });

  it("dates, phone numbers and percentages near currency words are not prices", () => {
    expect(findPrices("حتى ٣١ ديسمبر ٢٠٢٦")).toEqual([]);
    expect(findPrices("اتصل ٠٤ ١٢٣ ٤٥٦٧")).toEqual([]);
    expect(findPrices("خصم ٢٠٪")).toEqual([]);
    expect(findPrices("Valid 31/12/2026, call 04 123 4567, 20% off — only AED 99")).toEqual([{ amount: 99, currency: "AED", text: "AED 99" }]);
    expect(findPrices("خصم ٢٠٪ — فقط ٩٩ ريال حتى ٣١ ديسمبر")).toEqual([{ amount: 99, currency: "RIYAL", text: "٩٩ ريال" }]);
  });
});

describe("A3 end to end", () => {
  it("brief SAR 99, design '٩٩ ريال' → present (was: missing)", () => {
    const [f] = byRule(run({ requirements: [requirement("price", "SAR 99")], detections: read("فقط ٩٩ ريال") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("brief AED 99, design 'Dhs. 99' or 'AED 99.00' → present", () => {
    for (const shown of ["Only Dhs. 99", "Only AED 99.00", "٩٩ درهم إماراتي"]) {
      const [f] = byRule(run({ requirements: [requirement("price", "AED 99")], detections: read(shown) }), "brief.requirement");
      expect(f.status, shown).toBe("passed");
    }
  });

  it("brief AED 99, design '٩٩ ريال' → a wrong currency, shown as written", () => {
    const [f] = byRule(run({ requirements: [requirement("price", "AED 99")], detections: read("فقط ٩٩ ريال") }), "brief.requirement");
    expect([f.status, f.detected]).toEqual(["failed", "٩٩ ريال"]);
  });

  it("brief KWD 5.500, design '٥٫٥٠٠ دينار' → present", () => {
    const [f] = byRule(run({ requirements: [requirement("price", "KWD 5.500")], detections: read("٥٫٥٠٠ دينار") }), "brief.requirement");
    expect(f.status).toBe("passed");
  });

  it("an extra price the brief doesn't give is flagged as written; the brief's own price in another form isn't", () => {
    const found = byRule(run({ requirements: [requirement("price", "SAR 99")], detections: read("٩٩ ريال", "SR 49") }), "brief.unexpected");
    expect(found.filter((f) => f.status === "failed").map((f) => f.detected)).toEqual(["SR 49"]);
  });

  it("brief reading (no AI): Arabic and abbreviated prices are found in the brief, kept as written", () => {
    expect(patternCandidates("السعر: ٩٩ ريال سعودي، أو KD 5.500").filter((c) => c.type === "price").map((c) => c.value)).toEqual(["٩٩ ريال سعودي", "KD 5.500"]);
  });
});
