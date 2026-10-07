import { PDFDocument, rgb, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import type { ReportData, ReportItem } from "@/lib/report/report-data";
import { loadReportFonts, reportFaces, type Face, type FontFiles } from "@/lib/report/report-fonts";
import { resultDisplay } from "@/lib/qc/scoring";

/**
 * Draws the QC report (Phase 8) as an A4 PDF with pdf-lib — pure
 * JavaScript, no native parts, so it runs the same on the production
 * server. Built in memory on download; nothing is written to disk or stored.
 *
 * Text uses embedded Noto Sans + Noto Sans Arabic (report-fonts.ts), so
 * Arabic is readable. A character no font has is shown as "?", and if the
 * fonts can't be loaded the built-in Helvetica is used (Western text only)
 * rather than failing the report.
 */

export type ReportLogo = { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null;

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const BOTTOM = 64;
const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  ink: hex("#141413"),
  muted: hex("#5f6368"),
  line: hex("#d9dde3"),
  brand: hex("#1a64b4"),
  pass: hex("#147a3f"),
  passSoft: hex("#e6f5ec"),
  revision: hex("#9a5b00"),
  revisionSoft: hex("#fdf1df"),
  fail: hex("#b3202a"),
  failSoft: hex("#fbe7e8"),
  soft: hex("#f3f5f8"),
};
const RESULT_COLOURS = {
  pass: { strong: C.pass, soft: C.passSoft },
  // A pass with "Needs a human check" items: amber, the same as the Start QC banner.
  pass_human_check: { strong: C.revision, soft: C.revisionSoft },
  needs_revision: { strong: C.revision, soft: C.revisionSoft },
  fail: { strong: C.fail, soft: C.failSoft },
} as const;
const SEVERITY_COLOUR: Record<string, RGB> = { Critical: C.fail, "Possible critical": C.fail, Major: C.revision, Minor: C.ink, Suggestion: C.muted, "Not verified": C.muted };

const REPLACEMENTS: [RegExp, string][] = [
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/✓|✔/g, "v"],
  [/✗|✕/g, "x"],
  [/[   ]/g, " "],
  [/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""],
];

class Writer {
  readonly lines: string[] = [];
  page!: PDFPage;
  y = 0;
  private readonly safe = new Map<string, boolean>();

  constructor(
    readonly doc: PDFDocument,
    readonly regular: Face,
    readonly bold: Face
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.y = A4.height - MARGIN;
  }

  get width() {
    return A4.width - MARGIN * 2;
  }

  /** Only characters the report fonts can draw; others become "?". */
  clean(text: string): string {
    let s = text;
    for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
    let out = "";
    for (const ch of s) {
      if (ch === "\n" || ch === "\t") {
        out += " ";
        continue;
      }
      let ok = this.safe.get(ch);
      if (ok === undefined) {
        ok = this.regular.canDraw(ch) && this.bold.canDraw(ch);
        this.safe.set(ch, ok);
      }
      out += ok ? ch : "?";
    }
    return out;
  }

  wrap(text: string, font: Face, size: number, width: number): string[] {
    const words = this.clean(text).split(/ +/).filter(Boolean);
    const out: string[] = [];
    let line = "";
    const fits = (s: string) => font.width(s, size) <= width;
    for (let word of words) {
      // A single word longer than the line is broken.
      while (!fits(word)) {
        let cut = word.length - 1;
        while (cut > 1 && !fits(word.slice(0, cut))) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  ensure(height: number) {
    if (this.y - height < BOTTOM) this.newPage();
  }

  text(text: string, o: { size?: number; bold?: boolean; color?: RGB; indent?: number; width?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const font = o.bold ? this.bold : this.regular;
    const indent = o.indent ?? 0;
    const lineHeight = size * 1.35;
    for (const line of this.wrap(text, font, size, o.width ?? this.width - indent)) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      font.draw(this.page, line, { x: MARGIN + indent, y: this.y + size * 0.25, size, color: o.color ?? C.ink });
      this.lines.push(line);
    }
    this.y -= o.gap ?? 0;
  }

  gap(h: number) {
    this.y -= h;
  }

  rule() {
    this.ensure(10);
    this.y -= 6;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness: 0.7, color: C.line });
    this.y -= 6;
  }

  heading(text: string) {
    this.ensure(48);
    this.gap(10);
    this.text(text, { size: 13, bold: true, color: C.brand, gap: 4 });
  }

  /** A simple table: column widths are fractions of the page width. */
  table(headers: string[], rows: string[][], fractions: number[]) {
    const widths = fractions.map((f) => f * this.width);
    const drawRow = (cells: string[], header: boolean) => {
      const size = header ? 8.5 : 9;
      const font = header ? this.bold : this.regular;
      const wrapped = cells.map((c, i) => this.wrap(c, font, size, widths[i] - 8));
      const height = Math.max(...wrapped.map((w) => w.length)) * size * 1.35 + 6;
      this.ensure(height);
      if (header) this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: this.width, height, color: C.soft });
      let x = MARGIN;
      wrapped.forEach((lines, i) => {
        lines.forEach((line, j) => {
          font.draw(this.page, line, { x: x + 4, y: this.y - 3 - (j + 1) * size * 1.35 + size * 0.3, size, color: header ? C.muted : C.ink });
        });
        this.lines.push(lines.join(" "));
        x += widths[i];
      });
      this.y -= height;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4.width - MARGIN, y: this.y }, thickness: 0.5, color: C.line });
    };
    drawRow(headers, true);
    for (const r of rows) drawRow(r, false);
    this.gap(4);
  }
}

