import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Scoreboard } from "@/components/qc/scoreboard";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { mergeDuplicateFindings } from "@/lib/qc/golden-rules-view";
import { scoreFindings } from "@/lib/qc/scoring";
import type { QcSession } from "@/lib/db/qc-sessions";
import { buildReportData } from "@/lib/report/report-data";
import { renderReportPdf } from "@/lib/report/report-pdf";
import { company } from "../../../test/qc-fixtures";

const session = { id: "s1", company_id: "c1", user_id: "u1", content_type: "social_post", platform: null, placement: null, status: "ready" } as unknown as QcSession;

/** The website's results: Golden Rules with the other issues (no section of their own); items to verify by eye. */
let n = 0;
const f = (category: Category, status: FindingStatus, severity: Severity, over: Partial<Finding> = {}): Finding => ({
  ruleId: `x.${++n}`,
  category,
  title: "Check",
  severity,
  status,
  kind: "fact",
  explanation: "Explained.",
  confidence: 1,
  ...over,
});
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

function render(findings: Finding[]) {
  return visible(renderToStaticMarkup(<Scoreboard board={scoreFindings(findings)} findings={findings} />));
}

describe("Results page — Golden Rules and items to verify", () => {
  const findings = () =>
    mergeDuplicateFindings([
      f("golden_rules", "failed", "major", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: false, expected: "Book now", detected: "Book today", suggestedFix: 'Use "Book now".' }),
      f("brief", "failed", "critical", { ruleId: "brief.requirement.cta", title: "CTA (call to action)", expected: "Book now", detected: "Book today", suggestedFix: 'Use "Book now".' }),
      f("golden_rules", "failed", "critical", { ruleId: "golden_rules.rule.approved_font", title: "Golden Rule: Headlines in Montserrat", mandatory: true, expected: "Montserrat", detected: "Poppins", suggestedFix: "Use Montserrat only." }),
      f("golden_rules", "passed", "critical", { ruleId: "golden_rules.rule.approved_color", title: "Golden Rule: Use Skybook blue", mandatory: true }),
      f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.logo_rule", title: "Golden Rule: Logo top-left", mandatory: true, explanation: "This rule is written in words, so it isn't checked automatically — review it by eye." }),
      f("brand", "unverified", "major", { title: "Logo", expected: "The company's logo", detected: "No logo", explanation: "Needs a human check: unsure." }),
      f("accessibility", "failed", "major", { title: "Text contrast", detected: "3.1 : 1", suggestedFix: "Darken the text." }),
      f("content", "passed", "major", { title: "Spelling" }),
    ]);

  it("no Golden Rules section: a broken rule is one of the issues to fix, under its severity, marked Golden Rule and Mandatory / Optional", () => {
    const text = render(findings());
    expect(text).not.toMatch(/active rules?|Other issues to fix|Followed:/);
    const issues = text.slice(text.indexOf("Issues to fix"), text.indexOf("Items to verify"));
    expect(issues).toContain('Critical Always use Book now Golden Rule Optional Found Book today Fix Use "Book now". Also required by the brief — counted once.');
    expect(issues).toContain("Critical Headlines in Montserrat Golden Rule Mandatory Found Poppins Fix Use Montserrat only.");
    expect(issues).toContain("Major Text contrast Accessibility");
    expect(text).not.toContain("Golden Rule:");
  });

  it("the same mistake in a Golden Rule and the brief is shown once and counted once", () => {
    const text = render(findings());
    expect(occurrences(text, "Book today")).toBe(1);
    expect(text).toContain("3 Issues to fix"); // the merged CTA, the font rule and contrast — not 4
  });

  it("items to verify: uncertain findings and rules written in words, each with a short reason — never counted", () => {
    const text = render(findings());
    expect(text).toContain("2 To verify");
    expect(text).toContain("Items to verify Please check these by eye before sending. They don't count for or against the result.");
    expect(text).toContain("Critical Please verify Logo top-left Golden Rule Mandatory Check Check the design follows this rule — it can't be checked automatically.");
    expect(text).toContain(`Major Please verify Logo Brand Expected The company's logo Found No logo Check Check the design for "The company's logo" — the AI wasn't sure.`);
    expect(text).not.toMatch(/Human checks?\b|Possible critical|Should be|AI read/);
  });

  it("a merged item to verify says once which other check it stands for", () => {
    const merged = mergeDuplicateFindings([
      f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: true, expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
      f("brief", "unverified", "critical", { ruleId: "brief.requirement.cta", title: "CTA (call to action)", expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
    ]);
    const text = render([...merged, f("content", "passed", "major")]);
    expect(text).toContain("1 To verify");
    expect(text).toContain(`Check Check the design for "Book now" — the AI wasn't sure. Also required by the brief — shown once.`);
    expect(text).not.toContain("Also in");
    expect(occurrences(text, "Book today")).toBe(1);
  });

  it("the website and the PDF give a merged finding the same words", async () => {
    const issue = (over: Partial<Finding>) => f("brief", "failed", "critical", { expected: "x", detected: "y", suggestedFix: "Fix it.", ...over });
    const merged = mergeDuplicateFindings([
      issue({ ruleId: "brief.requirement.phone", title: "Phone number", expected: "+971 4 123 4567", detected: "+971 4 123 4568" }),
      issue({ ruleId: "content.contact_details.phone", category: "content", title: "Phone / WhatsApp number", expected: "+971 4 123 4567", detected: "+971 4 123 4568" }),
      issue({ ruleId: "content.company_name", category: "content", severity: "major", title: "Company name spelling", expected: "Skybook Villas", detected: "skybookvilas" }),
      issue({ ruleId: "brand.terms", category: "brand", severity: "major", title: "Terminology", expected: "Skybook Villas", detected: "skybookvilas" }),
      f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: true, expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
      f("brief", "unverified", "critical", { ruleId: "brief.requirement.cta", title: "CTA (call to action)", expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
      f("content", "passed", "major"),
    ]);
    const notes = [
      "Also flagged by the company's contact details — counted once.",
      "Also flagged by the brand's approved terms — counted once.",
      "Also required by the brief — shown once.",
    ];
    const web = render(merged);
    const data = buildReportData({ config: company(), session, requirements: [], files: [], findings: merged, board: scoreFindings(merged), sampleData: false, provider: null, generatedAt: new Date("2026-10-06T10:30:00Z"), timeZone: "UTC" });
    const pdf = (await renderReportPdf(data, null)).lines.join(" ");
    for (const note of notes) expect([note, occurrences(web, note), occurrences(pdf, note)]).toEqual([note, 1, 1]);
  });

  it("followed Golden Rules are counted as passed, not listed", () => {
    const text = render(findings());
    expect(text).toContain("✓ 2 checks passed");
    expect(text).not.toContain("Use Skybook blue");
    expect(text).toContain("Content · Spelling");
  });

  it("what couldn't be checked: two short lines under Passed — missing company settings, and checks not done automatically; not issues", () => {
    const text = render([
      f("brand", "unverified", "major", { title: "Brand fonts", explanation: "No brand fonts are saved for this company. Add them on the company page." }),
      f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: true, explanation: "No approved value is saved for this rule, so there's nothing to compare with." }),
      f("image_asset", "unverified", "minor", { title: "Image quality", explanation: "Not verified: Gemini saw no problem here, but that isn't confirmed." }),
      f("content", "passed", "major"),
    ]);
    expect(text).toContain("Company settings missing (2): Brand fonts · Always use Book now (Golden Rule) — add them on the company page. They don't affect the result.");
    expect(text).toContain("Not checked automatically (1): Image quality — they don't affect the result.");
    expect(text).toContain("0 Issues to fix 0 To verify 1 Check passed");
    expect(text).toContain("PASS");
    expect(text).not.toContain("Items to verify");
  });

  it("a PASS with something to verify reads 'PASS — PLEASE VERIFY'", () => {
    const text = render([f("brand", "unverified", "major", { title: "Logo", explanation: "Needs a human check: unsure." }), f("content", "passed", "major")]);
    expect(text).toContain("PASS — PLEASE VERIFY");
    expect(text).toContain("No issues found — but please verify the items marked below before sending it to the client.");
    expect(text).not.toContain("HUMAN CHECK REQUIRED");
  });
});
