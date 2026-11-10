import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, GEMINI_DIDNT_LIST, HUMAN_CHECK, HUMAN_CHECK_CRITICAL, isHumanCheck } from "@/lib/analysis/policy";
import type { Finding } from "@/lib/qc/findings";
import type { QcInputRequirement } from "@/lib/qc/qc-input";
import { byRule, detections, requirement, run, text } from "../../../test/qc-fixtures";

/**
 * S07 fix (2026-11-10): under the Gemini profile, a WRONG date written with a month name inside worded text
 * (brief wording, legal disclaimers) was taken for a MISSING one — the rule reports its near match with dates
 * written one way ("offer valid until 30 12 2026"), and the policy didn't recognise those words in the line
 * ("… 30 Dec 2026"), so the finding became "Gemini didn't list this text". The policy now writes dates one way
 * on both sides. Genuinely missing text is unchanged.
 */

const gemini = (...lines: string[]) => detections({ texts: lines.map((l) => text(l, { confidence: 0.9 })), textCoverage: 1 });
const exact = (...lines: string[]) => detections({ texts: lines.map((l) => text(l, { confidence: 0.95 })), textCoverage: 0.95 });

function check(rule: "brief.requirement" | "legal.disclaimer", r: QcInputRequirement, d: ReturnType<typeof gemini>, provider: "gemini" | "google" = "gemini"): Finding {
  const findings = applyConfidencePolicy(run({ requirements: [r], detections: d }), d, { state: "done" }, { provider });
  return byRule(findings, rule)[0];
}
const didntList = (f: Finding) => f.explanation.includes(GEMINI_DIDNT_LIST);

describe("S07 — wrong month-name dates under the Gemini profile are wrong values, not missing text", () => {
  it("English month name in worded brief text: counted as a failure (was: 'Gemini didn't list this text')", () => {
    const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini("Offer valid until 30 Dec 2026"));
    expect(f.status).toBe("failed");
    expect(didntList(f)).toBe(false);
    expect(f.detected).toBe("offer valid until 30 12 2026");
  });

  it("English month name, full month and day-first forms too", () => {
    for (const shown of ["Offer valid until 30 December 2026", "Offer valid until December 30, 2026"]) {
      const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini(shown));
      expect([shown, f.status, didntList(f)]).toEqual([shown, "failed", false]);
    }
  });

  it("Arabic month name (A2) in worded brief text: counted as a failure", () => {
    const f = check("brief.requirement", requirement("required_text", "العرض ساري حتى ٣١ ديسمبر ٢٠٢٦", { mandatory: false }), gemini("العرض ساري حتى ٣٠ ديسمبر ٢٠٢٦"));
    expect(f.status).toBe("failed");
    expect(didntList(f)).toBe(false);
  });

  it("Levantine Arabic month name: counted as a failure", () => {
    const f = check("brief.requirement", requirement("required_text", "العرض ساري حتى ٣١ كانون الأول ٢٠٢٦", { mandatory: false }), gemini("العرض ساري حتى ٣٠ كانون الأول ٢٠٢٦"));
    expect(f.status).toBe("failed");
  });

  it("legal disclaimer with a wrong month-name date: counted as a failure", () => {
    const f = check("legal.disclaimer", requirement("disclaimer", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini("Offer valid until 30 Dec 2026"));
    expect(f.status).toBe("failed");
    expect(didntList(f)).toBe(false);
    expect(f.explanation).toMatch(/different numbers or details/);
  });

  it("mandatory: the existing rule for AI evidence applies (possible critical, judged by AI) — never 'didn't list'", () => {
    const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026"), gemini("Offer valid until 30 Dec 2026"));
    expect(isHumanCheck(f)).toBe(true);
    expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(f.explanation).toContain("this was judged by AI");
    expect(didntList(f)).toBe(false);
  });
});

describe("S07 fix leaves everything else as it was", () => {
  it("genuinely missing text is still the 'Gemini didn't list this text' human check (brief and legal)", () => {
    const brief = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini("Summer Villa Offers"));
    expect([brief.status, brief.detected, brief.explanation.startsWith(HUMAN_CHECK), didntList(brief)]).toEqual(["unverified", "Not found", true, true]);
    const legal = check("legal.disclaimer", requirement("disclaimer", "Terms and conditions apply", { mandatory: false }), gemini("Summer Villa Offers"));
    expect([legal.status, didntList(legal)]).toEqual(["unverified", true]);
  });

  it("a mandatory missing text is still a possible critical 'didn't list' human check", () => {
    const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026"), gemini("Summer Villa Offers"));
    expect(f.explanation.startsWith(HUMAN_CHECK_CRITICAL)).toBe(true);
    expect(didntList(f)).toBe(true);
  });

  it("numeric dates and non-date wording behave as before under Gemini", () => {
    const numeric = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini("Offer valid until 30/12/2026"));
    expect(numeric.status).toBe("failed");
    const typo = check("brief.requirement", requirement("required_text", "Summer Villa Offers", { mandatory: false }), gemini("Sumer Villa Offers"));
    expect(typo.status).toBe("failed");
  });

  it("the exact-reading profile is unchanged: the wrong date was already a failure", () => {
    const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), exact("Offer valid until 30 Dec 2026"), "google");
    expect(f.status).toBe("failed");
  });

  it("a correct month-name date still passes under Gemini", () => {
    const f = check("brief.requirement", requirement("required_text", "Offer valid until 31 Dec 2026", { mandatory: false }), gemini("Offer valid until 31 December 2026"));
    expect(f.status).toBe("passed");
  });
});
