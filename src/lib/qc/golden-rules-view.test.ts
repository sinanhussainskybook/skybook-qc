import { describe, expect, it } from "vitest";
import { applyConfidencePolicy } from "@/lib/analysis/policy";
import type { Finding } from "@/lib/qc/findings";
import { alsoNote, mergeDuplicateFindings, missingCompanySetting, needsVerifying, splitNotChecked, verifyNote } from "@/lib/qc/golden-rules-view";
import { scoreFindings } from "@/lib/qc/scoring";
import { byRule, company, detections, golden, only, requirement, run, text } from "../../../test/qc-fixtures";

/** Golden Rules in one place, and the same issue never counted twice. */
describe("Golden Rules — duplicates and grouping", () => {
  const ctaDesign = detections({ texts: [text("Book today", { role: "cta" })] });
  const withCtaRule = (over: Partial<Parameters<typeof golden>[0]> = {}) =>
    company({ goldenRules: [golden({ category: "approved_cta", rule: "Always use Book now", approved_value: "Book now", mandatory: false, ...over })] });

  it("every active Golden Rule is checked and carries its mandatory flag; inactive ones are skipped", () => {
    const findings = run({
      company: company({
        goldenRules: [
          golden({ category: "approved_cta", approved_value: "Book now", mandatory: true }),
          golden({ category: "logo_rule", rule: "Logo top-left", mandatory: false }),
          golden({ category: "approved_color", approved_value: "#1A64B4", active: false }),
        ],
      }),
      detections: ctaDesign,
    });
    const rules = byRule(findings, "golden_rules");
    expect(rules.map((f) => [f.ruleId, f.status, f.mandatory])).toEqual([
      ["golden_rules.rule.approved_cta", "failed", true],
      ["golden_rules.rule.logo_rule", "unverified", false],
    ]);
  });

  it("a broken Golden Rule and the brief's broken CTA with the same value are ONE issue: shown once, counted once, at the more serious severity", () => {
    const findings = run({ company: withCtaRule(), requirements: [requirement("cta", "Book now", { mandatory: true })], detections: ctaDesign });
    const goldenCta = only(findings, "golden_rules.rule.approved_cta");
    const briefCta = only(findings, "brief.requirement.cta");
    expect([goldenCta.status, goldenCta.severity, briefCta.status, briefCta.severity]).toEqual(["failed", "major", "failed", "critical"]);

    const merged = mergeDuplicateFindings(findings);
    expect(byRule(merged, "brief.requirement.cta")).toHaveLength(0);
    const kept = only(merged, "golden_rules.rule.approved_cta");
    expect(kept).toMatchObject({ severity: "critical", mandatory: false, alsoCovers: [{ ruleId: "brief.requirement.cta", category: "brief", title: briefCta.title }] });
    // Everything else is untouched, in the same order.
    expect(merged.filter((f) => f !== kept)).toEqual(findings.filter((f) => f !== goldenCta && f !== briefCta));

    // Score consistency: the issue counts once — no double penalty — and the result is unchanged (still FAIL).
    const before = scoreFindings(findings);
    const after = scoreFindings(merged);
    expect(before.issues).toMatchObject({ critical: 1, major: 1 });
    expect(after.issues).toMatchObject({ critical: 1, major: 0 });
    expect(after.counting).toHaveLength(before.counting.length - 1);
    expect([before.result, after.result]).toEqual(["fail", "fail"]);
    expect(after.score).toBeGreaterThanOrEqual(before.score!);
  });

  it("a missing mandatory disclaimer that is both a Golden Rule and in the brief (legal) is one issue", () => {
    const findings = run({
      company: company({ goldenRules: [golden({ category: "mandatory_disclaimer", rule: "Always show T&Cs", approved_value: "T&Cs apply" })] }),
      requirements: [requirement("disclaimer", "T&Cs apply")],
      detections: detections({ texts: [text("Summer sale")] }),
    });
    expect([only(findings, "golden_rules.rule.mandatory_disclaimer").status, only(findings, "legal.disclaimer").status]).toEqual(["failed", "failed"]);
    const merged = mergeDuplicateFindings(findings);
    expect(byRule(merged, "legal.disclaimer")).toHaveLength(0);
    expect(only(merged, "golden_rules.rule.mandatory_disclaimer").alsoCovers?.map((c) => c.ruleId)).toEqual(["legal.disclaimer"]);
    expect(scoreFindings(merged).issues.critical).toBe(1);
  });

  it("never merges what isn't the same issue: a different value, one passed and one failed, or a rule with no brief counterpart", () => {
    // Different expected values: the Golden Rule wants "Book now", the brief "Reserve now".
    const different = run({ company: withCtaRule(), requirements: [requirement("cta", "Reserve now")], detections: ctaDesign });
    expect(mergeDuplicateFindings(different)).toEqual(different);
    // The brief's CTA is met while the Golden Rule is broken: two different answers, both kept.
    const mixed = run({ company: withCtaRule(), requirements: [requirement("cta", "Book today")], detections: ctaDesign });
    expect([only(mixed, "golden_rules.rule.approved_cta").status, only(mixed, "brief.requirement.cta").status]).toEqual(["failed", "passed"]);
    expect(mergeDuplicateFindings(mixed)).toEqual(mixed);
    // Similar wording isn't enough: a colour rule is never merged with anything.
    const f = (over: Partial<Finding>): Finding => ({ ruleId: "x", category: "brand", title: "t", severity: "major", status: "failed", kind: "fact", explanation: "e", confidence: 1, ...over });
    const colours = [f({ ruleId: "golden_rules.rule.approved_color", category: "golden_rules", expected: "#1A64B4" }), f({ ruleId: "brand.colors", expected: "#1A64B4" })];
    expect(mergeDuplicateFindings(colours)).toEqual(colours);
    // The same rule on two different files: each file's issue stays its own.
    const files = [
      f({ ruleId: "golden_rules.rule.approved_cta", category: "golden_rules", expected: "Book now", fileId: "a" }),
      f({ ruleId: "brief.requirement.cta", category: "brief", expected: "Book now", fileId: "b" }),
    ];
    expect(mergeDuplicateFindings(files)).toEqual(files);
  });

  it("only what a person genuinely has to look at needs verifying: an uncertain AI finding, or a rule written only in words — not a rule that's simply missing its approved value", () => {
    const findings = run({
      company: company({
        goldenRules: [
          golden({ category: "logo_rule", rule: "Logo top-left" }), // words only: checked by eye
          golden({ category: "approved_cta", rule: "Always use Book now" }), // no approved value saved
          golden({ category: "approved_color", rule: "Use Skybook blue", approved_value: "#1A64B4" }),
        ],
      }),
      detections: detections({ texts: [text("Book now", { role: "cta" })], colors: [{ hex: "#1A64B4", share: 0.4 }] }),
    });
    const rule = (id: string) => only(findings, `golden_rules.rule.${id}`);
    expect(["logo_rule", "approved_cta", "approved_color"].map((id) => [id, rule(id).status, needsVerifying(rule(id))])).toEqual([
      ["logo_rule", "unverified", true],
      ["approved_cta", "unverified", false],
      ["approved_color", "passed", false],
    ]);
    expect(verifyNote(rule("logo_rule"))).toBe("Check the design follows this rule — it can't be checked automatically.");
    const unsure: Finding = { ruleId: "brand.logo", category: "brand", title: "Logo", severity: "major", status: "unverified", kind: "fact", explanation: "Needs a human check: unsure.", confidence: 0.5 };
    expect([needsVerifying(unsure), verifyNote(unsure)]).toEqual([true, "Check this on the design — the AI wasn't sure."]);
    // When there is an expected value, the note says exactly what to look for.
    expect(verifyNote({ ...unsure, expected: "AED 1,299" })).toBe('Check the design for "AED 1,299" — the AI wasn\'t sure.');
    // The rule with no approved value is a missing company setting — not something to verify, not a mistake.
    expect(missingCompanySetting(rule("approved_cta"))).toBe(true);
    expect(splitNotChecked([rule("approved_cta")])).toEqual({ settings: [rule("approved_cta")], auto: [] });
    // Never counted: an uncertain finding isn't a confirmed mistake.
    expect(scoreFindings(findings).issues).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 });
  });
});

