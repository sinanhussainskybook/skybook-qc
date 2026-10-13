import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import type { QcFile, QcRequirement, QcSession } from "@/lib/db/qc-sessions";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { scoreFindings } from "@/lib/qc/scoring";
import { mergeDuplicateFindings } from "@/lib/qc/golden-rules-view";
import { buildReportData, formatReportDate, type ReportItem } from "@/lib/report/report-data";
import { logoForReport } from "@/lib/report/report-logo";
import { displayTitle, groupRelated, groupSections, renderReportPdf, reportFileName, splitIssues, type ReportLogo } from "@/lib/report/report-pdf";
import { shapeArabic, woffToSfnt, type FontFiles } from "@/lib/report/report-fonts";
import { pdfText } from "@/lib/analysis/media/pdf";
import { company } from "../../../test/qc-fixtures";

/** Phase 8 — the PDF QC report, built from the current session's findings and Phase 7 result. */

const T = new Date("2026-10-06T10:30:00Z");
const session = { id: "s1", company_id: company().company.id, user_id: "u1", content_type: "social_post", platform: "instagram", placement: "feed_image", status: "ready" } as unknown as QcSession;
const files = [{ id: "f1", kind: "content", file_name: "summer-post.png", status: "ready" }] as unknown as QcFile[];
const req = (type: string, value: string, over: Partial<QcRequirement> = {}) => ({ id: type, session_id: "s1", type, label: null, expected_value: value, notes: null, mandatory: true, confirmed: true, source: "manual", ...over }) as unknown as QcRequirement;
let n = 0;
const f = (category: Category, status: FindingStatus, severity: Severity = "major", over: Partial<Finding> = {}): Finding => ({
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

async function report(findings: Finding[], over: { requirements?: QcRequirement[]; logo?: ReportLogo; sampleData?: boolean; companyName?: string; fonts?: FontFiles | null | "auto" } = {}) {
  const config = company(over.companyName ? { company: { ...company().company, name: over.companyName } } : {});
  const data = buildReportData({
    config,
    session,
    requirements: over.requirements ?? [],
    files,
    findings,
    board: scoreFindings(findings),
    sampleData: over.sampleData ?? false,
    provider: null,
    generatedAt: T,
    timeZone: "Asia/Dubai",
  });
  const pdf = await renderReportPdf(data, over.logo ?? null, "fonts" in over ? (over.fonts ?? null) : "auto");
  const text = pdf.lines.join("\n");
  const doc = await PDFDocument.load(pdf.bytes);
  return { data, text, pages: doc.getPageCount(), doc, bytes: pdf.bytes, unicode: pdf.unicode };
}

/** The text MuPDF reads back from each page (what a person sees), whitespace-collapsed. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const read = await pdfText(bytes, 50);
  if ("unsupported" in read) throw new Error(read.unsupported);
  return read.pages.map((p) => p.replace(/\s+/g, " "));
}

/** How many times `needle` occurs in `text`. */
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("QC report", () => {
  /** The drawn text contains these lines one after another. */
  const inOrder = (text: string, ...parts: string[]) => expect(text).toContain(parts.join("\n"));
  const flat = (text: string) => text.replace(/\n/g, " ");

  it("header: the blue band and title, company / design file / report date, the result and score, one line of counts; a valid one-page PDF", async () => {
    const r = await report([f("brief", "passed"), f("brand", "passed")]);
    expect(String.fromCharCode(...r.bytes.slice(0, 5))).toBe("%PDF-");
    expect(r.doc.getTitle()).toBe("Skybook AI QC report — Skybook Villas");
    inOrder(r.text, "SKYBOOK AI QC", "AI Design QC Report", "COMPANY", "Skybook Villas", "DESIGN FILE", "summer-post.png", "REPORT DATE", "6 October 2026 at 14:30 GST", "Checked as Social Media Post · Instagram — Feed image");
    inOrder(r.text, "100", "/ 100", "RESULT", "PASS", "No issues to fix in the checks that could be verified.");
    inOrder(r.text, "0 Critical", "0 Major", "0 Minor", "0 Suggestions", "0 To verify", "2 Passed");
    expect(flat(r.text)).toContain("No issues to fix. Nothing to fix or verify.");
    expect(r.text).not.toContain("SEVERITY"); // no empty table
    expect(r.pages).toBe(1); // no separate cover page: a clean report is one page
  });

  it("in short: passed as a count — no lists of passed checks, no category score bars", async () => {
    const r = await report([f("brief", "passed"), f("brand", "passed")], { requirements: [req("headline", "Live by the sea")] });
    inOrder(r.text, "IN SHORT", "2 checks passed.");
    expect(r.text).not.toMatch(/Brief requirements met|Score by category|Not scored|Followed/);
  });

  it("PASS with something to verify → 'PASS — PLEASE VERIFY'; the item sits in its severity group with a short 'Please verify' note — no Human review section", async () => {
    const humanPrice = f("brief", "unverified", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "AED 1,399", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` });
    const r = await report([f("brand", "passed"), humanPrice, f("brand", "unverified", "major", { title: "Brand fonts", explanation: "None saved." })]);
    expect(r.data).toMatchObject({ result: "pass", resultLabel: "PASS — PLEASE VERIFY", humanCheckCount: 1 });
    expect(r.data.issues).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 }); // the human check still doesn't count
    expect(r.text.split("\n")).toContain("PASS — PLEASE VERIFY"); // one line, not wrapped
    expect(flat(r.text)).toContain("No issues found — but please verify the items marked below before sending it to the client.");
    inOrder(r.text, "FINDINGS", "SEVERITY", "ISSUE", "SUGGESTED FIX", "CRITICAL", "1 to verify", "CRITICAL", "PLEASE VERIFY", "Price", "Brief", "Expected: AED 1,299", "Found: AED 1,399");
    expect(flat(r.text)).toContain('Found: AED 1,399 Please verify: Check the design for "AED 1,299" — the AI wasn\'t sure.');
    expect(r.text).not.toMatch(/HUMAN REVIEW|judged by AI|Should be|AI read/); // no separate section, no technical wording
    expect(flat(r.text)).toContain("1 check passed.");
    expect(flat(r.text)).toContain("Not checked automatically (1): Brand fonts — they don't affect the result.");
    const clean = await report([f("brand", "passed")]);
    expect(clean.data.resultLabel).toBe("PASS");
    expect(clean.text).not.toContain("PLEASE VERIFY");
  });

  it("layout: header → one findings table (Severity | Issue | Suggested fix) grouped by severity, items to verify beside the issues of their severity → in short; each issue once, no long explanations", async () => {
    const r = await report([
      f("brief", "failed", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "Not found", explanation: "The brief asks for this, but it isn't in the content.", suggestedFix: 'Add "AED 1,299".' }),
      f("brand", "failed", "minor", { title: "Brand colours used", detected: "#FFFFFF (99%)", explanation: "Barely used.", suggestedFix: "Use the brand colours." }),
      f("platform_size", "failed", "suggestion", { title: "Recommended resolution", detected: "1080 × 1350", suggestedFix: "Export larger." }),
      f("brand", "unverified", "major", { title: "Logo", expected: "The company's logo", detected: "No logo", explanation: `${HUMAN_CHECK_CRITICAL.split(" — ")[0]}: the AI wasn't clear about this.` }),
      f("brand", "unverified", "major", { title: "Brand fonts", explanation: "No brand fonts are saved for this company. Not counted for or against the result." }),
      f("content", "passed"),
      f("content", "passed"),
    ]);
    const lines = r.text.split("\n");
    const at = (s: string) => lines.indexOf(s);
    const order = ["RESULT", "FINDINGS", "SEVERITY", "CRITICAL", "MAJOR", "MINOR", "SUGGESTIONS", "IN SHORT"];
    for (const s of order) expect(at(s), s).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual(order.map(at).sort((a, b) => a - b));
    expect(lines).not.toContain("HUMAN REVIEW"); // no separate section
    for (const c of ["1 Critical", "0 Major", "1 Minor", "1 Suggestion", "1 To verify", "2 Passed"]) expect(lines).toContain(c);
    // Each group: a divider (name and count), then its rows — severity | issue (Expected / Found when there is something to compare) | fix.
    inOrder(r.text, "CRITICAL", "1", "CRITICAL", "Price", "Brief", "Expected: AED 1,299", "Found: Not found", 'Add "AED 1,299".');
    inOrder(r.text, "MINOR", "1", "MINOR", "Brand colours used", "Brand", "Found: #FFFFFF (99%)", "Use the brand colours.");
    inOrder(r.text, "SUGGESTIONS", "1", "SUGGESTION", "Recommended resolution", "Platform / Size", "Found: 1080 × 1350", "Export larger.");
    // The Logo the AI wasn't sure about: in the Major group (its severity), with a short note — not counted (0 Major).
    inOrder(r.text, "MAJOR", "1 to verify", "MAJOR", "PLEASE VERIFY", "Logo", "Brand", "Expected: The company's logo", "Found: No logo");
    expect(flat(r.text)).toContain(`Found: No logo Please verify: Check the design for "The company's logo" — the AI wasn't sure.`);
    expect(r.text).not.toContain("The AI wasn't clear about this.");
    // Less text: no long explanations or repeated reasons.
    expect(r.text).not.toContain("The brief asks for this, but it isn't in the content.");
    expect(r.text).not.toContain("Barely used.");
    expect(r.text).not.toContain("No brand fonts are saved");
    expect(flat(r.text)).toContain("Company settings missing (1): Brand fonts — add them on the company page. They don't affect the result.");
    expect(r.text).toContain("No requirements from the brief were checked.");
    // Each issue appears exactly once.
    for (const title of ["Price", "Brand colours used", "Recommended resolution", "Logo"]) expect([title, lines.filter((l) => l === title).length]).toEqual([title, 1]);
    // Presentation only: the report data (findings, counts, result) is exactly what the page uses.
    expect(r.data).toMatchObject({ result: "fail", passedCount: 2, humanCheckCount: 1, notVerifiedCount: 1, issues: { critical: 1, major: 0, minor: 1, suggestion: 1 } });
    expect(r.data.issuesToFix).toHaveLength(3);
    expect(r.pages).toBe(1);
  });

  it("every finding's essentials survive: title, expected, what was found and the fix — and why, for what needs a person to look", async () => {
    const findings = [
      f("brief", "failed", "major", { title: "Headline", expected: "Summer in the sun", detected: "Summer in the snow", explanation: "A different headline.", suggestedFix: "Use the brief's headline." }),
      f("legal", "failed", "minor", { title: "Disclaimer", expected: "T&C apply", detected: "T&C Apply", explanation: "Capitals differ.", suggestedFix: 'Show it exactly as "T&C apply".' }),
      f("design_layout", "failed", "suggestion", { title: "Rule of thirds", detected: "Off-centre", explanation: "A judgement.", suggestedFix: "Consider a thirds crossing." }),
      f("brand", "unverified", "major", { title: "Logo", expected: "The logo", detected: "Unclear", explanation: `${HUMAN_CHECK_CRITICAL.split(" — ")[0]}: unsure.` }),
      f("brand", "unverified", "major", { title: "Brand fonts", explanation: "None saved." }),
    ];
    const r = await report(findings);
    const text = flat(r.text);
    for (const it of [...r.data.issuesToFix, ...r.data.humanChecks]) {
      for (const s of [it.title, it.expected, it.detected, it.fix].filter((s): s is string => Boolean(s))) expect([it.title, s, text.includes(s)]).toEqual([it.title, s, true]);
    }
    expect(text).toContain('Please verify: Check the design for "The logo" — the AI wasn\'t sure.'); // exactly what to check
    expect(text).toContain("Not checked automatically (1): Brand fonts");
    for (const group of ["MAJOR", "MINOR", "SUGGESTIONS"]) expect(r.text.split("\n")).toContain(group);
    expect(r.text).not.toContain("HUMAN REVIEW");
  });

  it("a mandatory requirement is marked MANDATORY under its severity, even without the long explanation", async () => {
    const r = await report([
      f("brief", "failed", "major", { ruleId: "brief.requirement.dimensions", title: "Dimensions", expected: "1080 × 1080 px", detected: "1254 × 1254 px", explanation: "The design isn't the size the brief asks for. The brief marks it as mandatory.", suggestedFix: "Export at 1080 × 1080 px." }),
      f("brief", "failed", "major", { title: "Headline", expected: "A", detected: "B", explanation: "Different.", suggestedFix: "Use A." }),
    ]);
    inOrder(r.text, "MAJOR", "MANDATORY", "Dimensions", "Brief", "Expected: 1080 × 1080 px");
    expect(r.text.split("\n").filter((l) => l === "MANDATORY")).toHaveLength(1); // not on the optional one
    expect(r.text).not.toContain("The brief marks it as mandatory.");
  });

  it("NEEDS REVISION with only minor issues: one Minor group", async () => {
    const r = await report([f("design_layout", "failed", "minor", { title: "Text near the edge", detected: '"Book now" touches the edge', suggestedFix: "Move it in." }), f("brief", "passed")]);
    expect(r.text).toContain("NEEDS REVISION");
    expect(r.text).toContain("Fix the issues below before sending it to the client.");
    inOrder(r.text, "MINOR", "1", "MINOR", "Text near the edge", "Design & Layout", 'Found: "Book now" touches the edge', "Move it in.");
    for (const group of ["CRITICAL", "MAJOR"]) expect(r.text.split("\n")).not.toContain(group);
  });

  it("FAIL report with a critical finding: expected / found / fix and the file", async () => {
    const r = await report(
      [
        f("brief", "failed", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "AED 1,399", suggestedFix: 'Change it to "AED 1,299".', fileName: "summer-post.png" }),
        ...(["content", "brand", "golden_rules", "design_layout", "accessibility", "image_asset", "platform_size", "legal"] as Category[]).map((c) => f(c, "passed")),
      ],
      { requirements: [req("price", "AED 1,299"), req("cta", "Book now", { confirmed: false })] }
    );
    expect(r.data.result).toBe("fail");
    expect(r.text).toContain("FAIL");
    inOrder(r.text, "96", "/ 100"); // a high score never hides a critical
    inOrder(r.text, "CRITICAL", "1", "CRITICAL", "Price", "Brief · summer-post.png", "Expected: AED 1,299", "Found: AED 1,399", 'Change it to "AED 1,299".');
    expect(r.data.requirements).toEqual([{ type: "Price", value: "AED 1,299", mandatory: true, status: "To fix (Critical)" }]);
    // The failed requirement is the issue above — said once, not repeated in a requirements list.
    expect(occurrences(flat(r.text), "AED 1,299")).toBe(2); // its expected value and its fix
    expect(flat(r.text)).toContain("1 requirement(s) from the brief weren't part of this check — press Check Design again to include them.");
    expect(r.text).not.toContain("unconfirmed");
  });

  it("brief requirements: met ones are counted as passed, one with no check at all is named once, failed ones only as their issue", async () => {
    const r = await report(
      [
        f("brief", "passed", "critical", { ruleId: "brief.requirement.headline", title: "Headline", expected: "Live by the sea" }),
        f("brief", "failed", "major", { ruleId: "brief.requirement.cta", title: "CTA", expected: "Book now", detected: "Buy now", suggestedFix: 'Change it to "Book now".' }),
      ],
      { requirements: [req("headline", "Live by the sea"), req("cta", "Book now"), req("phone", "+971 4 123 4567", { mandatory: false })] }
    );
    const text = flat(r.text);
    expect(text).not.toContain("Live by the sea"); // passed: a count, not a list
    expect(text).toContain("Not checked from the brief (1): Phone number");
    expect(text).not.toMatch(/Company settings missing|Not checked automatically/);
    expect(occurrences(text, "Book now")).toBe(2); // the issue's expected value and its fix — not a third time in a list
  });

  it("repeats of the same issue are one row with every value found; different corrections are their own rows", async () => {
    const contrast = (detected: string) =>
      f("accessibility", "failed", "major", { title: "Text contrast", expected: "At least 4.5 : 1", detected, explanation: "Low contrast.", suggestedFix: "Darken the text." });
    const required = (expected: string, detected: string) =>
      f("brief", "failed", "major", { ruleId: "brief.requirement.required_text", title: "Required text: Required Text", expected, detected, explanation: "Written differently.", suggestedFix: `Write it exactly as "${expected}".` });
    const size = (detected: string) => f("accessibility", "failed", "minor", { title: "Text size", expected: "At least 19px", detected, suggestedFix: "Make it at least 19px tall." });
    const r = await report([
      contrast('2.37 : 1 — "TRAVELS"'),
      contrast('4.44 : 1 — "Accredited"'),
      contrast('3.10 : 1 — "Tours"'),
      required("Customized Packages", "Customised Packages"),
      required("Ready for a Snowy Escape?", "Ready for a Snowy Ecsape?"),
      ...["14px", "15px", "16px", "17px"].map(size),
      f("content", "passed"),
    ]);
    const text = flat(r.text);
    // Three identical contrast issues: one row, the fix once, every value kept.
    expect(text).toContain('Text contrast (3) Accessibility Expected: At least 4.5 : 1 Found: 2.37 : 1 — "TRAVELS" · 4.44 : 1 — "Accredited" · 3.10 : 1 — "Tours" Darken the text.');
    expect(occurrences(text, "Darken the text.")).toBe(1);
    expect(text).toContain("Text size (4) Accessibility Expected: At least 19px Found: 14px · 15px · 16px · 17px Make it at least 19px tall.");
    // The group's count is the number of findings — the same as the counts at the top.
    inOrder(r.text, "MAJOR", "5");
    inOrder(r.text, "MINOR", "4");
    // Two required-text corrections that need different fixes: two rows, each with its own expected, found and fix.
    expect(r.text.split("\n").filter((l) => l === "Required text")).toHaveLength(2);
    expect(text).not.toContain("Required Text");
    expect(text).toContain('Required text Brief Expected: Customized Packages Found: Customised Packages Write it exactly as "Customized Packages".');
    expect(text).toContain('Required text Brief Expected: Ready for a Snowy Escape? Found: Ready for a Snowy Ecsape? Write it exactly as "Ready for a Snowy Escape?".');
    expect(r.data.issuesToFix).toHaveLength(9); // the data itself is unchanged
    expect(displayTitle("Required text: Required Text")).toBe("Required text");
    expect(displayTitle("Golden Rule: Always use Book now")).toBe("Golden Rule: Always use Book now");
  });

  it("groupRelated groups only repeats of the same issue — same check, place, expected value and fix — and keeps every occurrence", () => {
    const item = (over: Partial<ReportItem>): ReportItem => ({ severity: "Major", category: "Brief", title: "Required text", explanation: "x", ...over });
    const groups = groupRelated([
      item({ expected: "A", detected: "a", fix: "Fix A" }),
      item({ expected: "B", detected: "b", fix: "Fix B" }), // another expected value: its own row
      item({ expected: "A", detected: "a2", fix: "Fix A", explanation: "y" }),
      item({ expected: " a ", detected: "a", fix: "fix  a" }), // only spacing and capitals differ: the same issue, every occurrence kept
      item({ expected: "A", detected: "a3", fix: "Fix A differently" }), // another fix: its own row
      item({ severity: "Minor", expected: "A", detected: "a", fix: "Fix A" }), // another severity: its own row
      item({ file: "story.png", expected: "A", detected: "a", fix: "Fix A" }), // another file: its own row
      item({ category: "Content", title: "Spelling", expected: "A", detected: "a", fix: "Fix A" }), // another check, same wording: its own row
    ]);
    expect(groups).toHaveLength(6);
    expect(groups[0]).toMatchObject({ count: 3, pairs: [{ expected: "A", found: ["a", "a2", "a"] }], fixes: ["Fix A"], reasons: ["x", "y"] });
    for (const g of groups.slice(1)) expect(g).toMatchObject({ count: 1, pairs: [{ found: [expect.any(String)] }] });
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(8); // nothing dropped
  });

  it("groupSections puts the corrections of one check in one place under one header — each still its own entry", () => {
    const item = (over: Partial<ReportItem>): ReportItem => ({ severity: "Major", category: "Brief", title: "Required text", explanation: "x", ...over });
    const sections = groupSections([
      item({ expected: "A", detected: "a", fix: "Fix A" }),
      item({ expected: "B", detected: "b", fix: "Fix B" }),
      item({ expected: "A", detected: "a2", fix: "Fix A" }),
      item({ severity: "Minor", expected: "C", detected: "c", fix: "Fix C" }), // another severity: its own section
      item({ title: "Headline", expected: "D", detected: "d", fix: "Fix D" }), // another check: its own section
    ]);
    expect(sections.map((s) => [s.item.title, s.item.severity, s.count, s.groups.length])).toEqual([
      ["Required text", "Major", 3, 2],
      ["Required text", "Minor", 1, 1],
      ["Headline", "Major", 1, 1],
    ]);
    expect(sections[0].groups.map((g) => g.pairs)).toEqual([[{ expected: "A", found: ["a", "a2"] }], [{ expected: "B", found: ["b"] }]]);
  });

  it("descriptive brief items (campaign, instructions, audience, other) are never reported as unused or as errors", async () => {
    const descriptive = ["campaign_name", "special_instruction", "target_audience", "other"].map((t) => req(t, "Winter campaign", { confirmed: false }));
    const r = await report([f("brief", "passed")], { requirements: [req("price", "AED 1,299"), ...descriptive] });
    expect(r.data.unconfirmedRequirements).toBe(0);
    expect(r.text).not.toMatch(/unconfirmed|weren't part of this check|were not used|Winter campaign/);
    expect(r.data.requirements.map((x) => x.type)).toEqual(["Price"]);
  });

  it("items the AI wasn't sure about: a short 'Please verify' note beside the item, in its severity group; never counted", async () => {
    const r = await report([
      f("brand", "unverified", "critical", { title: "Logo", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` }),
      f("brief", "passed"),
    ]);
    expect(r.data.result).toBe("pass");
    inOrder(r.text, "CRITICAL", "1 to verify", "CRITICAL", "PLEASE VERIFY", "Logo", "Brand");
    expect(flat(r.text)).toContain("Please verify: Check this on the design — the AI wasn't sure."); // nothing more specific to compare with
    expect(r.text).not.toMatch(/Needs a human check|judged by AI|HUMAN REVIEW/);
    expect(r.text.split("\n")).toContain("1 To verify");
    expect(r.text.split("\n")).toContain("0 Critical"); // shown beside the critical issues, but never counted
  });

  it("checks that couldn't run automatically: named in one line, never counted — no long reasons", async () => {
    const r = await report([f("brand", "unverified", "major", { title: "Brand colours", explanation: "No brand colours are saved for this company." }), f("brief", "passed")]);
    expect(r.data.result).toBe("pass");
    expect(flat(r.text)).toContain("Company settings missing (1): Brand colours — add them on the company page. They don't affect the result.");
    const unsure = (title: string, category: Category, expected?: string) =>
      f(category, "unverified", "minor", { title, expected, explanation: "Not verified: Gemini saw no problem here, but that isn't confirmed — check it yourself." });
    const grouped = await report([unsure("Image quality", "image_asset"), unsure("Meaning shown only by colour", "accessibility", "Meaning also shown in words or symbols"), f("content", "passed")]);
    expect(flat(grouped.text)).toContain("Not checked automatically (2): Image quality · Meaning shown only by colour — they don't affect the result.");
    expect(grouped.text).not.toContain("Company settings missing");
    expect(grouped.text).not.toContain("Gemini saw no problem here");
  });

  it("what couldn't be checked: missing company settings apart from design checks the AI couldn't confirm — neither a mistake, neither counted", async () => {
    const findings = [
      f("brand", "unverified", "major", { title: "Brand fonts", explanation: "No brand fonts are saved for this company. Add them on the company page." }),
      f("brand", "unverified", "major", { title: "Terminology", explanation: "No approved or banned terms are saved for this company." }),
      f("brand", "unverified", "major", { title: "Logo", explanation: "No logo is saved for this company, so there's nothing to compare with." }),
      f("platform_size", "unverified", "major", { title: "Platform", explanation: "No platform has been chosen, so platform requirements can't be checked." }),
      f("image_asset", "unverified", "minor", { title: "Image quality", explanation: "Not verified: Gemini saw no problem here, but that isn't confirmed — check it yourself." }),
      f("content", "passed"),
    ];
    const r = await report(findings);
    const text = flat(r.text);
    expect(text).toContain("Company settings missing (3): Brand fonts · Terminology · Logo — add them on the company page. They don't affect the result.");
    expect(text).toContain("Not checked automatically (2): Platform · Image quality — they don't affect the result.");
    // Not mistakes: no issue rows, nothing to verify, and the result is a clean PASS at 100.
    expect(r.text).not.toContain("SEVERITY");
    expect(r.data).toMatchObject({ result: "pass", resultLabel: "PASS", score: 100, issues: { critical: 0, major: 0, minor: 0, suggestion: 0 } });
    expect(r.text.split("\n")).toContain("0 To verify");
  });

  it("company logo: embedded when readable; missing or damaged → the name only, never an error", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 800, height: 200, channels: 3, background: "#1a64b4" } }).webp().toBuffer());
    const logo = await logoForReport(png); // WebP → PNG for the PDF
    expect(logo?.mime).toBe("image/png");
    const withLogo = await report([f("brief", "passed")], { logo });
    expect(Buffer.from(withLogo.bytes).includes(Buffer.from("/Subtype /Image"))).toBe(true);
    const missing = await report([f("brief", "passed")], { logo: null });
    expect(Buffer.from(missing.bytes).includes(Buffer.from("/Subtype /Image"))).toBe(false);
    expect(missing.text).toContain("Skybook Villas");
    expect(await logoForReport(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(await logoForReport(null)).toBeNull();
    const damaged = await report([f("brief", "passed")], { logo: { bytes: new Uint8Array([137, 80, 78, 71, 0, 0]), mime: "image/png" } });
    expect(damaged.pages).toBeGreaterThan(0);
  });

  it("empty findings: no result yet, no score — one page", async () => {
    const r = await report([]);
    expect(r.data.result).toBeNull();
    expect(r.text).toContain("NO RESULT YET");
    expect(r.text).toContain("None of the checks could be verified, so there is no result.");
    expect(r.text).not.toMatch(/\/ 100|SCORE/);
    inOrder(r.text, "FINDINGS");
    expect(r.text).toContain("No issues to fix.");
    expect(r.text).toContain("No requirements from the brief were checked.");
    expect(r.pages).toBe(1);
  });

  it("sample data is labelled on the report", async () => {
    const r = await report([f("brief", "passed")], { sampleData: true });
    expect(r.text).toContain("SAMPLE DATA — NOT REAL AI. This is not a real QC result.");
  });

  it("long reports: no row is split across pages; a table continuing on a new page repeats its column headings; every page is numbered; nothing is lost", async () => {
    const fixes = Array.from({ length: 30 }, (_, i) =>
      f("brief", "failed", "critical", { title: `Price ${i}`, expected: `AED ${i}00`, detected: `AED ${i}99`, explanation: `Reason ${i}.`, suggestedFix: `Fix number ${i}.` })
    );
    const unverified = Array.from({ length: 40 }, (_, i) => f("brand", "unverified", "minor", { title: `Check ${i}`, explanation: `Reason ${i}: couldn't be checked.` }));
    const r = await report([...fixes, ...unverified, f("content", "passed")]);
    const pages = await pageTexts(r.bytes);
    expect(pages.length).toBeGreaterThan(2);
    for (let i = 0; i < 30; i++) {
      // A row's title and its fix are on the same page.
      const titlePage = pages.findIndex((p) => new RegExp(`Price ${i}(?!\\d)`).test(p));
      const fixPage = pages.findIndex((p) => p.includes(`Fix number ${i}.`));
      expect([i, titlePage]).toEqual([i, fixPage]);
    }
    // Every page with Critical rows starts with the column headings; continued pages say which table it is.
    const withRows = pages.map((p, i) => [i, p] as const).filter(([, p]) => /Price \d/.test(p));
    expect(withRows.length).toBeGreaterThan(1);
    for (const [i, p] of withRows) expect([i, p.includes("SUGGESTED FIX")]).toEqual([i, true]);
    const lines = r.text.split("\n");
    expect(lines.filter((l) => l === "FINDINGS (CONTINUED)")).toHaveLength(withRows.length - 1);
    expect(lines.filter((l) => l === "SUGGESTED FIX")).toHaveLength(withRows.length);
    expect(flat(r.text)).toContain("Not checked automatically (40):");
    for (let i = 0; i < 40; i++) expect(flat(r.text)).toMatch(new RegExp(`Check ${i}(?!\\d)`));
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
  });

  it("characters no report font has never break the report", async () => {
    const many = Array.from({ length: 40 }, (_, i) => f("brand", "unverified", "minor", { title: `Check ${i}`, explanation: `Reason ${i}: ${"a long explanation ".repeat(12)}` }));
    const r = await report([f("brief", "failed", "major", { title: "Headline", expected: "عرض الصيف ≥ 20%", detected: "THEGRANDTO∪R", explanation: "x".repeat(400) }), ...many], { companyName: "شركة Skybook" });
    expect(r.unicode).toBe(true);
    expect(r.pages).toBeGreaterThan(0);
    inOrder(r.text, "Headline", "Brief", "Expected: عرض الصيف >= 20%", "Found: THEGRANDTO?R"); // Arabic kept; "∪" is in no report font
    expect(reportFileName("شركة Skybook", T)).toBe("skybook-qc-skybook-2026-10-06.pdf");
    expect(reportFileName("Acme / Villas & Co.", T)).toBe("skybook-qc-acme-villas-co-2026-10-06.pdf");
    expect(reportFileName("", T)).toBe("skybook-qc-company-2026-10-06.pdf");
  });

  describe("Golden Rules: with the other issues — no section of their own", () => {
    // As loadSessionResult builds them: the Golden Rule CTA and the brief's CTA are the same broken issue.
    const goldenFindings = () =>
      mergeDuplicateFindings([
        f("golden_rules", "failed", "major", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: false, expected: "Book now", detected: "Book today", explanation: "The call to action isn't the approved wording.", suggestedFix: 'Use "Book now".' }),
        f("brief", "failed", "critical", { ruleId: "brief.requirement.cta", title: "CTA (call to action)", expected: "Book now", detected: "Book today", explanation: "Not the brief's CTA.", suggestedFix: 'Use "Book now".' }),
        f("golden_rules", "passed", "critical", { ruleId: "golden_rules.rule.approved_color", title: "Golden Rule: Use Skybook blue", mandatory: true }),
        f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.logo_rule", title: "Golden Rule: Logo top-left", mandatory: true, expected: "Logo top-left", explanation: "This rule is written in words, so it isn't checked automatically — review it by eye." }),
        f("golden_rules", "unverified", "major", { ruleId: "golden_rules.rule.approved_font", title: "Golden Rule: Headlines in Montserrat", mandatory: true, explanation: "No approved value is saved for this rule, so there's nothing to compare with." }),
        f("accessibility", "failed", "major", { title: "Text contrast", expected: "At least 4.5 : 1", detected: "3.1 : 1", suggestedFix: "Darken the text." }),
        f("content", "passed"),
      ]);

    it("report data: a broken rule is an issue like any other (marked Mandatory / Optional), a rule in words is to verify, the merged brief requirement still answered", async () => {
      const r = await report(goldenFindings(), { requirements: [req("cta", "Book now")] });
      expect(r.data.issuesToFix.map((x) => [x.severity, x.title, x.marker, x.alsoCovers])).toEqual([
        ["Critical", "Always use Book now", "Optional", "Brief — CTA (call to action)"],
        ["Major", "Text contrast", undefined, undefined],
      ]);
      expect(r.data.humanChecks.map((x) => [x.severity, x.title, x.marker])).toEqual([["Critical", "Logo top-left", "Mandatory"]]);
      // A rule that couldn't be checked for want of a saved value isn't sent for a manual check.
      expect(r.data.notVerified.map((x) => x.title)).toEqual(["Headlines in Montserrat"]);
      expect(r.data.requirements).toEqual([expect.objectContaining({ type: "CTA (call to action)", status: "To fix (Critical)" })]);
      // Counted once: one critical (the merged CTA) and one major (contrast); nothing to verify counts.
      expect(r.data.issues).toEqual({ critical: 1, major: 1, minor: 0, suggestion: 0 });
    });

    it("PDF: no Golden Rules section — a broken rule sits under its severity, marked Golden Rule and Mandatory / Optional; followed rules aren't listed", async () => {
      const r = await report(goldenFindings(), { requirements: [req("cta", "Book now")] });
      const text = flat(r.text);
      expect(r.text).not.toMatch(/GOLDEN RULES|rules? · \d+ broken|Followed/);
      expect(text).toContain('CRITICAL OPTIONAL Always use Book now Golden Rule Expected: Book now Found: Book today Also required by the brief — counted once. Use "Book now".');
      expect(occurrences(text, "Book today")).toBe(1); // shown once, not again as a brief issue
      expect(text).not.toContain("Golden Rule:");
      expect(text).not.toContain("Use Skybook blue");
      // The rule in words: "Please verify" beside the critical issues, with a short reason — never counted.
      expect(text).toContain("CRITICAL PLEASE VERIFY MANDATORY Logo top-left Golden Rule Please verify: Check the design follows this rule — it can't be checked automatically.");
      expect(r.text.split("\n")).toContain("1 To verify");
      expect(r.text.split("\n")).toContain("1 Critical");
      // The rule with no saved value: named once in the short summary, not sent for a manual check.
      expect(text).toContain("Company settings missing (1): Headlines in Montserrat (Golden Rule) — add them on the company page. They don't affect the result.");
    });

    it("PDF: a brief requirement merged with the company's contact details says so once — the issue shown and counted once", async () => {
      const r = await report(
        mergeDuplicateFindings([
          f("brief", "failed", "critical", { ruleId: "brief.requirement.phone", title: "Phone number", expected: "+971 4 123 4567", detected: "+971 4 123 4568", suggestedFix: 'Change it to "+971 4 123 4567".' }),
          f("content", "failed", "critical", { ruleId: "content.contact_details.phone", title: "Phone / WhatsApp number", expected: "+971 4 123 4567 or +971 50 765 4321", detected: "+971 4 123 4568", suggestedFix: "Replace it with +971 4 123 4567." }),
        ]),
        { requirements: [req("phone", "+971 4 123 4567")] }
      );
      const text = flat(r.text);
      expect(text).toContain("Also flagged by the company's contact details — counted once.");
      // The same note on a merged "Please verify" item.
      const v = await report(
        mergeDuplicateFindings([
          f("golden_rules", "unverified", "critical", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: true, expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
          f("brief", "unverified", "critical", { ruleId: "brief.requirement.cta", title: "CTA (call to action)", expected: "Book now", detected: "Book today", explanation: "Needs a human check: unsure." }),
        ])
      );
      expect(flat(v.text)).toContain(`CRITICAL PLEASE VERIFY MANDATORY Always use Book now Golden Rule Expected: Book now Found: Book today Also required by the brief — shown once. Please verify: Check the design for "Book now" — the AI wasn't sure.`);
      expect(v.text.split("\n")).toContain("1 To verify");
      expect(occurrences(text, "+971 4 123 4568")).toBe(1);
      expect(r.data.issues.critical).toBe(1);
      expect(r.data.requirements).toEqual([expect.objectContaining({ status: "To fix (Critical)" })]);
    });

    it("PDF: a broken mandatory rule is marked MANDATORY, an optional one OPTIONAL", async () => {
      const r = await report([
        f("golden_rules", "failed", "critical", { ruleId: "golden_rules.rule.approved_font", title: "Golden Rule: Headlines in Montserrat", mandatory: true, expected: "Montserrat", detected: "Poppins", suggestedFix: "Use Montserrat only." }),
        f("golden_rules", "failed", "major", { ruleId: "golden_rules.rule.approved_cta", title: "Golden Rule: Always use Book now", mandatory: false, expected: "Book now", detected: "Buy now", suggestedFix: 'Use "Book now".' }),
      ]);
      inOrder(r.text, "CRITICAL", "MANDATORY", "Headlines in Montserrat", "Golden Rule", "Expected: Montserrat", "Found: Poppins");
      inOrder(r.text, "MAJOR", "OPTIONAL", "Always use Book now", "Golden Rule", "Expected: Book now", "Found: Buy now");
    });
  });

  it("what to fix first is the critical and major issues — or the minor ones when there are none; nothing is dropped", () => {
    const item = (severity: string, title: string) => ({ severity, category: "Brief", title, explanation: "x" });
    const mixed = [item("Minor", "a"), item("Critical", "b"), item("Suggestion", "c"), item("Major", "d")];
    expect(splitIssues(mixed)).toEqual({ priority: [mixed[1], mixed[3]], remaining: [mixed[0], mixed[2]] });
    const minorOnly = [item("Minor", "a"), item("Suggestion", "b")];
    expect(splitIssues(minorOnly)).toEqual({ priority: [minorOnly[0]], remaining: [minorOnly[1]] });
    expect(splitIssues([])).toEqual({ priority: [], remaining: [] });
  });

  it("the date falls back to UTC for an unknown time zone", () => {
    expect(formatReportDate(T, "Not/AZone")).toBe("6 October 2026 at 10:30 UTC");
  });
});

/** The fonts a PDF uses, and whether their files are embedded. */
function fontsIn(doc: PDFDocument): { names: string[]; embeddedFiles: number } {
  const dicts = doc.context.enumerateIndirectObjects().map(([, o]) => o).filter((o): o is PDFDict => o instanceof PDFDict);
  const names = dicts.map((d) => d.get(PDFName.of("BaseFont"))?.toString()).filter((n): n is string => !!n);
  return { names, embeddedFiles: dicts.filter((d) => d.has(PDFName.of("FontFile2"))).length };
}

/** Phase 8.1 — Arabic / multilingual text in the PDF (embedded Noto Sans + Noto Sans Arabic). */
describe("QC report — Arabic text", () => {
  const arabicFindings = () => [
    f("brief", "failed", "major", { ruleId: "brief.requirement.headline", title: "Headline", expected: "عرض الصيف", detected: "Summer Offer", suggestedFix: "استخدم العنوان: عرض الصيف" }),
    f("content", "passed"),
  ];

  it("Arabic is kept (not '?'), with the Noto fonts embedded in the PDF", async () => {
    const r = await report(arabicFindings(), { companyName: "شركة سكاي بوك", requirements: [req("headline", "عرض الصيف")] });
    expect(r.unicode).toBe(true);
    expect(r.text).toContain("شركة سكاي بوك");
    expect(r.text).toContain("Expected: عرض الصيف\nFound: Summer Offer\nاستخدم العنوان: عرض الصيف");
    expect(r.text).toContain("استخدم العنوان: عرض الصيف");
    expect(r.text).not.toMatch(/\?{3}/);
    expect(r.data.requirements[0]).toMatchObject({ value: "عرض الصيف", status: "To fix (Major)" });
    const fonts = fontsIn(r.doc);
    expect(fonts.names.some((n) => n.includes("NotoSansArabic"))).toBe(true);
    expect(fonts.names.some((n) => /NotoSans-/.test(n))).toBe(true);
    expect(fonts.embeddedFiles).toBeGreaterThanOrEqual(3); // font files embedded, not referenced
  });

  it("another PDF engine (MuPDF) reads the Arabic words back from the PDF", async () => {
    const r = await report(arabicFindings(), { companyName: "شركة سكاي بوك" });
    const read = await pdfText(r.bytes, 3);
    expect("unsupported" in read).toBe(false);
    if ("unsupported" in read) return;
    const text = read.pages.join(" ").normalize("NFKC");
    expect(text).toContain("Skybook");
    expect(text).toContain("AI Design QC Report");
    // Presentation forms normalise back to the letters; drawn right to left, so either order.
    for (const word of ["عرض", "الصيف", "شركة"]) {
      expect([word, text.includes(word) || text.includes([...word].reverse().join(""))]).toEqual([word, true]);
    }
  });

  it("letters are joined: initial, medial, final and isolated forms; lam-alef; non-Arabic unchanged", () => {
    const cps = (s: string) => [...shapeArabic(s)].map((c) => c.codePointAt(0)!.toString(16));
    expect(cps("عرض")).toEqual(["fecb", "feae", "febd"]); // ain initial, reh final, dad isolated (reh never joins forward)
    expect(cps("بيت")).toEqual(["fe91", "fef4", "fe96"]); // beh initial, yeh medial, teh final
    expect(cps("د")).toEqual(["fea9"]); // isolated
    expect(cps("لا")).toEqual(["fefb"]); // lam-alef ligature
    expect(cps("سلام")).toEqual(["feb3", "fefc", "fee1"]); // seen initial, lam-alef final, meem isolated
    expect(shapeArabic("AED 1,299")).toBe("AED 1,299");
    expect(cps("بَيت")).toEqual(["fe91", "64e", "fef4", "fe96"]); // a vowel mark doesn't break joining
  });

  it("without the fonts the report still works (built-in font, Arabic as '?')", async () => {
    const r = await report(arabicFindings(), { companyName: "شركة سكاي بوك", fonts: null });
    expect(r.unicode).toBe(false);
    expect(r.pages).toBeGreaterThan(0);
    expect(r.text).toContain("Headline\nBrief\nExpected: ??? ?????\nFound: Summer Offer");
    expect(fontsIn(r.doc).names.every((n) => /Helvetica/.test(n))).toBe(true);
  });

  it("WOFF is unpacked to a plain TrueType font; anything else passes through", () => {
    const notWoff = new Uint8Array([0, 1, 0, 0, 0, 0]);
    expect(woffToSfnt(notWoff)).toBe(notWoff);
  });
});
