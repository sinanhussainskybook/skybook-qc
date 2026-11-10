import { describe, expect, it } from "vitest";
import { joinHyphenatedLines } from "@/lib/qc/compare";
import { textReadings, type Box, type DetectedText } from "@/lib/qc/detections";
import { byRule, company, detections, golden, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * Stage 3 (designer feedback), Track A4 — required wording matches however the design breaks it into lines:
 * words broken by a hyphen at a line break, and wording split over several text blocks listed out of reading
 * order (Arabic rows read right to left). Wording only counts as present when it appears complete, word for
 * word, in one reading of the text; anything missing, changed or reordered within a line is still reported,
 * from the text as listed.
 */

const at = (x: number, y: number, w = 0.3, h = 0.04): Box => ({ x, y, w, h });
const block = (value: string, box: Box, over: Partial<DetectedText> = {}) => text(value, { box, ...over });
const shown = (...texts: DetectedText[]) => detections({ texts, textCoverage: 0.95 });
const lines = (...values: string[]) => shown(...values.map((v) => text(v)));
const disclaimer = (wording: string, d: ReturnType<typeof shown>) =>
  byRule(run({ requirements: [requirement("disclaimer", wording)], detections: d }), "legal.disclaimer")[0];
const brief = (type: string, wording: string, d: ReturnType<typeof shown>) =>
  byRule(run({ requirements: [requirement(type, wording)], detections: d }), "brief.requirement")[0];

describe("A4 joining words broken across lines by a hyphen", () => {
  it("a hyphen at a line end before a lower-case letter joins the word; soft hyphens are removed", () => {
    expect(joinHyphenatedLines("Terms and condi-\ntions apply")).toBe("Terms and conditions apply");
    expect(joinHyphenatedLines("Terms and condi-  \n  tions apply")).toBe("Terms and conditions apply");
    expect(joinHyphenatedLines("Terms and condi-\r\ntions apply")).toBe("Terms and conditions apply");
    expect(joinHyphenatedLines("Terms and condi‐\ntions apply")).toBe("Terms and conditions apply"); // Unicode hyphen
    expect(joinHyphenatedLines("Terms and condi­tions apply")).toBe("Terms and conditions apply"); // soft hyphen
  });

  it("left alone: a capital after the break (a real hyphenated pair), a hyphen mid-line, a dash between words", () => {
    expect(joinHyphenatedLines("Dubai-\nAbu Dhabi")).toBe("Dubai-\nAbu Dhabi");
    expect(joinHyphenatedLines("pre- and post-sale")).toBe("pre- and post-sale");
    expect(joinHyphenatedLines("Sale ends soon -\nbook now")).toBe("Sale ends soon -\nbook now");
    expect(joinHyphenatedLines("2025-\n2026")).toBe("2025-\n2026");
  });
});

describe("A4 reading order from the text positions", () => {
  it("the text as listed always comes first; the other readings are added only when different", () => {
    expect(textReadings(lines("Book now"))).toEqual(["Book now"]);
    expect(textReadings(null)).toEqual([]);
  });

  it("rows top to bottom; within a row left to right for English, right to left for Arabic", () => {
    const d = shown(
      block("apply", at(0.6, 0.5)), // listed first, but to the right
      block("Terms and conditions", at(0.1, 0.5)),
      block("الشروط والأحكام", at(0.1, 0.8)), // Arabic row: the right-hand block is read first
      block("تطبق", at(0.6, 0.8)),
      block("Summer Sale", at(0.1, 0.1)) // listed last, but at the top
    );
    expect(textReadings(d)).toContain("Summer Sale\nTerms and conditions\napply\nتطبق\nالشروط والأحكام");
  });

  it("a frame where a line has no position keeps the listed order; video keeps the listed order", () => {
    const noBox = shown(block("apply", at(0.6, 0.5)), text("Terms and conditions"));
    expect(textReadings(noBox)).toEqual(["apply\nTerms and conditions"]);
    const video = shown(block("apply", at(0.6, 0.5), { startMs: 0, endMs: 1000 }), block("Terms", at(0.1, 0.5), { startMs: 0, endMs: 1000 }));
    expect(textReadings(video)).toEqual(["apply\nTerms"]);
  });

  it("each file / page is ordered on its own, in the listed order of frames", () => {
    const d = shown(
      block("two", at(0.6, 0.5), { fileId: "a" }),
      block("one", at(0.1, 0.5), { fileId: "a" }),
      block("four", at(0.6, 0.1), { fileId: "b" }),
      block("three", at(0.1, 0.1), { fileId: "b" })
    );
    expect(textReadings(d)).toContain("one\ntwo\nthree\nfour");
  });
});

describe("A4 English wording across line breaks", () => {
  it("a disclaimer broken by a hyphen passes (was: failed)", () => {
    expect(disclaimer("Terms and conditions apply", lines("Terms and condi-", "tions apply"))).toMatchObject({ status: "passed" });
  });

  it("wording split over text blocks listed out of reading order passes", () => {
    const d = shown(block("conditions apply", at(0.55, 0.9)), block("Terms and", at(0.1, 0.9)));
    expect(disclaimer("Terms and conditions apply", d)).toMatchObject({ status: "passed" });
    expect(brief("required_text", "Terms and conditions apply", d)).toMatchObject({ status: "passed" });
  });

  it("a Golden Rule disclaimer and an approved CTA (no CTA role) work across line breaks too", () => {
    const rules = company({ goldenRules: [golden({ category: "mandatory_disclaimer", approved_value: "Terms and conditions apply" })] });
    const [f] = byRule(run({ company: rules, detections: lines("Terms and condi-", "tions apply") }), "golden_rules");
    expect(f.status).toBe("passed");
    const cta = company({ goldenRules: [golden({ category: "approved_cta", approved_value: "Book your stay now" })] });
    const [c] = byRule(run({ company: cta, detections: shown(block("now", at(0.6, 0.9)), block("Book your stay", at(0.1, 0.9))) }), "golden_rules");
    expect(c.status).toBe("passed");
  });

  it("the capitals check still applies to wording found this way", () => {
    expect(disclaimer("Terms and Conditions apply", lines("Terms and condi-", "tions apply"))).toMatchObject({ status: "failed", severity: "minor" });
  });
});

describe("A4 Arabic wording across lines and right-to-left order", () => {
  it("one sentence split into two blocks on a row, listed left to right, passes (was: failed)", () => {
    const d = shown(block("الشروط والأحكام", at(0.1, 0.9)), block("تطبق", at(0.6, 0.9)));
    expect(disclaimer("تطبق الشروط والأحكام", d)).toMatchObject({ status: "passed" });
  });

  it("rows listed bottom first are read top to bottom", () => {
    const d = shown(block("حتى نهاية الشهر", at(0.2, 0.85)), block("العرض ساري", at(0.2, 0.8)));
    expect(brief("required_text", "العرض ساري حتى نهاية الشهر", d)).toMatchObject({ status: "passed" });
  });

  it("a bilingual row: the English part keeps left-to-right order, the Arabic row right to left", () => {
    const d = shown(block("apply", at(0.6, 0.5)), block("T&C", at(0.1, 0.5)), block("والأحكام", at(0.1, 0.8)), block("تطبق الشروط", at(0.6, 0.8)));
    expect(disclaimer("T&C apply", d)).toMatchObject({ status: "passed" });
    expect(disclaimer("تطبق الشروط والأحكام", d)).toMatchObject({ status: "passed" });
  });
});

describe("A4 never hides missing, changed or reordered words", () => {
  it("a missing word is still missing", () => {
    expect(disclaimer("Terms and conditions apply", lines("Terms and condi-", "tions"))).toMatchObject({ status: "failed" });
    const d = shown(block("الشروط", at(0.1, 0.9)), block("تطبق", at(0.6, 0.9)));
    expect(disclaimer("تطبق الشروط والأحكام", d)).toMatchObject({ status: "failed" });
  });

  it("a changed word is still reported, from the text as listed", () => {
    const f = disclaimer("Terms and conditions apply", lines("Terms and condi-", "tions applied"));
    expect(f.status).toBe("failed");
    expect(f.detected).not.toBe("Present word for word");
  });

  it("joining a hyphenated word never turns a different word into the required one", () => {
    expect(brief("required_text", "Terms and conditions apply", lines("Terms and condi-", "tion apply"))).toMatchObject({ status: "failed" });
  });

  it("words in the wrong order inside one line are not reordered (that is a real difference)", () => {
    expect(disclaimer("تطبق الشروط والأحكام", lines("والأحكام الشروط تطبق"))).toMatchObject({ status: "failed" });
    expect(disclaimer("Terms and conditions apply", lines("Conditions and terms apply"))).toMatchObject({ status: "failed" });
  });

  it("unrelated wording on different rows doesn't combine into the required wording", () => {
    const d = shown(block("Free gift", at(0.1, 0.1)), block("delivery in 3 days", at(0.1, 0.5)));
    expect(brief("required_text", "Free delivery", d)).toMatchObject({ status: "failed" });
  });

  it("blocks on different rows aren't merged into one row (the vertical overlap rule)", () => {
    const d = shown(block("apply", at(0.6, 0.1)), block("Terms and conditions", at(0.1, 0.5)));
    // Read top to bottom: "apply" first — so the required order isn't produced.
    expect(disclaimer("Terms and conditions apply", d)).toMatchObject({ status: "failed" });
  });
});
