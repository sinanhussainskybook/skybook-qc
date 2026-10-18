import { describe, expect, it } from "vitest";
import { HUMAN_CHECK, HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { categoryScore, possibleCriticalWarning, RESULT_DISPLAY_LABEL, RESULT_DISPLAY_SUMMARY, resultDisplay, resultOf, scoreFindings, scoreNote, settingsWarning } from "@/lib/qc/scoring";

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

  it("no counted issues but a (major / minor) human check → PASS — PLEASE VERIFY; the result itself is still PASS and nothing counts", () => {
    for (const severity of ["major", "minor"] as const) {
      const s = shown([f("brief", "passed"), human("brief", severity)]);
      expect(s).toEqual({ result: "pass", display: "pass_human_check", label: "PASS — PLEASE VERIFY", issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    }
    // A suggestion doesn't change that either.
    expect(shown([f("design_layout", "failed", "suggestion"), human("brief", "major")]).label).toBe("PASS — PLEASE VERIFY");
  });

  it("MAJOR / MINOR → NEEDS REVISION and CRITICAL → FAIL, with or without human checks", () => {
    expect(shown([f("brand", "failed", "major"), human("brief", "critical")])).toMatchObject({ result: "needs_revision", label: "NEEDS REVISION" });
    expect(shown([f("brand", "failed", "minor")])).toMatchObject({ result: "needs_revision", label: "NEEDS REVISION" });
    expect(shown([f("brief", "failed", "critical"), human("brand", "major")])).toMatchObject({ result: "fail", label: "FAIL" });
  });

  it("not verified alone isn't a human check: a PASS with only not-verified items stays PASS; no answer → no result", () => {
    expect(shown([f("brief", "passed"), f("brand", "unverified", "major")])).toMatchObject({ display: "pass", label: "PASS" });
    expect(resultDisplay({ result: null, humanChecks: 3, possibleCriticals: 1, settingsBlockers: 1 })).toBeNull();
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

/**
 * Stage 1 (honest results): a possible critical issue — a CRITICAL the evidence couldn't confirm, e.g.
 * Gemini didn't read a mandatory price — is never shown as a PASS. The result itself and the counting
 * are unchanged: it still doesn't count, so it can't FAIL a design either.
 */
describe("result display: CHECK BEFORE SENDING", () => {
  const shown = (findings: Finding[]) => {
    const board = scoreFindings(findings);
    const display = resultDisplay(board);
    return { result: board.result, possibleCriticals: board.possibleCriticals, display, label: display ? RESULT_DISPLAY_LABEL[display] : null, summary: display ? RESULT_DISPLAY_SUMMARY[display] : null, score: board.score, issues: board.issues };
  };

  it("a possible critical issue and nothing counted → CHECK BEFORE SENDING, not PASS; nothing counts and the result is unchanged", () => {
    const s = shown([f("brief", "passed"), human("brief", "critical")]);
    expect(s).toMatchObject({ result: "pass", possibleCriticals: 1, display: "check_before_sending", label: "CHECK BEFORE SENDING", issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(s.summary).toMatch(/possible critical issue/i);
    expect(s.summary).toMatch(/don't send/i);
  });

  it("it wins over other human checks and suggestions; several possible criticals are all counted", () => {
    expect(shown([f("brief", "passed"), human("brief", "major"), human("brand", "critical"), f("design_layout", "failed", "suggestion")]).label).toBe("CHECK BEFORE SENDING");
    expect(shown([f("brief", "passed"), human("brief", "critical"), human("legal", "critical")]).possibleCriticals).toBe(2);
  });

  it("only a human check worded as a possible critical issue counts as one — not an ordinary 'not verified' critical", () => {
    // A mandatory requirement that simply wasn't analysed is NOT VERIFIED, not a possible issue found.
    expect(shown([f("brief", "passed"), f("brief", "unverified", "critical")])).toMatchObject({ possibleCriticals: 0, label: "PASS" });
  });

  it("NEEDS REVISION and FAIL are shown as they are, with or without a possible critical issue", () => {
    expect(shown([f("brand", "failed", "major"), human("brief", "critical")])).toMatchObject({ display: "needs_revision", label: "NEEDS REVISION", possibleCriticals: 1 });
    expect(shown([f("brief", "failed", "critical"), human("brand", "critical")])).toMatchObject({ display: "fail", label: "FAIL" });
  });

  it("invariant: whenever a possible critical issue is open, the label never says PASS", () => {
    const severities = ["critical", "major", "minor", "suggestion"] as const;
    const statuses = ["passed", "failed", "unverified", "not_applicable"] as const;
    for (const severity of severities)
      for (const status of statuses) {
        const s = shown([f("content", status, severity), f("brief", "passed"), human("brief", "critical")]);
        if (s.label) expect([severity, status, s.label]).toEqual([severity, status, expect.not.stringMatching(/PASS/)]);
      }
  });

  it("no answered check → still no result, whatever needs verifying", () => {
    expect(shown([human("brief", "critical")])).toMatchObject({ result: null, display: null, label: null });
  });
});

/** Stage 1 follow-up: Golden Rules only a person can check, the score beside an open critical item, and its warning. */
describe("possible critical issues: mandatory Golden Rules in words, score note, warning", () => {
  const WORDS = "This rule is written in words, so it isn't checked automatically — review it by eye.";
  const wordsRule = (mandatory: boolean) =>
    f("golden_rules", "unverified", mandatory ? "critical" : "major", { ruleId: `golden_rules.rule.${mandatory ? "logo_rule" : "other"}`, title: "Golden Rule: Logo top-left", mandatory, explanation: WORDS });
  const board = (findings: Finding[]) => scoreFindings(findings);
  const label = (findings: Finding[]) => {
    const shown = resultDisplay(board(findings));
    return shown ? RESULT_DISPLAY_LABEL[shown] : null;
  };

  it("a MANDATORY Golden Rule that can only be checked by eye can't produce PASS — CHECK BEFORE SENDING, still not counted", () => {
    const b = board([f("brief", "passed"), wordsRule(true)]);
    expect(b).toMatchObject({ result: "pass", possibleCriticals: 1, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(label([f("brief", "passed"), wordsRule(true)])).toBe("CHECK BEFORE SENDING");
  });

  it("an OPTIONAL Golden Rule in words isn't a possible critical issue (unchanged)", () => {
    expect(board([f("brief", "passed"), wordsRule(false)]).possibleCriticals).toBe(0);
    expect(label([f("brief", "passed"), wordsRule(false)])).toBe("PASS");
  });

  it("a mandatory Golden Rule with no approved value saved is a settings gap, not an item to verify (unchanged)", () => {
    const noValue = f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.approved_font", mandatory: true, explanation: "No approved value is saved for this rule, so there's nothing to compare with. Add one on the company page." });
    expect(board([f("brief", "passed"), noValue]).possibleCriticals).toBe(0);
  });

  it("the score note: only while a possible critical issue is open, and only when there is a score", () => {
    expect(scoreNote(board([f("brief", "passed"), human("brief", "critical")]))).toBe("Confirmed checks only — 1 possible critical issue still to check by eye.");
    expect(scoreNote(board([f("brief", "passed"), human("brief", "critical"), wordsRule(true)]))).toBe("Confirmed checks only — 2 possible critical issues still to check by eye.");
    expect(scoreNote(board([f("brief", "passed"), human("brief", "major")]))).toBeNull();
    expect(scoreNote(board([f("brief", "passed")]))).toBeNull();
    expect(scoreNote({ score: null, possibleCriticals: 2, settingsBlockers: 1 })).toBeNull();
    // The score itself is unchanged: the open item doesn't count.
    expect(board([f("brief", "passed"), human("brief", "critical")]).score).toBe(100);
  });

  it("NEEDS REVISION with a possible critical issue warns about it; nothing else does", () => {
    const revise = board([f("brand", "failed", "major"), human("brief", "critical")]);
    expect(resultDisplay(revise)).toBe("needs_revision");
    expect(possibleCriticalWarning(revise)).toBe("Also check 1 possible critical issue marked below by eye before sending — if confirmed, this design fails.");
    expect(possibleCriticalWarning(board([f("brand", "failed", "minor"), wordsRule(true), human("legal", "critical")]))).toMatch(/^Also check 2 possible critical issues/);
    expect(possibleCriticalWarning(board([f("brand", "failed", "major")]))).toBeNull(); // nothing to warn about
    expect(possibleCriticalWarning(board([f("brief", "failed", "critical"), human("brand", "critical")]))).toBeNull(); // FAIL already says don't send
    expect(possibleCriticalWarning(board([f("brief", "passed"), human("brief", "critical")]))).toBeNull(); // CHECK BEFORE SENDING says it itself
  });
});

/**
 * Stage 1 policy fix: a MANDATORY Golden Rule with no approved value saved can't be checked. It's a
 * company-settings gap — never counted as a design failure — but it must not let the design pass silently.
 */
describe("CHECK COMPANY SETTINGS: a mandatory Golden Rule with no approved value saved", () => {
  const NO_VALUE = "No approved value is saved for this rule, so there's nothing to compare with. Add one on the company page.";
  const noValue = (mandatory = true) =>
    f("golden_rules", "unverified", mandatory ? "critical" : "major", { ruleId: "golden_rules.rule.approved_font", title: "Golden Rule: Headlines in Montserrat", mandatory, explanation: NO_VALUE });
  const view = (findings: Finding[]) => {
    const board = scoreFindings(findings);
    const display = resultDisplay(board);
    return { board, display, label: display ? RESULT_DISPLAY_LABEL[display] : null, summary: display ? RESULT_DISPLAY_SUMMARY[display] : null };
  };

  it("would-be PASS → CHECK COMPANY SETTINGS; not counted, the score is unchanged", () => {
    const v = view([f("brief", "passed"), noValue()]);
    expect(v.board).toMatchObject({ result: "pass", settingsBlockers: 1, possibleCriticals: 0, score: 100, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(v).toMatchObject({ display: "check_company_settings", label: "CHECK COMPANY SETTINGS" });
    expect(v.summary).toMatch(/mandatory Golden Rule couldn't be checked because its approved value is missing or invalid/);
    expect(v.summary).toMatch(/company page/);
    expect(scoreNote(v.board)).toBe("Confirmed checks only — 1 mandatory Golden Rule not checked (approved value missing or invalid).");
    expect(settingsWarning(v.board)).toBeNull(); // the label says it already
  });

  it("an OPTIONAL rule with no value saved, or brand settings missing, still allow PASS (unchanged)", () => {
    expect(view([f("brief", "passed"), noValue(false)]).label).toBe("PASS");
    const brandFonts = f("brand", "unverified", "major", { ruleId: "brand.fonts", explanation: "No brand fonts are saved for this company. Add them on the company page." });
    expect(view([f("brief", "passed"), brandFonts]).label).toBe("PASS");
  });

  it("a possible critical issue on the design comes first; the settings gap is then a warning line", () => {
    const v = view([f("brief", "passed"), noValue(), human("brief", "critical")]);
    expect(v.label).toBe("CHECK BEFORE SENDING");
    expect(settingsWarning(v.board)).toBe("1 mandatory Golden Rule couldn't be checked because its approved value is missing or invalid — fix it on the company page.");
    expect(scoreNote(v.board)).toBe("Confirmed checks only — 1 possible critical issue still to check by eye; 1 mandatory Golden Rule not checked (approved value missing or invalid).");
  });

  it("NEEDS REVISION and FAIL keep their label and carry the settings warning; two rules are counted", () => {
    const revise = view([f("brand", "failed", "major"), noValue(), noValue()]);
    expect(revise.label).toBe("NEEDS REVISION");
    expect(settingsWarning(revise.board)).toBe("2 mandatory Golden Rules couldn't be checked because their approved values are missing or invalid — fix them on the company page.");
    const fail = view([f("brief", "failed", "critical"), noValue()]);
    expect(fail.label).toBe("FAIL");
    expect(settingsWarning(fail.board)).toMatch(/^1 mandatory Golden Rule couldn't be checked/);
  });

  it("no answered check → no result and no warning", () => {
    const v = view([noValue()]);
    expect(v.label).toBeNull();
    expect(settingsWarning(v.board)).toBeNull();
  });

  it("invariant: with a mandatory rule unchecked, the label never says PASS", () => {
    for (const severity of ["critical", "major", "minor", "suggestion"] as const)
      for (const status of ["passed", "failed", "unverified", "not_applicable"] as const) {
        const { label } = view([f("content", status, severity), f("brief", "passed"), noValue()]);
        if (label) expect([severity, status, label]).toEqual([severity, status, expect.not.stringMatching(/PASS/)]);
      }
  });
});

describe("CHECK COMPANY SETTINGS: a mandatory colour Golden Rule with an invalid saved colour", () => {
  const invalid = (mandatory = true) =>
    f("golden_rules", "unverified", mandatory ? "critical" : "major", { ruleId: "golden_rules.rule.approved_color", title: "Golden Rule: Use brand navy", mandatory, explanation: "The colour saved for this rule (\"navy\") isn't a colour code (#RRGGBB), so it can't be compared. Fix it on the company page." });
  const label = (findings: Finding[]) => {
    const shown = resultDisplay(scoreFindings(findings));
    return shown ? RESULT_DISPLAY_LABEL[shown] : null;
  };

  it("would-be PASS → CHECK COMPANY SETTINGS, the same as a missing value; nothing counted, score unchanged", () => {
    const board = scoreFindings([f("brief", "passed"), invalid()]);
    expect(board).toMatchObject({ result: "pass", settingsBlockers: 1, possibleCriticals: 0, score: 100, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(label([f("brief", "passed"), invalid()])).toBe("CHECK COMPANY SETTINGS");
    expect(scoreNote(board)).toBe("Confirmed checks only — 1 mandatory Golden Rule not checked (approved value missing or invalid).");
  });

  it("beside NEEDS REVISION it's the settings warning; an optional rule with an invalid colour still allows PASS", () => {
    const revise = scoreFindings([f("brand", "failed", "major"), invalid()]);
    expect(settingsWarning(revise)).toBe("1 mandatory Golden Rule couldn't be checked because its approved value is missing or invalid — fix it on the company page.");
    expect(label([f("brief", "passed"), invalid(false)])).toBe("PASS");
  });
});

/** Stage 1 review: a MANDATORY Golden Rule the analysis couldn't check is never passed silently. */
describe("a mandatory Golden Rule the analysis couldn't check", () => {
  const unchecked = (mandatory: boolean, explanation = "The analysis didn't produce what this check needs, so it couldn't be checked. Not counted for or against the result.") =>
    f("golden_rules", "unverified", mandatory ? "critical" : "major", { ruleId: "golden_rules.rule.approved_color", title: "Golden Rule: Use brand blue", mandatory, explanation });
  const label = (findings: Finding[]) => {
    const shown = resultDisplay(scoreFindings(findings));
    return shown ? RESULT_DISPLAY_LABEL[shown] : null;
  };

  it("is a possible critical issue to check by eye → CHECK BEFORE SENDING; nothing counted", () => {
    const board = scoreFindings([f("brief", "passed"), unchecked(true)]);
    expect(board).toMatchObject({ result: "pass", possibleCriticals: 1, settingsBlockers: 0, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(label([f("brief", "passed"), unchecked(true)])).toBe("CHECK BEFORE SENDING");
    // Any other reason it couldn't be checked automatically, too.
    expect(label([f("brief", "passed"), unchecked(true, "This kind of rule isn't checked automatically.")])).toBe("CHECK BEFORE SENDING");
  });

  it("an optional one stays a 'not checked' note — the design can pass (unchanged)", () => {
    expect(scoreFindings([f("brief", "passed"), unchecked(false)]).possibleCriticals).toBe(0);
    expect(label([f("brief", "passed"), unchecked(false)])).toBe("PASS");
  });

  it("missing or invalid settings stay CHECK COMPANY SETTINGS, not an item to verify", () => {
    const noValue = unchecked(true, "No approved value is saved for this rule, so there's nothing to compare with. Add one on the company page.");
    expect(scoreFindings([f("brief", "passed"), noValue])).toMatchObject({ possibleCriticals: 0, settingsBlockers: 1 });
  });
});
