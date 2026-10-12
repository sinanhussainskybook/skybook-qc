import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import type { QcFile, QcRequirement, QcSession } from "@/lib/db/qc-sessions";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { scoreFindings } from "@/lib/qc/scoring";
import { buildReportData, formatReportDate, type ReportItem } from "@/lib/report/report-data";
import { logoForReport } from "@/lib/report/report-logo";
import { displayTitle, groupRelated, renderReportPdf, reportFileName, splitIssues, type ReportLogo } from "@/lib/report/report-pdf";
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

  it("PASS report: summary — company, date, design file, result in large type, score, one line of counts; a valid PDF", async () => {
    const r = await report([f("brief", "passed"), f("brand", "passed")]);
    expect(String.fromCharCode(...r.bytes.slice(0, 5))).toBe("%PDF-");
    expect(r.doc.getTitle()).toBe("Skybook AI QC report — Skybook Villas");
    inOrder(r.text, "SKYBOOK AI QC", "QC report", "COMPANY", "Skybook Villas", "QC DATE");
    for (const s of ["6 October 2026 at 14:30 GST", "DESIGN FILE", "summer-post.png", "CHECKED AS", "Social Media Post · Instagram — Feed image"]) expect([s, flat(r.text).includes(s)]).toEqual([s, true]);
    inOrder(r.text, "RESULT", "PASS");
    inOrder(r.text, "SCORE", "100", "/ 100");
    for (const c of ["0 Critical", "0 Major", "0 Minor", "0 Suggestions", "2 Passed", "0 Human review", "0 Not verified"]) expect(r.text.split("\n")).toContain(c);
    expect(flat(r.text)).toContain("No issues to fix. Nothing that counts against the result was found.");
    for (const heading of ["What to fix first", "Other issues"]) expect(r.text.split("\n")).not.toContain(heading);
    expect(r.pages).toBe(1); // a clean report is one page
  });

  it("the check summary is always there — passed, human review and not verified each shown, even on a clean PASS", async () => {
    const r = await report([f("brief", "passed"), f("brand", "passed")]);
    inOrder(r.text, "Check summary");
    inOrder(r.text, "Passed", "2", "2 checks passed.");
    inOrder(r.text, "Needs human review", "0", "Nothing needs a human check.");
    inOrder(r.text, "Not verified", "0", "Everything could be checked.");
  });

  it("PASS with a human check → 'PASS — HUMAN CHECK REQUIRED'; the item is in the check summary, apart from passed and not verified", async () => {
    const humanPrice = f("brief", "unverified", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "AED 1,399", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` });
    const r = await report([f("brand", "passed"), humanPrice, f("golden_rules", "unverified", "major", { title: "Golden Rules", explanation: "None saved." })]);
    expect(r.data).toMatchObject({ result: "pass", resultLabel: "PASS — HUMAN CHECK REQUIRED", humanCheckCount: 1 });
    expect(r.data.issues).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 }); // the human check still doesn't count
    expect(r.text.split("\n")).toContain("PASS — HUMAN CHECK REQUIRED"); // one line, not wrapped
    expect(flat(r.text)).toContain("No issues to fix in the checks that could be verified — but some items need a human check before it goes to the client.");
    inOrder(r.text, "Passed", "1", "1 check passed.");
    inOrder(r.text, "Needs human review", "1", "The AI wasn't sure about these — check each one before sending.", "POSSIBLE CRITICAL Price · Brief", "Should be: AED 1,299 · AI read: AED 1,399");
    inOrder(r.text, "Not verified", "1", "Golden Rules · Golden Rules — None saved.");
    const clean = await report([f("brand", "passed")]);
    expect(clean.data.resultLabel).toBe("PASS");
    expect(clean.text).not.toContain("HUMAN CHECK REQUIRED");
  });

  it("layout: summary → what to fix first → other issues → check summary; rows give the issue, what was found and how to fix it; each issue once", async () => {
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
    const order = ["RESULT", "What to fix first", "Other issues", "Check summary", "Passed", "Needs human review", "Not verified"];
    for (const s of order) expect(at(s), s).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual(order.map(at).sort((a, b) => a - b));
    for (const c of ["1 Critical", "0 Major", "1 Minor", "1 Suggestion", "2 Passed", "1 Human review", "1 Not verified"]) expect(lines).toContain(c);
    inOrder(r.text, "ISSUE", "WHAT WAS FOUND", "HOW TO FIX");
    // What to fix first: numbered — severity, title, where, why | expected, found | the fix.
    expect(flat(r.text)).toContain(`1 CRITICAL Price Brief The brief asks for this, but it isn't in the content. Expected: AED 1,299 Found: Not found Add "AED 1,299".`);
    // Other issues: the minor issue and the suggestion — not repeated from above.
    inOrder(r.text, "MINOR", "Brand colours used", "Brand", "Barely used.", "Found: #FFFFFF (99%)", "Use the brand colours.");
    expect(flat(r.text)).toContain("SUGGESTION Recommended resolution Platform / Size Explained. Found: 1080 × 1350 Export larger.");
    // The check summary: human review and not verified, each in its own row; "not counted" said once.
    expect(r.text).toContain("MAJOR Logo · Brand\nShould be: The company's logo · AI read: No logo");
    expect(r.text).toContain("Brand fonts · Brand — No brand fonts are saved for this company.");
    expect(r.text).not.toContain("saved for this company. Not counted for or against the result.");
    expect(r.text).toContain("No confirmed requirements.");
    // Each issue appears exactly once.
    for (const title of ["Price", "Brand colours used"]) expect([title, lines.filter((l) => l === title).length]).toEqual([title, 1]);
    expect(occurrences(flat(r.text), "Recommended resolution")).toBe(1);
    expect(occurrences(r.text, "Logo · Brand")).toBe(1);
    expect(occurrences(r.text, "Brand fonts · Brand")).toBe(1);
    // Presentation only: the report data (findings, counts, result) is exactly what the page uses.
    expect(r.data).toMatchObject({ result: "fail", passedCount: 2, humanCheckCount: 1, notVerifiedCount: 1, issues: { critical: 1, major: 0, minor: 1, suggestion: 1 } });
    expect(r.data.issuesToFix).toHaveLength(3);
    expect(r.pages).toBeLessThanOrEqual(2);
  });

  it("every finding's wording survives: title, expected, detected, explanation and fix of each kind", async () => {
    const findings = [
      f("brief", "failed", "major", { title: "Headline", expected: "Summer in the sun", detected: "Summer in the snow", explanation: "A different headline.", suggestedFix: "Use the brief's headline." }),
      f("legal", "failed", "minor", { title: "Disclaimer", expected: "T&C apply", detected: "T&C Apply", explanation: "Capitals differ.", suggestedFix: 'Show it exactly as "T&C apply".' }),
      f("design_layout", "failed", "suggestion", { title: "Rule of thirds", detected: "Centred", explanation: "A judgement.", suggestedFix: "Consider a thirds crossing." }),
      f("brand", "unverified", "major", { title: "Logo", expected: "The logo", detected: "Unclear", explanation: `${HUMAN_CHECK_CRITICAL.split(" — ")[0]}: unsure.` }),
      f("golden_rules", "unverified", "major", { title: "Golden Rules", explanation: "None saved." }),
    ];
    const r = await report(findings);
    const text = flat(r.text);
    for (const it of [...r.data.issuesToFix, ...r.data.humanChecks, ...r.data.notVerified]) {
      for (const s of [it.title, it.severity === "Not verified" ? null : it.severity.toUpperCase(), it.expected, it.detected, it.explanation, it.fix].filter((s): s is string => Boolean(s))) {
        expect([it.title, s, text.includes(s)]).toEqual([it.title, s, true]);
      }
    }
  });

  it("NEEDS REVISION with only minor issues: they are what to fix first", async () => {
    const r = await report([f("design_layout", "failed", "minor", { title: "Text near the edge", detected: '"Book now" touches the edge', suggestedFix: "Move it in." }), f("brief", "passed")]);
    expect(r.text).toContain("NEEDS REVISION");
    expect(r.text).toContain("Fix the issues below before sending it to the client.");
    inOrder(r.text, "What to fix first", "1");
    inOrder(r.text, "1", "MINOR", "Text near the edge", "Design & Layout", "Explained.", 'Found: "Book now" touches the edge', "Move it in.");
    expect(r.text).not.toContain("Other issues");
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
    inOrder(r.text, "CRITICAL", "Price", "Brief · summer-post.png", "Explained.", "Expected: AED 1,299", "Found: AED 1,399", 'Change it to "AED 1,299".');
    expect(r.data.requirements).toEqual([{ type: "Price", value: "AED 1,299", mandatory: true, status: "To fix (Critical)" }]);
    // The failed requirement is the issue above — said once, not repeated in a requirements list.
    expect(flat(r.text)).toContain("1 brief requirement is listed above as an issue or human check.");
    expect(r.text).not.toMatch(/Brief requirements met|Brief requirements not checked/);
    expect(flat(r.text)).toContain("1 requirement(s) from the brief weren't part of this check — press Check Design again to include them.");
    expect(r.text).not.toContain("unconfirmed");
  });

  it("brief requirements: met ones under Passed, not-checked ones under Not verified, failed ones only as their issue", async () => {
    const r = await report(
      [
        f("brief", "passed", "critical", { ruleId: "brief.requirement.headline", title: "Headline", expected: "Live by the sea" }),
        f("brief", "failed", "major", { ruleId: "brief.requirement.cta", title: "CTA", expected: "Book now", detected: "Buy now", suggestedFix: 'Change it to "Book now".' }),
      ],
      { requirements: [req("headline", "Live by the sea"), req("cta", "Book now"), req("phone", "+971 4 123 4567", { mandatory: false })] }
    );
    const text = flat(r.text);
    expect(text.indexOf("Brief requirements met (1): Headline")).toBeGreaterThan(text.indexOf("Passed"));
    expect(text.indexOf('Brief requirements not checked: Phone number "+971 4 123 4567"')).toBeGreaterThan(text.indexOf("Not verified"));
    expect(text).toContain("1 brief requirement is listed above as an issue or human check.");
    expect(occurrences(text, "Book now")).toBe(2); // the issue's expected value and its fix — not a third time in a list
  });

  it("repeats of the same issue share one row with every value found; different corrections stay apart; a title that repeats its type is said once", async () => {
    const contrast = (detected: string) =>
      f("accessibility", "failed", "major", { title: "Text contrast", expected: "At least 4.5 : 1", detected, explanation: "Low contrast.", suggestedFix: "Darken the text." });
    const required = (expected: string, detected: string) =>
      f("brief", "failed", "major", { ruleId: "brief.requirement.required_text", title: "Required text: Required Text", expected, detected, explanation: "Written differently.", suggestedFix: `Write it exactly as "${expected}".` });
    const r = await report([
      contrast('2.37 : 1 — "TRAVELS"'),
      contrast('4.44 : 1 — "Accredited"'),
      contrast('3.10 : 1 — "Tours"'),
      required("Customized Packages", "Customised Packages"),
      required("Ready for a Snowy Escape?", "Ready for a Snowy Ecsape?"),
      f("content", "passed"),
    ]);
    const text = flat(r.text);
    // Three identical contrast issues: one row, the reason and the fix once, every value kept.
    expect(r.text.split("\n")).toContain("Text contrast (3)");
    expect(occurrences(text, "Low contrast.")).toBe(1);
    expect(occurrences(text, "Darken the text.")).toBe(1);
    expect(text).toContain('Found: 2.37 : 1 — "TRAVELS" · 4.44 : 1 — "Accredited" · 3.10 : 1 — "Tours"');
    // Two required-text issues that need different corrections: two rows, never merged.
    expect(r.text.split("\n")).not.toContain("Required text (2)");
    expect(r.text.split("\n").filter((l) => l === "Required text")).toHaveLength(2);
    expect(text).not.toContain("Required Text");
    expect(text).toContain('Expected: Customized Packages Found: Customised Packages Write it exactly as "Customized Packages".');
    expect(text).toContain('Expected: Ready for a Snowy Escape? Found: Ready for a Snowy Ecsape? Write it exactly as "Ready for a Snowy Escape?".');
    expect(r.data.issuesToFix).toHaveLength(5); // the data itself is unchanged
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

  it("descriptive brief items (campaign, instructions, audience, other) are never reported as unused or as errors", async () => {
    const descriptive = ["campaign_name", "special_instruction", "target_audience", "other"].map((t) => req(t, "Winter campaign", { confirmed: false }));
    const r = await report([f("brief", "passed")], { requirements: [req("price", "AED 1,299"), ...descriptive] });
    expect(r.data.unconfirmedRequirements).toBe(0);
    expect(r.text).not.toMatch(/unconfirmed|weren't part of this check|were not used|Winter campaign/);
    expect(r.data.requirements.map((x) => x.type)).toEqual(["Price"]);
  });

  it("'Needs a human check' items: listed with their reason, never counted", async () => {
    const r = await report([
      f("brand", "unverified", "critical", { title: "Logo", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` }),
      f("brief", "passed"),
    ]);
    expect(r.data.result).toBe("pass");
    inOrder(r.text, "Needs human review", "1");
    expect(r.text).toContain("POSSIBLE CRITICAL Logo · Brand");
    expect(flat(r.text)).toContain("Needs a human check — possible critical issue: this was judged by AI");
    expect(r.text.split("\n")).toContain("1 Human review");
  });

  it("not verified items: one short line each, grouped by a shared reason, never counted", async () => {
    const r = await report([f("brand", "unverified", "major", { title: "Brand colours", explanation: "No brand colours are saved for this company." }), f("brief", "passed")]);
    expect(r.data.result).toBe("pass");
    inOrder(r.text, "Not verified", "1");
    expect(r.text).toContain("Brand colours · Brand — No brand colours are saved for this company.");
    expect(r.text.split("\n")).toContain("1 Not verified");
    const unsure = (title: string, category: Category, expected?: string) =>
      f(category, "unverified", "minor", { title, expected, explanation: "Not verified: Gemini saw no problem here, but that isn't confirmed — check it yourself." });
    const grouped = await report([unsure("Image quality", "image_asset"), unsure("Meaning shown only by colour", "accessibility", "Meaning also shown in words or symbols"), f("content", "passed")]);
    expect(flat(grouped.text)).toContain(
      "Image quality · Image & Asset, Meaning shown only by colour · Accessibility (expected: Meaning also shown in words or symbols) — Gemini saw no problem here, but that isn't confirmed — check it yourself."
    );
    expect(occurrences(flat(grouped.text), "Gemini saw no problem here")).toBe(1);
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
    expect(r.text).toContain("No issues to fix.");
    expect(r.text).toContain("No confirmed requirements.");
    expect(r.pages).toBe(1);
  });

  it("sample data is labelled on the report", async () => {
    const r = await report([f("brief", "passed")], { sampleData: true });
    expect(r.text).toContain("SAMPLE DATA — NOT REAL AI. This is not a real QC result.");
  });

  it("long reports: no row is split across pages; every page is numbered; nothing is lost", async () => {
    const fixes = Array.from({ length: 12 }, (_, i) =>
      f("brief", "failed", "critical", { title: `Price ${i}`, expected: `AED ${i}00`, detected: `AED ${i}99`, explanation: `Reason ${i}. ${"A longer explanation of what went wrong. ".repeat(4)}`, suggestedFix: `Fix number ${i}.` })
    );
    const unverified = Array.from({ length: 40 }, (_, i) => f("brand", "unverified", "minor", { title: `Check ${i}`, explanation: `Reason ${i}: couldn't be checked.` }));
    const r = await report([...fixes, ...unverified, f("content", "passed")]);
    const pages = await pageTexts(r.bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (let i = 0; i < 12; i++) {
      // A row's title and its fix are on the same page.
      const titlePage = pages.findIndex((p) => new RegExp(`Price ${i}(?!\\d)`).test(p));
      const fixPage = pages.findIndex((p) => p.includes(`Fix number ${i}.`));
      expect([i, titlePage]).toEqual([i, fixPage]);
    }
    for (let i = 0; i < 40; i++) expect(flat(r.text)).toContain(`Check ${i} · Brand — Reason ${i}: couldn't be checked.`);
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
  });

  it("characters no report font has never break the report", async () => {
    const many = Array.from({ length: 40 }, (_, i) => f("brand", "unverified", "minor", { title: `Check ${i}`, explanation: `Reason ${i}: ${"a long explanation ".repeat(12)}` }));
    const r = await report([f("brief", "failed", "major", { title: "Headline", expected: "عرض الصيف ≥ 20%", detected: "THEGRANDTO∪R", explanation: "x".repeat(400) }), ...many], { companyName: "شركة Skybook" });
    expect(r.unicode).toBe(true);
    expect(r.pages).toBeGreaterThan(1);
    inOrder(r.text, "Expected: عرض الصيف >= 20%", "Found: THEGRANDTO?R"); // Arabic kept; "∪" is in no report font
    expect(reportFileName("شركة Skybook", T)).toBe("skybook-qc-skybook-2026-10-06.pdf");
    expect(reportFileName("Acme / Villas & Co.", T)).toBe("skybook-qc-acme-villas-co-2026-10-06.pdf");
    expect(reportFileName("", T)).toBe("skybook-qc-company-2026-10-06.pdf");
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
    expect(r.text).toContain("Expected: عرض الصيف\nFound: Summer Offer");
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
    expect(text).toContain("QC report");
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
    expect(r.text).toContain("Expected: ??? ?????");
    expect(fontsIn(r.doc).names.every((n) => /Helvetica/.test(n))).toBe(true);
  });

  it("WOFF is unpacked to a plain TrueType font; anything else passes through", () => {
    const notWoff = new Uint8Array([0, 1, 0, 0, 0, 0]);
    expect(woffToSfnt(notWoff)).toBe(notWoff);
  });
});
