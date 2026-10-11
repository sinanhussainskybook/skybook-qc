import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import type { QcFile, QcRequirement, QcSession } from "@/lib/db/qc-sessions";
import type { Category, Finding, FindingStatus, Severity } from "@/lib/qc/findings";
import { scoreFindings } from "@/lib/qc/scoring";
import { buildReportData, formatReportDate } from "@/lib/report/report-data";
import { logoForReport } from "@/lib/report/report-logo";
import { renderReportPdf, reportFileName, type ReportLogo } from "@/lib/report/report-pdf";
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

describe("QC report", () => {
  it("PASS report: header, date, content, result, score, counts, a valid PDF", async () => {
    const r = await report([f("brief", "passed"), f("brand", "passed")]);
    expect(String.fromCharCode(...r.bytes.slice(0, 5))).toBe("%PDF-");
    expect(r.doc.getTitle()).toBe("Skybook AI QC report — Skybook Villas");
    for (const s of ["SKYBOOK AI QC", "QC report", "Skybook Villas", "QC date: 6 October 2026 at 14:30 GST", "Content: Social Media Post · Platform: Instagram — Feed image", "Files: summer-post.png", "PASS", "100 / 100", "No issues to fix."]) {
      expect([s, r.text.includes(s)]).toEqual([s, true]);
    }
    expect(r.text).toContain("Critical 0 · Major 0 · Minor 0 · Suggestion 0");
  });

  it("PASS with a human check → 'PASS — HUMAN CHECK REQUIRED' in the PDF, like the page; a clean PASS stays 'PASS'", async () => {
    const humanPrice = f("brief", "unverified", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "AED 1,399", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` });
    const r = await report([f("brand", "passed"), humanPrice]);
    expect(r.data).toMatchObject({ result: "pass", resultLabel: "PASS — HUMAN CHECK REQUIRED", humanCheckCount: 1 });
    expect(r.data.issues).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 }); // the human check still doesn't count
    expect(r.text).toContain("PASS — HUMAN CHECK REQUIRED");
    expect(r.text.split("\n")).toContain("PASS — HUMAN CHECK REQUIRED"); // one line, not wrapped
    expect(r.text.replace(/\n/g, " ")).toContain("No issues to fix in the checks that could be verified — but some items need a human check before it goes to the client.");
    expect(r.text).toContain("Possible critical · Brief · Price");
    const clean = await report([f("brand", "passed")]);
    expect(clean.data.resultLabel).toBe("PASS");
    expect(clean.text).not.toContain("HUMAN CHECK REQUIRED");
  });

  it("simple layout: result → summary → what to fix → human checks → passed, then the detail at the end", async () => {
    const r = await report([
      f("brief", "failed", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "Not found", explanation: "The brief asks for this, but it isn't in the content.", suggestedFix: 'Add "AED 1,299".' }),
      f("brand", "failed", "minor", { title: "Brand colours used", detected: "#FFFFFF (99%)", explanation: "Barely used.", suggestedFix: "Use the brand colours." }),
      f("platform_size", "failed", "suggestion", { title: "Recommended resolution", detected: "1080 × 1350", suggestedFix: "Export larger." }),
      f("brand", "unverified", "major", { title: "Logo", expected: "The company's logo", detected: "No logo", explanation: `${HUMAN_CHECK_CRITICAL.split(" — ")[0]}: the AI wasn't clear about this.` }),
      f("brand", "unverified", "major", { title: "Brand fonts", explanation: "No brand fonts are saved for this company." }),
      f("content", "passed"),
      f("content", "passed"),
    ]);
    const lines = r.text.split("\n");
    const at = (s: string) => lines.indexOf(s);
    // The six parts, in order.
    for (const heading of ["QC result", "Summary", "What needs to be fixed", "Human checks", "Checks passed", "Detailed checks"]) expect(at(heading), heading).toBeGreaterThan(-1);
    expect([at("QC result"), at("Summary"), at("What needs to be fixed"), at("Human checks"), at("Checks passed"), at("Detailed checks")]).toEqual(
      [at("QC result"), at("Summary"), at("What needs to be fixed"), at("Human checks"), at("Checks passed"), at("Detailed checks")].sort((a, b) => a - b)
    );
    // Summary: three counts (the suggestion isn't an issue to fix).
    expect(lines).toEqual(expect.arrayContaining(["2 Issues to fix", "1 Human check", "2 Checks passed"]));
    // What to fix: short cards — issue, severity, found, fix; only Critical / Major / Minor.
    const main = lines.slice(at("What needs to be fixed"), at("Detailed checks")).join("\n");
    expect(main).toContain("Critical · Price\nBrief\nFound: Not found\nFix: Add \"AED 1,299\".");
    expect(main).toContain("Minor · Brand colours used\nBrand\nFound: #FFFFFF (99%)\nFix: Use the brand colours.");
    expect(main).not.toContain("Recommended resolution");
    // Human checks in plain words; no technical prefix, no not-verified items, no long explanations.
    expect(main).toContain("Major · Logo\nBrand\nShould be: The company's logo\nAI read: No logo");
    expect(main).not.toMatch(/Needs a human check:|Not verified|Brand fonts|Expected:|Detected:|Suggested fix:|the AI wasn't clear/);
    expect(main).toContain("2 checks passed");
    // Everything is still there, after the summary: counts, tables, full wording, suggestions, not verified.
    const detail = lines.slice(at("Detailed checks")).join("\n");
    for (const s of ["Critical 1 · Major 0 · Minor 1 · Suggestion 1 · Needs a human check 1 · Not verified 1", "Score by category", "Requirements checked", "Critical · Brief · Price", "The brief asks for this, but it isn't in the content.", "Suggestions (1)", "Suggestion · Platform / Size · Recommended resolution", "Needs a human check (1)", "Not verified (1)", "No brand fonts are saved for this company."]) {
      expect(detail, s).toContain(s);
    }
    // Presentation only: the report data (findings, counts, result) is exactly what the page uses.
    expect(r.data).toMatchObject({ result: "fail", passedCount: 2, humanCheckCount: 1, notVerifiedCount: 1, issues: { critical: 1, major: 0, minor: 1, suggestion: 1 } });
    expect(r.data.issuesToFix).toHaveLength(3);
  });

  it("NEEDS REVISION report: the issue with severity and category", async () => {
    const r = await report([f("design_layout", "failed", "minor", { title: "Text near the edge", detected: '"Book now" touches the edge', suggestedFix: "Move it in." }), f("brief", "passed")]);
    expect(r.text).toContain("NEEDS REVISION");
    expect(r.text).toContain("Fix the issues below before sending it to the client.");
    expect(r.text).toContain("Minor · Design & Layout · Text near the edge");
    expect(r.text).toContain("Suggested fix: Move it in.");
  });

  it("FAIL report with a critical finding: expected / detected / fix, and the requirement it failed", async () => {
    const r = await report(
      [
        f("brief", "failed", "critical", { ruleId: "brief.requirement.price", title: "Price", expected: "AED 1,299", detected: "AED 1,399", suggestedFix: 'Change it to "AED 1,299".', fileName: "summer-post.png" }),
        ...(["content", "brand", "golden_rules", "design_layout", "accessibility", "image_asset", "platform_size", "legal"] as Category[]).map((c) => f(c, "passed")),
      ],
      { requirements: [req("price", "AED 1,299"), req("cta", "Book now", { confirmed: false })] }
    );
    expect(r.data.result).toBe("fail");
    expect(r.text).toContain("FAIL");
    expect(r.text).toContain("96 / 100"); // a high score never hides a critical
    expect(r.text).toContain("Critical · Brief · Price · summer-post.png");
    expect(r.text).toContain("Expected: AED 1,299");
    expect(r.text).toContain("Detected: AED 1,399");
    expect(r.text).toContain('Suggested fix: Change it to "AED 1,299".');
    expect(r.data.requirements).toEqual([{ type: "Price", value: "AED 1,299", mandatory: true, status: "To fix (Critical)" }]);
    expect(r.text).toContain("1 requirement(s) from the brief weren't part of this check — press Check Design again to include them.");
    expect(r.text).not.toContain("unconfirmed");
  });

  it("descriptive brief items (campaign, instructions, audience, other) are never reported as unused or as errors", async () => {
    const descriptive = ["campaign_name", "special_instruction", "target_audience", "other"].map((t) => req(t, "Winter campaign", { confirmed: false }));
    const r = await report([f("brief", "passed")], { requirements: [req("price", "AED 1,299"), ...descriptive] });
    expect(r.data.unconfirmedRequirements).toBe(0);
    expect(r.text).not.toMatch(/unconfirmed|weren't part of this check|were not used/);
    expect(r.data.requirements.map((x) => x.type)).toEqual(["Price"]);
  });

  it("'Needs a human check' items: listed with their wording, never counted", async () => {
    const r = await report([
      f("brand", "unverified", "critical", { title: "Logo", explanation: `${HUMAN_CHECK_CRITICAL}: this was judged by AI, which can't fail a design on its own.` }),
      f("brief", "passed"),
    ]);
    expect(r.data.result).toBe("pass");
    expect(r.text).toContain("Needs a human check (1)");
    expect(r.text).toContain("Possible critical · Brand · Logo");
    expect(r.text).toContain("Needs a human check — possible critical issue: this was judged by AI");
    expect(r.text).toContain("Needs a human check 1");
  });

  it("not verified items: listed with the reason, never counted", async () => {
    const r = await report([f("brand", "unverified", "major", { title: "Brand colours", explanation: "No brand colours are saved for this company." }), f("brief", "passed")]);
    expect(r.data.result).toBe("pass");
    expect(r.text).toContain("Not verified (1)");
    expect(r.text).toContain("Not verified · Brand · Brand colours");
    expect(r.text).toContain("No brand colours are saved for this company.");
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

  it("empty findings: no result yet, every section says so", async () => {
    const r = await report([]);
    expect(r.data.result).toBeNull();
    expect(r.text).toContain("NO RESULT YET");
    expect(r.text).toContain("None of the checks could be verified, so there is no result.");
    expect(r.text).not.toContain("/ 100");
    expect(r.text).toContain("No issues to fix.");
    expect(r.text).toContain("No confirmed requirements.");
  });

  it("sample data is labelled on the report", async () => {
    const r = await report([f("brief", "passed")], { sampleData: true });
    expect(r.text).toContain("SAMPLE DATA — NOT REAL AI. This is not a real QC result.");
  });

  it("characters no report font has never break the report; long reports get more pages", async () => {
    const many = Array.from({ length: 40 }, (_, i) => f("brand", "unverified", "minor", { title: `Check ${i}`, explanation: `Reason ${i}: ${"a long explanation ".repeat(12)}` }));
    const r = await report([f("brief", "failed", "major", { title: "Headline", expected: "عرض الصيف ≥ 20%", detected: "THEGRANDTO∪R", explanation: "x".repeat(400) }), ...many], { companyName: "شركة Skybook" });
    expect(r.unicode).toBe(true);
    expect(r.pages).toBeGreaterThan(1);
    expect(r.text).toContain("Expected: عرض الصيف >= 20%"); // Arabic kept (Phase 8.1)
    expect(r.text).toContain("Detected: THEGRANDTO?R"); // "∪" is in no report font
    expect(reportFileName("شركة Skybook", T)).toBe("skybook-qc-skybook-2026-10-06.pdf");
    expect(reportFileName("Acme / Villas & Co.", T)).toBe("skybook-qc-acme-villas-co-2026-10-06.pdf");
    expect(reportFileName("", T)).toBe("skybook-qc-company-2026-10-06.pdf");
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
    expect(r.text).toContain("Expected: عرض الصيف");
    expect(r.text).toContain("Suggested fix: استخدم العنوان: عرض الصيف");
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