function items(w: Writer, list: ReportItem[], empty: string) {
  if (!list.length) {
    w.text(empty, { color: C.muted });
    return;
  }
  for (const it of list) {
    w.ensure(40);
    w.gap(4);
    w.text(`${it.severity} · ${it.category} · ${it.title}${it.file ? ` · ${it.file}` : ""}`, { bold: true, color: SEVERITY_COLOUR[it.severity] ?? C.ink });
    if (it.expected) w.text(`Expected: ${it.expected}`, { indent: 12, color: C.muted });
    if (it.detected) w.text(`Detected: ${it.detected}`, { indent: 12, color: C.muted });
    w.text(it.explanation, { indent: 12 });
    if (it.fix) w.text(`Suggested fix: ${it.fix}`, { indent: 12 });
    w.gap(2);
  }
}

async function embedLogo(doc: PDFDocument, logo: ReportLogo): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.mime === "image/png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch {
    return null; // a damaged logo never stops the report
  }
}

/**
 * `fonts`: "auto" loads the Unicode report fonts; null forces the built-in
 * Helvetica (the fallback). `unicode` says which one was used.
 */
export async function renderReportPdf(
  data: ReportData,
  logo: ReportLogo = null,
  fonts: FontFiles | null | "auto" = "auto"
): Promise<{ bytes: Uint8Array; lines: string[]; unicode: boolean }> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Skybook AI QC report — ${data.companyName}`);
  doc.setAuthor("Skybook AI QC");
  doc.setCreator("Skybook AI QC");
  doc.setProducer("Skybook AI QC");
  doc.setCreationDate(new Date());
  const faces = await reportFaces(doc, fonts === "auto" ? await loadReportFonts() : fonts);
  const w = new Writer(doc, faces.regular, faces.bold);

  // --- Header: brand, company logo / name, date ---------------------------
  const image = await embedLogo(doc, logo);
  if (image) {
    const scale = Math.min(150 / image.width, 48 / image.height, 1);
    w.page.drawImage(image, { x: A4.width - MARGIN - image.width * scale, y: A4.height - MARGIN - image.height * scale, width: image.width * scale, height: image.height * scale });
  }
  w.text("SKYBOOK AI QC", { size: 9, bold: true, color: C.brand, width: w.width - 170 });
  w.text("QC report", { size: 20, bold: true, width: w.width - 170, gap: 2 });
  w.text(data.companyName, { size: 12, bold: true, width: w.width - 170 });
  w.text(`QC date: ${data.generatedAt}`, { size: 9, color: C.muted, width: w.width - 170 });
  w.gap(8);

  if (data.sampleData) {
    w.ensure(30);
    w.page.drawRectangle({ x: MARGIN, y: w.y - 26, width: w.width, height: 26, color: C.revisionSoft });
    w.gap(4);
    w.text("SAMPLE DATA — NOT REAL AI. This is not a real QC result.", { bold: true, color: C.revision, indent: 8, gap: 8 });
  }

  w.text(`Content: ${data.contentType}${data.platform ? ` · Platform: ${data.platform}` : ""}`, { size: 10 });
  if (data.files.length) w.text(`Files: ${data.files.join(", ")}`, { size: 9, color: C.muted });
  if (data.providerNote) w.text(`Analysed by: ${data.providerNote}`, { size: 9, color: C.muted });
  w.gap(8);

  // --- Result banner --------------------------------------------------------
  const shown = resultDisplay({ result: data.result, humanChecks: data.humanCheckCount });
  const colours = shown ? RESULT_COLOURS[shown] : { strong: C.muted, soft: C.soft };
  // The label stays on one line (a longer one, e.g. "PASS — HUMAN CHECK REQUIRED", is set a
  // little smaller), and the box grows with the summary, so nothing spills out of it.
  const bannerWidth = w.width - 140;
  let labelSize = 22;
  while (labelSize > 14 && w.bold.width(data.resultLabel, labelSize) > bannerWidth) labelSize--;
  const needed = 8 + w.wrap(data.resultLabel, w.bold, labelSize, bannerWidth).length * labelSize * 1.35 + w.wrap(data.resultSummary, w.regular, 9.5, bannerWidth).length * 9.5 * 1.35 + 6;
  const boxHeight = Math.max(58, Math.ceil(needed));
  w.ensure(boxHeight + 6);
  w.page.drawRectangle({ x: MARGIN, y: w.y - boxHeight, width: w.width, height: boxHeight, color: colours.soft, borderColor: colours.strong, borderWidth: 0.8 });
  const top = w.y;
  w.gap(8);
  w.text(data.resultLabel, { size: labelSize, bold: true, color: colours.strong, indent: 14, width: bannerWidth });
  w.text(data.resultSummary, { size: 9.5, indent: 14, width: bannerWidth });
  if (data.score !== null) {
    const s = `${data.score} / 100`;
    w.bold.draw(w.page, s, { x: A4.width - MARGIN - 14 - w.bold.width(s, 20), y: top - 36, size: 20, color: C.ink });
    w.lines.push(s);
  }
  w.y = top - boxHeight - 8;

  const counts = `Critical ${data.issues.critical} · Major ${data.issues.major} · Minor ${data.issues.minor} · Suggestion ${data.issues.suggestion} · Needs a human check ${data.humanCheckCount} · Not verified ${data.notVerifiedCount}`;
  w.text(counts, { size: 9.5, bold: true });
  w.text(
    `Based on ${data.answered} of ${data.applicable} checks that could be answered. Only issues found count: "Needs a human check" and not verified checks never count for or against the result — look at them before sending the content.`,
    { size: 9, color: C.muted, gap: 4 }
  );

  // --- Sections ---------------------------------------------------------------
  w.heading("Score by category");
  w.table(["Category", "Score", "Issues", "Not counted"], data.categories.map((c) => [c.label, c.score, c.issues, c.notCounted]), [0.3, 0.14, 0.26, 0.3]);

  w.heading("Requirements checked");
  if (data.requirements.length) {
    w.table(["Requirement", "Expected", "Mandatory", "Result"], data.requirements.map((r) => [r.type, r.value, r.mandatory ? "Yes" : "No", r.status]), [0.24, 0.38, 0.12, 0.26]);
  } else {
    w.text("No confirmed requirements.", { color: C.muted });
  }
  if (data.unconfirmedRequirements) w.text(`${data.unconfirmedRequirements} unconfirmed requirement(s) were not used.`, { size: 9, color: C.muted });

  w.heading(`Issues to fix (${data.issuesToFix.length})`);
  items(w, data.issuesToFix, "No issues to fix.");

  w.heading(`Needs a human check (${data.humanChecks.length})`);
  w.text("Not counted for or against the result: the reading or the AI's judgement wasn't certain enough. Check each one yourself.", { size: 9, color: C.muted, gap: 2 });
  items(w, data.humanChecks, "None.");

  w.heading(`Not verified (${data.notVerified.length})`);
  w.text("These checks couldn't be done (missing company information, or content the analysis couldn't read). Not counted for or against the result.", { size: 9, color: C.muted, gap: 2 });
  items(w, data.notVerified, "None.");

  w.gap(6);
  w.text(`${data.passedCount} check(s) passed.`, { size: 9, color: C.muted });

  // --- Footer on every page -------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const left = w.clean(`Skybook AI QC · ${data.companyName} · ${data.generatedAt} · not stored — this file is the only copy${data.sampleData ? " · SAMPLE DATA" : ""}`);
    const right = `Page ${i + 1} of ${pages.length}`;
    p.drawLine({ start: { x: MARGIN, y: 44 }, end: { x: A4.width - MARGIN, y: 44 }, thickness: 0.5, color: C.line });
    w.regular.draw(p, w.wrap(left, w.regular, 7.5, A4.width - MARGIN * 2 - 70)[0], { x: MARGIN, y: 32, size: 7.5, color: C.muted });
    w.regular.draw(p, right, { x: A4.width - MARGIN - w.regular.width(right, 7.5), y: 32, size: 7.5, color: C.muted });
  });
  w.lines.push(`Page 1 of ${pages.length}`);

  return { bytes: await doc.save(), lines: w.lines, unicode: faces.unicode };
}

/** A safe, short file name: skybook-qc-<company>-<yyyy-mm-dd>.pdf */
export function reportFileName(companyName: string, date: Date): string {
  const slug = companyName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40) || "company";
  return `skybook-qc-${slug}-${date.toISOString().slice(0, 10)}.pdf`;
}
