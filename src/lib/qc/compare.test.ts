import { describe, expect, it } from "vitest";
import {
  capitalizationDifference,
  colorDifference,
  containsText,
  contrastRatio,
  ctaMatches,
  datesMatch,
  emailsMatch,
  findDates,
  findEmails,
  findName,
  findPercentages,
  findPhones,
  findPrices,
  findTimes,
  findWebsites,
  isNeutral,
  parsePercentage,
  parsePrice,
  phonesMatch,
  pricesMatch,
  sameFontFamily,
  textMatches,
  websitesMatch,
} from "@/lib/qc/compare";

/** Plan 5.3 — comparison helpers. */
describe("comparison helpers", () => {
  it("text: case, punctuation and spacing ignored; whole words only", () => {
    expect(textMatches("Summer Sale!", "  summer   SALE ")).toBe(true);
    expect(textMatches("Summer Sale", "Summer Sales")).toBe(false);
    expect(textMatches("", "")).toBe(false);
    expect(containsText("Book now — Skybook’s summer sale ends soon", "skybooks summer sale")).toBe(true);
    expect(containsText("Summer salesman", "summer sale")).toBe(false);
  });

  it("UK and US spellings are the same word; the content is still reported as written", () => {
    for (const [uk, us] of [
      ["Customised Packages", "Customized Packages"],
      ["Organisation", "Organization"],
      ["analysed", "analyzed"],
      ["Colourful favourites", "Colorful favorites"],
      ["City Centre", "City Center"],
      ["Travelled", "Traveled"],
      ["travellers", "travelers"],
      ["Holiday Programme", "Holiday Program"],
      ["grey", "gray"],
      ["Jewellery", "Jewelry"],
    ]) {
      expect([uk, textMatches(us, uk)]).toEqual([uk, true]);
      expect([uk, containsText(`Our ${uk} today`, us)]).toEqual([uk, true]);
      expect([uk, findName(`Our ${uk} today`, us)]).toEqual([uk, { status: "exact" }]);
    }
    // Different words stay different: "filled" isn't "filed", "four" isn't "for", "tour" isn't "tor".
    expect(textMatches("filed", "filled")).toBe(false);
    expect(textMatches("for", "four")).toBe(false);
    expect(textMatches("tor", "tour")).toBe(false);
    // A real typo is still a misspelling, shown as written.
    expect(findName("Our Custmised Packages", "Customized Packages")).toEqual({ status: "misspelt", found: "custmised packages" });
    // Capitals: the other spelling with the same capitals is no capitals difference; other capitals still are.
    expect(capitalizationDifference("Customised Packages", "Customized Packages")).toBeNull();
    expect(capitalizationDifference("Customised packages", "Customized Packages")).toBe("Customised packages");
  });

  it("names: exact, close misspellings, and absent", () => {
    expect(findName("Welcome to Skybook Villas", "Skybook")).toEqual({ status: "exact" });
    expect(findName("Welcome to Skybok Villas", "Skybook")).toEqual({ status: "misspelt", found: "skybok" });
    expect(findName("Welcome to Sky Book Villas", "Skybook")).toEqual({ status: "misspelt", found: "sky book" });
    expect(findName("Welcome to Skyobok", "Skybook")).toMatchObject({ status: "misspelt" }); // transposition
    expect(findName("Welcome to Facebook", "Skybook")).toEqual({ status: "absent" });
    // Short names must be exact: "BMW" vs "BMX" is a different word.
    expect(findName("BMX bikes", "BMW")).toEqual({ status: "absent" });
    // Boundary: 2 edits allowed for long names, 3 is a different word.
    expect(findName("Marriot Intrnational", "Marriott International")).toMatchObject({ status: "misspelt" });
    expect(findName("Mariot Intrnatonal", "Marriott International")).toEqual({ status: "absent" });
  });

  it("phone: formatting ignored; local form matches but says so; different numbers don't", () => {
    expect(phonesMatch("+971 4 123 4567", "+971-4-1234567")).toBe("match");
    expect(phonesMatch("+971 4 123 4567", "00971 4 123 4567")).toBe("match");
    expect(phonesMatch("+971 4 123 4567", "04 123 4567")).toBe("match_without_country_code");
    expect(phonesMatch("+971 4 123 4567", "+971 4 123 4568")).toBe("mismatch");
    expect(phonesMatch("+971 4 123 4567", "+44 4 123 4567")).toBe("mismatch");
    expect(phonesMatch("123", "123")).toBe("mismatch"); // too short to be a phone
  });

  it("phone: found in text, but not prices or dates", () => {
    expect(findPhones("Call +971 4 123 4567 or (04) 765-4321 today")).toEqual(["+971 4 123 4567", "(04) 765-4321"]);
    expect(findPhones("Now AED 1,299 from 12/03/2026 and 2026-03-12")).toEqual([]);
  });

  it("email and website", () => {
    expect(findEmails("Write to Sales@Skybook.com.")).toEqual(["Sales@Skybook.com"]);
    expect(emailsMatch("sales@skybook.com", "Sales@Skybook.com")).toBe(true);
    expect(emailsMatch("sales@skybook.com", "sale@skybook.com")).toBe(false);
    expect(websitesMatch("https://www.skybook.com/", "skybook.com")).toBe(true);
    expect(websitesMatch("https://skybook.com/offers", "www.skybook.com/offers/")).toBe(true);
    expect(websitesMatch("https://skybook.com", "skybook.co")).toBe(false);
    expect(findWebsites("Visit www.skybook.com/offers. Email info@skybook.com")).toEqual(["www.skybook.com/offers"]);
  });

  it("price: currency + amount, either side, thousands separators", () => {
    expect(findPrices("Now AED 1,299 (was 1,599 AED) or $49.99")).toEqual([
      { amount: 1299, currency: "AED", text: "AED 1,299" },
      { amount: 1599, currency: "AED", text: "1,599 AED" },
      { amount: 49.99, currency: "USD", text: "$49.99" },
    ]);
    const expected = parsePrice("AED 1,299")!;
    expect(pricesMatch(expected, parsePrice("1299 dirhams")!)).toBe("match");
    expect(pricesMatch(expected, parsePrice("1299")!)).toBe("currency_missing");
    expect(pricesMatch(expected, parsePrice("$1,299")!)).toBe("mismatch");
    expect(pricesMatch(expected, parsePrice("AED 1,300")!)).toBe("mismatch");
    expect(parsePrice("call us")).toBeNull();
  });

  it("percentage", () => {
    expect(findPercentages("Save 20% now, up to 35 percent")).toEqual([20, 35]);
    expect(parsePercentage("20")).toBe(20);
    expect(parsePercentage("20 % off")).toBe(20);
    expect(parsePercentage("twenty")).toBeNull();
  });

  it("date: words and numbers; ambiguous numeric dates keep both readings", () => {
    const march12 = findDates("12 March 2026")[0];
    expect(march12).toEqual([{ day: 12, month: 3, year: 2026 }]);
    expect(datesMatch(march12, findDates("March 12th, 2026")[0])).toBe(true);
    expect(datesMatch(march12, findDates("2026-03-12")[0])).toBe(true);
    expect(datesMatch(march12, findDates("12/03/2026")[0])).toBe(true); // 12 March or 3 December
    expect(datesMatch(march12, findDates("Until 12 Mar")[0])).toBe(true); // year not shown
    expect(datesMatch(march12, findDates("13 March 2026")[0])).toBe(false);
    expect(datesMatch(march12, findDates("12 March 2025")[0])).toBe(false);
    expect(findDates("31/31/2026")).toEqual([]);
  });

  it("time", () => {
    expect(findTimes("Doors 7 PM, show 19:30, ends 11.15 p.m.")).toEqual([19 * 60, 19 * 60 + 30, 23 * 60 + 15]);
    expect(findTimes("7:30am")).toEqual([7 * 60 + 30]);
    expect(findTimes("25:00")).toEqual([]);
  });

  it("CTA: arrows and punctuation ignored, words must match", () => {
    expect(ctaMatches("Book now", "BOOK NOW →")).toBe(true);
    expect(ctaMatches("Book now", "Book today")).toBe(false);
  });

  it("colour: contrast (WCAG), difference and neutrals", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2); // just under 4.5
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2); // just over
    expect(colorDifference("#1A64B4", "#1A64B4")).toBe(0);
    expect(colorDifference("#1A64B4", "#1B65B5")!).toBeLessThan(2);
    expect(colorDifference("#1A64B4", "#E63946")!).toBeGreaterThan(50);
    expect(isNeutral("#ffffff")).toBe(true);
    expect(isNeutral("#333333")).toBe(true);
    expect(isNeutral("#1A64B4")).toBe(false);
    expect(contrastRatio("blue", "#fff")).toBeNull();
  });

  it("font families", () => {
    expect(sameFontFamily("Montserrat Bold", "montserrat")).toBe(true);
    expect(sameFontFamily("Open Sans", "OpenSans-Regular")).toBe(true);
    expect(sameFontFamily("Montserrat", "Roboto")).toBe(false);
  });
});

/**
 * Freeze review: things that look like contact details but aren't must not
 * be extracted — each would otherwise become a CRITICAL "wrong contact".
 */
describe("extractors don't mistake ordinary text for contact details", () => {
  it("a year range isn't a phone number", () => {
    expect(findPhones("Season 2025 - 2026")).toEqual([]);
    expect(findPhones("Season 2025-2026")).toEqual([]);
    expect(findPhones("Season 2025 / 2026")).toEqual([]);
    expect(findPhones("Call 800 123 456")).toEqual(["800 123 456"]);
  });

  it("a word.word isn't a website unless it has a scheme, www. or a real domain ending", () => {
    expect(findWebsites("Stay at the St.Regis Dubai")).toEqual([]);
    expect(findWebsites("Visit Dubai.Today and enjoy")).toEqual([]);
    expect(findWebsites("Book at skybookvillas.com or skybook.ae")).toEqual(["skybookvillas.com", "skybook.ae"]);
    expect(findWebsites("www.skybook.villas")).toEqual(["www.skybook.villas"]);
    expect(findWebsites("https://book.skybook.travel/offers")).toEqual(["https://book.skybook.travel/offers"]);
  });
});
