import { describe, expect, it } from "vitest";
import { findExactSize, parseDimensions, parseExactSize, sizeText } from "@/lib/qc/compare";

/**
 * Regression (Travel Mart, 2026-10-10): the AI copied the brief's
 * "1080 × 1080 px" as "1080  1080 px" — the "×" lost — so the size wasn't
 * recognised, the page asked for a platform and the brief's size wasn't checked.
 */
describe("exact sizes from a brief", () => {
  it("parseDimensions: the usual ways of writing a size, and the same size with its × lost", () => {
    for (const written of ["1080 × 1080 px", "1080x1080", "1080 X 1080 pixels", "1080 by 1080", "1080  1080 px", "1080 1080", " 1080 1080 pixels "]) {
      expect(parseDimensions(written), written).toEqual({ width: 1080, height: 1080 });
    }
    expect(parseDimensions("1200  628 px")).toEqual({ width: 1200, height: 628 });
  });

  it("parseDimensions: anything else is not read as a size", () => {
    for (const written of ["210 × 297 mm", "210 297 mm", "Square", "1080", "1080 1080 1350", "Post 1080 1080", "1080 × 1080 or 1080 × 1350", "4:5", "10 20 30 px"]) {
      expect(parseDimensions(written), written).toBeNull();
    }
    // The strict parser is unchanged: no × → no size.
    expect(parseExactSize("1080  1080 px")).toBeNull();
  });

  it("sizeText writes a size the one standard way", () => {
    expect(sizeText({ width: 1080, height: 1350 })).toBe("1080 × 1350 px");
  });

  it("findExactSize: the brief's one size, read from its own text (the Travel Mart layout)", () => {
    const brief = ["Campaign / Purpose: Azerbaijan winter travel", "Disclaimer", "T&C apply", "Phone", "+974 4444 12337", "Dimensions", "1080 × 1080 px", "Special Instructions"].join("\n");
    expect(findExactSize(brief)).toEqual({ width: 1080, height: 1080 });
    expect(findExactSize("Dimensions: 1080x1080")).toEqual({ width: 1080, height: 1080 });
    expect(findExactSize("Size 1200 by 628 for the banner\nAgain: size 1200 x 628")).toEqual({ width: 1200, height: 628 }); // same size twice is one size
  });

  it("findExactSize: never guesses — no size line, several sizes, or another unit → nothing", () => {
    expect(findExactSize("Call 0800 x 1234 to book")).toBeNull(); // not a line about size
    expect(findExactSize("Post size 1080 × 1080 px\nStory size 1080 × 1920 px")).toBeNull(); // two different sizes
    expect(findExactSize("Sizes: 1080 × 1080 or 1080 × 1350 px")).toBeNull();
    expect(findExactSize("Print size 210 × 297 mm")).toBeNull();
    expect(findExactSize("Summer sale, 20% off. T&C apply.")).toBeNull();
  });
});