/** The same underlying issue reported by two checks: shown once, counted once — and only then. */
describe("duplicate findings across checks", () => {
  // As loadSessionResult builds them: the real rules, then the confidence policy (Gemini), then the merge.
  const analyse = (over: Parameters<typeof run>[0]) => {
    const raw = run(over);
    return applyConfidencePolicy(raw, over?.detections ?? null, { state: "done" }, { provider: "gemini" });
  };
  const ids = (findings: Finding[]) => findings.map((f) => f.ruleId);

  it("a Golden Rule and the brief's CTA that are both 'Please verify' are ONE item to verify — the Golden Rule, with its mandatory label and note", () => {
    const findings = analyse({
      company: company({ goldenRules: [golden({ category: "approved_cta", rule: "Always use Book now", approved_value: "Book now", mandatory: true })] }),
      requirements: [requirement("cta", "Book now")],
      detections: detections({ source: "ai", textCoverage: 0.97, texts: [text("Book today", { role: "cta", confidence: 0.96 })] }),
    });
    const goldenCta = only(findings, "golden_rules.rule.approved_cta");
    const briefCta = only(findings, "brief.requirement.cta");
    expect([needsVerifying(goldenCta), needsVerifying(briefCta)]).toEqual([true, true]);
    const merged = mergeDuplicateFindings(findings);
    expect(byRule(merged, "brief.requirement.cta")).toHaveLength(0);
    expect(only(merged, "golden_rules.rule.approved_cta")).toMatchObject({ status: "unverified", mandatory: true, alsoCovers: [{ ruleId: "brief.requirement.cta" }] });
    expect(merged.filter(needsVerifying)).toHaveLength(findings.filter(needsVerifying).length - 1);
    expect(verifyNote(only(merged, "golden_rules.rule.approved_cta"))).toBe('Check the design for "Book now" — the AI wasn\'t sure.');
  });

  it("the brief's phone and the contact-details check that found the same wrong number are one issue, counted once", () => {
    const d = detections({ textCoverage: 0.99, texts: [text("Call +971 4 123 4568", { confidence: 0.99 })] });
    const findings = run({ requirements: [requirement("phone", "+971 4 123 4567")], detections: d });
    const brief = only(findings, "brief.requirement.phone");
    const contact = only(findings, "content.contact_details.phone");
    expect([brief.status, brief.detected, contact.status, contact.detected]).toEqual(["failed", "+971 4 123 4568", "failed", "+971 4 123 4568"]);
    const merged = mergeDuplicateFindings(findings);
    expect(byRule(merged, "content.contact_details.phone")).toHaveLength(0);
    expect(only(merged, "brief.requirement.phone")).toMatchObject({ severity: "critical", alsoCovers: [{ ruleId: "content.contact_details.phone", title: "Phone / WhatsApp number" }] });
    // Scoring: the confirmed duplicate no longer counts twice; nothing else changes.
    const before = scoreFindings(findings);
    const after = scoreFindings(merged);
    expect(after.counting).toHaveLength(before.counting.length - 1);
    expect(after.result).toBe(before.result);
  });

  it("the brief's website and the contact-details check that found the same wrong address are one issue", () => {
    const d = detections({ textCoverage: 0.99, texts: [text("Visit skybookvilas.com", { confidence: 0.99 })] });
    const findings = run({ requirements: [requirement("website", "skybookvillas.com")], detections: d });
    expect([only(findings, "brief.requirement.website").detected, only(findings, "content.contact_details.website").detected]).toEqual(["skybookvilas.com", "skybookvilas.com"]);
    const merged = mergeDuplicateFindings(findings);
    expect(ids(merged)).not.toContain("content.contact_details.website");
    expect(only(merged, "brief.requirement.website").alsoCovers?.map((c) => c.ruleId)).toEqual(["content.contact_details.website"]);
  });

  it("the company's name misspelt and the same name as an approved term misspelt the same way are one issue", () => {
    const d = detections({ textCoverage: 0.99, texts: [text("Welcome to Skybook Vilas", { confidence: 0.99 })] });
    const findings = run({ detections: d });
    const name = only(findings, "content.company_name");
    const term = byRule(findings, "brand.terms").find((f) => f.status === "failed")!;
    // Both checks found exactly the same misspelt text, for the same expected name.
    expect([term.expected, term.detected]).toEqual([name.expected, name.detected]);
    expect(name.detected?.toLowerCase()).toBe("skybook vilas");
    const merged = mergeDuplicateFindings(findings);
    expect(byRule(merged, "brand.terms").filter((f) => f.status === "failed")).toHaveLength(0);
    expect(only(merged, "content.company_name").alsoCovers?.map((c) => c.title)).toEqual(["Terminology"]);
    expect(scoreFindings(merged).issues.major).toBe(scoreFindings(findings).issues.major - 1);
  });

  it("a merged finding's note: what it was also required or flagged by — counted once for an issue, shown once for an item to verify", () => {
    expect(alsoNote("Brief — CTA (call to action)")).toBe("Also required by the brief — counted once.");
    expect(alsoNote("Legal & Compliance — Disclaimer")).toBe("Also required by the legal check — counted once.");
    expect(alsoNote("Content — Website")).toBe("Also flagged by the company's contact details — counted once.");
    expect(alsoNote("Content — Phone / WhatsApp number")).toBe("Also flagged by the company's contact details — counted once.");
    expect(alsoNote("Brand — Terminology")).toBe("Also flagged by the brand's approved terms — counted once.");
    expect(alsoNote("Brief — CTA (call to action)", true)).toBe("Also required by the brief — shown once.");
  });

  it("distinct issues stay separate: several wrong numbers, another term, a mistake beside a 'Please verify', another file", () => {
    // Two different wrong numbers: the brief lists both, the contact check one per number — different occurrences.
    const two = run({
      requirements: [requirement("phone", "+971 4 123 4567")],
      detections: detections({ textCoverage: 0.99, texts: [text("Call +971 4 123 4568 or +971 4 999 9999", { confidence: 0.99 })] }),
    });
    expect(byRule(two, "content.contact_details.phone").filter((f) => f.status === "failed")).toHaveLength(2);
    expect(mergeDuplicateFindings(two)).toEqual(two);
    // A misspelt approved term that isn't the company's name is its own issue.
    const otherTerm = run({
      company: company({ brand: { ...company().brand, terms: [{ id: "t1", term: "Palm Residence", kind: "approved", note: null, created_at: new Date(), updated_at: new Date() }] } }),
      detections: detections({ textCoverage: 0.99, texts: [text("Skybook Vilas — Palm Residense", { confidence: 0.99 })] }),
    });
    expect(mergeDuplicateFindings(otherTerm)).toEqual(otherTerm);
    // The same value, but a confirmed mistake on one side and a "Please verify" on the other: not merged.
    const f = (over: Partial<Finding>): Finding => ({ ruleId: "x", category: "brief", title: "t", severity: "critical", status: "failed", kind: "fact", explanation: "e", confidence: 1, expected: "Book now", detected: "Book today", ...over });
    const mixed = [
      f({ ruleId: "golden_rules.rule.approved_cta", category: "golden_rules", status: "failed" }),
      f({ ruleId: "brief.requirement.cta", status: "unverified", explanation: "Needs a human check: unsure." }),
    ];
    expect(mergeDuplicateFindings(mixed)).toEqual(mixed);
    // The same wrong number on two different files: two occurrences.
    const files = [
      f({ ruleId: "brief.requirement.phone", expected: "+971 4 123 4567", detected: "+971 4 123 4568", fileId: "a" }),
      f({ ruleId: "content.contact_details.phone", category: "content", expected: "+971 4 123 4567", detected: "+971 4 123 4568", fileId: "b" }),
    ];
    expect(mergeDuplicateFindings(files)).toEqual(files);
  });
});
