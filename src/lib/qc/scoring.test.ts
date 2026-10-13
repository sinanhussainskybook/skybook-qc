import { describe, expect, it } from "vitest";
import { HUMAN_CHECK, HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { categoryScore, RESULT_DISPLAY_LABEL, resultDisplay, resultOf, scoreFindings } from "@/lib/qc/scoring";

/** Phase 7 — score and result, at every boundary. */
let n = 0;
const f = (category: Category, status: FindingStatus, severity: Severity = "major", over: Partial<Finding> = {}): Finding => ({
  ruleId: `rule.${++n}`,
  category,
  title: "Check",
  severity,
  status,
  kind: "fact",
  explanation: "…",
  confidence: 1,
  ...over,
});
const human = (category: Category, severity: Severity) =>
  f(category, "unverified", severity, { explanation: `${severity === "critical" ? HUMAN_CHECK_CRITICAL : HUMAN_CHECK}: the reading wasn't clear enough to be sure.` });

describe("result", () => {
  it("nothing answered → no result yet (never a PASS for checks that didn't run)", () => {
    expect(scoreFindings([])).toMatchObject({ result: null, score: null });
    const onlyUnverified = scoreFindings([f("brief", "unverified", "critical"), f("brand", "not_applicable"), human("content", "critical")]);
    expect(onlyUnverified).toMatchObject({ result: null, score: null, notVerified: 1, humanChecks: 1, notApplicable: 1, answered: 0 });
  });

  it("only passes → PASS, 100", () => {
    expect(scoreFindings([f("brief", "passed"), f("brand", "passed")])).toMatchObject({ result: "pass", score: 100 });
  });

  it("suggestions never block: only suggestions → PASS, score unchanged", () => {
    const s = scoreFindings([f("design_layout", "failed", "suggestion"), f("brief", "passed")]);
    expect(s).toMatchObject({ result: "pass", score: 100, issues: { critical: 0, major: 0, minor: 0, suggestion: 1 } });
  });

  it("one MINOR → NEEDS REVISION; one MAJOR → NEEDS REVISION", () => {
    expect(scoreFindings([f("design_layout", "failed", "minor")]).result).toBe("needs_revision");
    expect(scoreFindings([f("brand", "failed", "major")]).result).toBe("needs_revision");
  });

  it("one counting CRITICAL → FAIL, even when the overall score is 90+", () => {
    const passes = (["content", "brand", "golden_rules", "design_layout", "accessibility", "image_asset", "platform_size", "legal"] as Category[]).map((c) => f(c, "passed"));
    const s = scoreFindings([...passes, f("brief", "failed", "critical", { title: "Price", expected: "AED 1,299", detected: "AED 1,399" })]);
    expect(s.score).toBe(96); // (8 × 100 + 60) / 9 = 95.6
    expect(s.result).toBe("fail");
  });

  it("CRITICAL beats MAJOR / MINOR; MAJOR / MINOR beat suggestions", () => {
    expect(resultOf({ critical: 1, major: 3, minor: 3, suggestion: 3 })).toBe("fail");
    expect(resultOf({ critical: 0, major: 0, minor: 1, suggestion: 9 })).toBe("needs_revision");
    expect(resultOf({ critical: 0, major: 0, minor: 0, suggestion: 9 })).toBe("pass");
  });

  it("NOT VERIFIED never counts — a mandatory requirement not yet verified does not fail", () => {
    const s = scoreFindings([f("brief", "unverified", "critical"), f("brand", "passed")]);
    expect(s).toMatchObject({ result: "pass", score: 100, notVerified: 1 });
  });

  it("AI uncertainty never fails a design: 'Needs a human check — possible critical issue' doesn't count", () => {
    const s = scoreFindings([human("brand", "critical"), human("image_asset", "major"), f("brief", "passed")]);
    expect(s).toMatchObject({ result: "pass", humanChecks: 2, notVerified: 0, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
  });

  it("not applicable is ignored", () => {
    expect(scoreFindings([f("legal", "not_applicable", "critical"), f("brief", "passed")])).toMatchObject({ result: "pass", score: 100, applicable: 1 });
  });
});

describe("result display: PASS — PLEASE VERIFY", () => {
  const shown = (findings: Finding[]) => {
    const board = scoreFindings(findings);
    const display = resultDisplay(board);
    return { result: board.result, display, label: display ? RESULT_DISPLAY_LABEL[display] : null, issues: board.issues };
  };

  it("no counted issues and no human checks → PASS", () => {
    expect(shown([f("brief", "passed"), f("brand", "passed")])).toMatchObject({ result: "pass", display: "pass", label: "PASS" });
  });

  it("no counted issues but a human check → PASS — PLEASE VERIFY; the result itself is still PASS and nothing counts", () => {
    for (const severity of ["critical", "major", "minor"] as const) {
      const s = shown([f("brief", "passed"), human("brief", severity)]);
      expect(s).toEqual({ result: "pass", display: "pass_human_check", label: "PASS — PLEASE VERIFY", issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    }
    // A suggestion doesn't change that either.
    expect(shown([f("design_layout", "failed", "suggestion"), human("brief", "critical")]).label).toBe("PASS — PLEASE VERIFY");
  });

  it("MAJOR / MINOR → NEEDS REVISION and CRITICAL → FAIL, with or without human checks", () => {
    expect(shown([f("brand", "failed", "major"), human("brief", "critical")])).toMatchObject({ result: "needs_revision", label: "NEEDS REVISION" });
    expect(shown([f("brand", "failed", "minor")])).toMatchObject({ result: "needs_revision", label: "NEEDS REVISION" });
    expect(shown([f("brief", "failed", "critical"), human("brand", "major")])).toMatchObject({ result: "fail", label: "FAIL" });
  });

  it("not verified alone isn't a human check: a PASS with only not-verified items stays PASS; no answer → no result", () => {
    expect(shown([f("brief", "passed"), f("brand", "unverified", "major")])).toMatchObject({ display: "pass", label: "PASS" });
    expect(resultDisplay({ result: null, humanChecks: 3 })).toBeNull();
  });
});

describe("score", () => {
  it("a category loses 40 / 15 / 5 / 0 per counting critical / major / minor / suggestion, never below 0", () => {
    expect(categoryScore({ critical: 1, major: 0, minor: 0, suggestion: 0 })).toBe(60);
    expect(categoryScore({ critical: 0, major: 1, minor: 0, suggestion: 0 })).toBe(85);
    expect(categoryScore({ critical: 0, major: 0, minor: 1, suggestion: 0 })).toBe(95);
    expect(categoryScore({ critical: 0, major: 0, minor: 0, suggestion: 5 })).toBe(100);
    expect(categoryScore({ critical: 3, major: 0, minor: 0, suggestion: 0 })).toBe(0);
    expect(categoryScore({ critical: 2, major: 2, minor: 0, suggestion: 0 })).toBe(0);
  });

  it("overall = average of categories with an answered check (only-unverified categories are left out), rounded", () => {
    const s = scoreFindings([f("brand", "failed", "major"), f("brief", "passed"), f("design_layout", "failed", "minor"), f("legal", "unverified")]);
    expect(s.categories.find((c) => c.category === "legal")!.score).toBeNull();
    expect(s.score).toBe(Math.round((85 + 100 + 95) / 3)); // 93
  });

  it("counts by severity and category; counting issues listed most serious first", () => {
    const s = scoreFindings([
      f("brand", "failed", "minor"),
      f("brief", "failed", "critical"),
      f("brief", "failed", "major"),
      f("brief", "passed"),
      f("brief", "unverified"),
      human("brief", "critical"),
    ]);
    expect(s.issues).toEqual({ critical: 1, major: 1, minor: 1, suggestion: 0 });
    expect(s.categories.find((c) => c.category === "brief")).toMatchObject({ score: 45, passed: 1, notVerified: 1, humanChecks: 1, issues: { critical: 1, major: 1, minor: 0, suggestion: 0 } });
    expect(s.counting.map((x) => x.severity)).toEqual(["critical", "major", "minor"]);
    expect([s.answered, s.applicable]).toEqual([4, 6]);
  });
});
