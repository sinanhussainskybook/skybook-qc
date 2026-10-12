import { LineCapStyle, PDFDocument, rgb, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import type { ReportData, ReportItem } from "@/lib/report/report-data";
import { loadReportFonts, reportFaces, type Face, type FontFiles } from "@/lib/report/report-fonts";
import { resultDisplay } from "@/lib/qc/scoring";

/**
 * Draws the QC report (Phase 8) as an A4 PDF with pdf-lib — pure
 * JavaScript, no native parts, so it runs the same on the production
 * server. Built in memory on download; nothing is written to disk or stored.
 *
 * A short document, not a dashboard — usually one or two pages:
 *   QC summary      company, date, design file; the result in large type and
 *                   the score; one line of counts
 *   What to fix first / Other issues
 *                   compact rows: the issue | what was found | how to fix it.
 *                   Repeats of the same issue (same severity, check, place,
 *                   expected value and fix) share one row with every value
 *                   found; anything else is its own row. Each issue appears once.
 *   Check summary   always shown, even on a PASS: Passed · Needs human review ·
 *                   Not verified, each in its own colour, with the brief's
 *                   requirements in the right one
 * Every row is kept together (never split across pages) and a heading is
 * never left at the bottom of a page without its first row. Presentation
 * only: the data is exactly ReportData.
 *
 * Text uses embedded Noto Sans + Noto Sans Arabic (report-fonts.ts), so
 * Arabic is readable. A character no font has is shown as "?", and if the
 * fonts can't be loaded the built-in Helvetica is used (Western text only)
 * rather than failing the report.
 */

export type ReportLogo = { bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null;

const PAGE = { width: 595.28, height: 841.89 };
const M = 46; // side margin
const W = PAGE.width - M * 2; // content width
const TOP = PAGE.height - 44;
const BOTTOM = 60; // above the footer

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  ink: hex("#0f172a"),
  text: hex("#334155"),
  muted: hex("#64748b"),
  line: hex("#e2e8f0"),
  brand: hex("#1a64b4"),
  white: hex("#ffffff"),
};

type Tone = { strong: RGB; soft: RGB };
const TONE = {
  critical: { strong: hex("#c62828"), soft: hex("#fdecec") },
  major: { strong: hex("#b45309"), soft: hex("#fdf3e3") },
  minor: { strong: hex("#2f6fd6"), soft: hex("#eaf2fd") },
  pass: { strong: hex("#15803d"), soft: hex("#e7f6ed") },
  human: { strong: hex("#6d28d9"), soft: hex("#f2edfd") },
  grey: { strong: hex("#64748b"), soft: hex("#f1f5f9") },
} satisfies Record<string, Tone>;

/** One colour per severity, used the same way everywhere. */
const SEVERITY_TONE: Record<string, Tone> = {
  Critical: TONE.critical,
  "Possible critical": TONE.critical,
  Major: TONE.major,
  Minor: TONE.minor,
  Suggestion: TONE.grey,
  "Not verified": TONE.grey,
};
const toneOf = (severity: string) => SEVERITY_TONE[severity] ?? TONE.grey;

const RESULT_TONE: Record<string, Tone> = {
  pass: TONE.pass,
  // A pass with "Needs a human check" items: amber, like the Start QC banner.
  pass_human_check: TONE.major,
  needs_revision: TONE.major,
  fail: TONE.critical,
};

const REPLACEMENTS: [RegExp, string][] = [
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/✓|✔/g, "v"],
  [/✗|✕/g, "x"],
  [/[   ]/g, " "],
  [/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""],
];

/** A run of text within a line: its own weight and colour. */
type Span = { text: string; bold?: boolean; color?: RGB };
/** A block: one or more spans, wrapped together to a width. */
type Block = { spans: Span[]; size: number; gapBefore?: number };
type Laid = { size: number; gapBefore: number; lines: Span[][] };

const lineHeight = (size: number) => size * 1.36;

/** The page, the fonts and a cursor (`y`, top-down). Every drawn text line is also recorded in `lines`. */
class Doc {
  readonly lines: string[] = [];
  page!: PDFPage;
  y = 0;
  pages = 0;
  private readonly safe = new Map<string, boolean>();

  constructor(
    readonly doc: PDFDocument,
    readonly regular: Face,
    readonly bold: Face,
    readonly runningTitle: string
  ) {}

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages++;
    this.page.drawRectangle({ x: M, y: PAGE.height - 30, width: 28, height: 3, color: C.brand });
    this.y = TOP;
    if (this.pages > 1) {
      this.font(false).draw(this.page, this.clean(this.runningTitle), { x: M, y: this.y - 6, size: 7.5, color: C.muted });
      this.y -= 24;
    }
  }

  ensure(height: number) {
    if (this.y - height < BOTTOM) this.newPage();
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

  font(bold?: boolean) {
    return bold ? this.bold : this.regular;
  }

  width(text: string, size: number, bold?: boolean) {
    return this.font(bold).width(this.clean(text), size);
  }

  /** Wraps spans to `width`; a span may break across lines, a too-long word is cut. */
  wrap(spans: Span[], size: number, width: number): Span[][] {
    const lines: Span[][] = [];
    let line: Span[] = [];
    let used = 0;
    const push = () => {
      lines.push(line);
      line = [];
      used = 0;
    };
    /** Adds a word to the current line (with a space before it unless it starts the line). */
    const add = (span: Span, word: string) => {
      const piece = line.length ? ` ${word}` : word;
      const last = line[line.length - 1];
      if (last && last.bold === span.bold && last.color === span.color) last.text += piece;
      else line.push({ ...span, text: piece });
      used += this.font(span.bold).width(piece, size);
    };
    for (const span of spans) {
      const font = this.font(span.bold);
      for (let word of this.clean(span.text).split(/ +/).filter(Boolean)) {
        // A single word longer than the line is broken.
        while (font.width(word, size) > width) {
          let cut = word.length - 1;
          while (cut > 1 && font.width(word.slice(0, cut), size) > width) cut--;
          if (line.length) push();
          add(span, word.slice(0, cut));
          push();
          word = word.slice(cut);
        }
        if (line.length && used + font.width(` ${word}`, size) > width) push();
        add(span, word);
      }
    }
    if (line.length) push();
    return lines.length ? lines : [[{ text: "" }]];
  }

  lay(blocks: Block[], width: number): { laid: Laid[]; height: number } {
    const laid = blocks.map((b) => ({ size: b.size, gapBefore: b.gapBefore ?? 0, lines: this.wrap(b.spans, b.size, width) }));
    const height = laid.reduce((h, b) => h + b.gapBefore + b.lines.length * lineHeight(b.size), 0);
    return { laid, height };
  }

  /** Draws laid-out blocks from `top`; returns the height used. */
  draw(laid: Laid[], x: number, top: number): number {
    let y = top;
    for (const b of laid) {
      y -= b.gapBefore;
      for (const line of b.lines) {
        y -= lineHeight(b.size);
        let cx = x;
        for (const span of line) {
          const font = this.font(span.bold);
          font.draw(this.page, span.text, { x: cx, y: y + b.size * 0.3, size: b.size, color: span.color ?? C.ink });
          cx += font.width(span.text, b.size);
        }
        this.lines.push(line.map((s) => s.text).join("").trim());
      }
    }
    return top - y;
  }

  /** One line of text at a baseline (recorded). */
  write(text: string, x: number, baseline: number, size: number, o: { bold?: boolean; color?: RGB } = {}) {
    const line = this.clean(text);
    this.font(o.bold).draw(this.page, line, { x, y: baseline, size, color: o.color ?? C.ink });
    this.lines.push(line);
  }

  rule(gapAbove = 10, gapBelow = 12) {
    this.y -= gapAbove;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: PAGE.width - M, y: this.y }, thickness: 0.6, color: C.line });
    this.y -= gapBelow;
  }
}

/** "Required text: Required Text" → "Required text": a label that only repeats its type is said once. */
export function displayTitle(title: string): string {
  const [head, ...rest] = title.split(": ");
  return rest.length && rest.join(": ").trim().toLowerCase() === head.trim().toLowerCase() ? head : title;
}

/** "CTA (call to action) (CTA)" → "CTA (call to action)": a brief label already in the type's name isn't repeated. */
function requirementName(type: string): string {
  const m = type.match(/^(.+) \(([^()]+)\)$/);
  return m && m[1].toLowerCase().includes(m[2].trim().toLowerCase()) ? m[1] : type;
}

/**
 * Repeats of the SAME issue shown as one row: the same severity, check, file,
 * expected value and fix — e.g. three text-contrast failures that all need
 * "At least 4.5 : 1" and the same fix. Every value found is kept (one per
 * occurrence) and each distinct reason once. Findings that expect something
 * different or need a different fix stay separate rows, even when their
 * wording or severity matches.
 */
export type Related = {
  item: ReportItem;
  count: number;
  /** The expected value (or none) with every value found for it. */
  pairs: { expected?: string; found: string[] }[];
  reasons: string[];
  fixes: string[];
};
/** Two values are the same when they differ only in spacing or capitals. */
const same = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
export function groupRelated(items: ReportItem[]): Related[] {
  const out = new Map<string, Related>();
  const add = (list: string[], value: string | undefined) => {
    if (value && !list.some((v) => same(v) === same(value))) list.push(value);
  };
  for (const it of items) {
    const key = [it.severity, it.category, displayTitle(it.title), it.file ?? "", same(it.expected), same(it.fix)].join("\u0000");
    const group = out.get(key) ?? { item: it, count: 0, pairs: [], reasons: [], fixes: [] };
    group.count++;
    const pair = group.pairs.find((p) => same(p.expected) === same(it.expected)) ?? (group.pairs.push({ expected: it.expected, found: [] }), group.pairs[group.pairs.length - 1]);
    if (it.detected) pair.found.push(it.detected);
    add(group.reasons, it.explanation);
    add(group.fixes, it.fix);
    out.set(key, group);
  }
  return [...out.values()];
}

/** A small rounded tag; returns its width. (x, y) = bottom-left. */
function tag(d: Doc, text: string, x: number, y: number, tone: Tone, size = 6.6): number {
  const label = d.clean(text.toUpperCase());
  const w = d.font(true).width(label, size) + 10;
  const h = size + 6;
  const r = h / 2;
  const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  d.page.drawSvgPath(path, { x, y: y + h, color: tone.soft });
  d.write(label, x + 5, y + 3.5, size, { bold: true, color: tone.strong });
  return w;
}

/** A section heading, kept with the first `follow` points of what comes after it. */
function heading(d: Doc, title: string, count: number | null, follow: number) {
  d.ensure(30 + follow);
  if (d.y < TOP - 30) d.y -= 8;
  d.write(title, M, d.y - 13, 12.5, { bold: true });
  if (count !== null) d.write(String(count), M + d.width(title, 12.5, true) + 7, d.y - 13, 9, { color: C.muted });
  d.y -= 22;
}

// Issue rows: three columns — the issue, what was found, how to fix it.
const NUM_W = 18;
const GAP = 12;
const ISSUE_W = 178;
const FOUND_W = 150;
const FIX_W = W - NUM_W - ISSUE_W - FOUND_W - GAP * 2;
const colX = { issue: M + NUM_W, found: M + NUM_W + ISSUE_W + GAP, fix: M + NUM_W + ISSUE_W + GAP + FOUND_W + GAP };

/** The small column labels above a list of rows (kept with its first row). */
function columnLabels(d: Doc, labels: [string, string, string], follow: number) {
  d.ensure(14 + follow);
  d.write(labels[0], colX.issue, d.y - 7, 6.3, { bold: true, color: C.muted });
  d.write(labels[1], colX.found, d.y - 7, 6.3, { bold: true, color: C.muted });
  d.write(labels[2], colX.fix, d.y - 7, 6.3, { bold: true, color: C.muted });
  d.y -= 12;
}

type RowLabels = { expected: string; found: string };

/** Lays out one row (no drawing) — so its height is known before it is placed. */
function layRow(d: Doc, g: Related, o: { labels: RowLabels; third: "fix" | "why" }) {
  const it = g.item;
  // The severity tag sits beside the title; where it is and why go underneath.
  const tagW = d.font(true).width(d.clean(it.severity.toUpperCase()), 6.6) + 10;
  const title = d.lay([{ spans: [{ text: `${displayTitle(it.title)}${g.count > 1 ? ` (${g.count})` : ""}`, bold: true }], size: 9.6 }], ISSUE_W - tagW - 6);
  const under = d.lay(
    [
      { spans: [{ text: [it.category, it.file].filter(Boolean).join(" · "), color: C.muted }], size: 7.8, gapBefore: 0 },
      // The reason, unless it is the third column.
      ...(o.third === "fix" ? g.reasons.map((r) => ({ spans: [{ text: r, color: C.text }], size: 8, gapBefore: 3 })) : []),
    ],
    ISSUE_W
  );
  const foundBlocks: Block[] = [];
  for (const p of g.pairs) {
    if (p.expected) foundBlocks.push({ spans: [{ text: `${o.labels.expected}:`, bold: true, color: C.muted }, { text: p.expected, color: C.ink }], size: 8.2, gapBefore: foundBlocks.length ? 4 : 0 });
    if (p.found.length) {
      const spans: Span[] = [{ text: `${o.labels.found}:`, bold: true, color: C.muted }];
      p.found.forEach((v, i) => spans.push(...(i ? [{ text: "·", color: C.muted }] : []), { text: v, color: C.ink }));
      foundBlocks.push({ spans, size: 8.2, gapBefore: p.expected ? 1 : foundBlocks.length ? 4 : 0 });
    }
  }
  const found = d.lay(foundBlocks.length ? foundBlocks : [{ spans: [{ text: "—", color: C.muted }], size: 8.2 }], FOUND_W);
  const thirdBlocks: Block[] =
    o.third === "fix"
      ? g.fixes.map((f, i) => ({ spans: [{ text: f, bold: true, color: C.ink }], size: 8.6, gapBefore: i ? 3 : 0 }))
      : g.reasons.map((r, i) => ({ spans: [{ text: r, color: C.text }], size: 8, gapBefore: i ? 3 : 0 }));
  const third = d.lay(thirdBlocks.length ? thirdBlocks : [{ spans: [{ text: "—", color: C.muted }], size: 8.6 }], FIX_W);
  const head = Math.max(title.height, 14);
  const h = 6 + Math.max(head + 1 + under.height, found.height, third.height) + 8;
  return { tagW, title, under, head, found, third, h };
}

/** One row, kept together; a hairline above it. */
function row(d: Doc, g: Related, o: { index?: number; tone?: Tone; labels: RowLabels; third: "fix" | "why" }) {
  const laid = layRow(d, g, o);
  d.ensure(laid.h);
  const top = d.y;
  d.page.drawLine({ start: { x: M, y: top }, end: { x: PAGE.width - M, y: top }, thickness: 0.4, color: C.line });
  if (o.index !== undefined) d.write(String(o.index), M, top - 14.5, 10, { bold: true, color: C.brand });
  tag(d, g.item.severity, colX.issue, top - 17.5, o.tone ?? toneOf(g.item.severity));
  d.draw(laid.title.laid, colX.issue + laid.tagW + 6, top - 4);
  d.draw(laid.under.laid, colX.issue, top - 5 - laid.head);
  d.draw(laid.found.laid, colX.found, top - 5);
  d.draw(laid.third.laid, colX.fix, top - 5);
  d.y = top - laid.h;
}

/** A compact paragraph (label + text), kept together. */
function paragraph(d: Doc, spans: Span[], size = 8.6, gapAfter = 6, x = M, width = W) {
  const p = d.lay([{ spans, size }], width);
  d.ensure(p.height + gapAfter);
  d.y -= d.draw(p.laid, x, d.y) + gapAfter;
}

/**
 * One row of the check summary: a coloured bar and label on the left (with
 * its count), its content on the right. Passed, human review and not verified
 * always look different — even on a PASS.
 */
function summaryRow(d: Doc, label: string, count: number, tone: Tone, blocks: Block[]) {
  const labelW = 118;
  const body = d.lay(blocks, W - labelW);
  const h = Math.max(body.height, 24) + 12;
  d.ensure(h);
  const top = d.y;
  d.page.drawRectangle({ x: M, y: top - h + 8, width: 3, height: h - 12, color: count ? tone.strong : C.line });
  d.write(label, M + 10, top - 11, 9.4, { bold: true, color: count ? tone.strong : C.muted });
  d.write(String(count), M + 10, top - 26, 14, { bold: true, color: count ? C.ink : C.muted });
  d.draw(body.laid, M + labelW, top - 2);
  d.y = top - h;
}

async function embedLogo(doc: PDFDocument, logo: ReportLogo): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    return logo.mime === "image/png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
  } catch {
    return null; // a damaged logo never stops the report
  }
}

/** "What to fix first" is the Critical and Major issues — or, when there are none, the Minor ones. Each issue appears once. */
export function splitIssues(issuesToFix: ReportItem[]): { priority: ReportItem[]; remaining: ReportItem[] } {
  const counted = issuesToFix.filter((it) => it.severity === "Critical" || it.severity === "Major" || it.severity === "Minor");
  const top = counted.filter((it) => it.severity !== "Minor");
  const priority = top.length ? top : counted;
  return { priority, remaining: issuesToFix.filter((it) => !priority.includes(it)) };
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
  const d = new Doc(doc, faces.regular, faces.bold, `Skybook AI QC report · ${data.companyName}`);
  d.newPage();

  // --- Header ----------------------------------------------------------------------
  const image = await embedLogo(doc, logo);
  d.write("SKYBOOK AI QC", M, d.y - 8, 7.5, { bold: true, color: C.brand });
  d.write("QC report", M, d.y - 30, 22, { bold: true });
  if (image) {
    const scale = Math.min(140 / image.width, 34 / image.height, 1);
    d.page.drawImage(image, { x: PAGE.width - M - image.width * scale, y: d.y - 4 - image.height * scale, width: image.width * scale, height: image.height * scale });
  }
  d.y -= 48;

  const facts: [string, string][] = [
    ["Company", data.companyName],
    ["QC date", data.generatedAt],
    [data.files.length > 1 ? "Design files" : "Design file", data.files.length ? data.files.join(", ") : "—"],
    ["Checked as", [data.contentType, data.platform].filter(Boolean).join(" · ")],
  ];
  const shares = [0.24, 0.24, 0.32, 0.2];
  const cells = facts.map(([label, value], i) => ({ label, v: d.lay([{ spans: [{ text: value, bold: true }], size: 8.8 }], W * shares[i] - 12) }));
  const factsH = 12 + Math.max(...cells.map((c) => c.v.height));
  cells.forEach((c, i) => {
    const x = M + W * shares.slice(0, i).reduce((a, b) => a + b, 0);
    d.write(c.label.toUpperCase(), x, d.y - 7, 6.5, { bold: true, color: C.muted });
    d.draw(c.v.laid, x, d.y - 10);
  });
  d.y -= factsH;
  if (data.providerNote) paragraph(d, [{ text: `Analysed by: ${data.providerNote}`, color: C.muted }], 8, 0);
  d.rule(10, 18);

  if (data.sampleData) paragraph(d, [{ text: "SAMPLE DATA — NOT REAL AI. This is not a real QC result.", bold: true, color: TONE.major.strong }], 9.5, 10);

  // --- Result: the word, the summary, the score ------------------------------------
  const shown = resultDisplay({ result: data.result, humanChecks: data.humanCheckCount });
  const tone = shown ? RESULT_TONE[shown] : TONE.grey;
  const scoreW = 120;
  let size = 30;
  while (size > 15 && d.width(data.resultLabel, size, true) > W - scoreW - 10) size--;
  const summary = d.lay([{ spans: [{ text: data.resultSummary, color: C.text }], size: 10 }], W - scoreW - 10);
  const resultTop = d.y;
  d.write("RESULT", M, resultTop - 6, 6.5, { bold: true, color: C.muted });
  d.write(data.resultLabel, M, resultTop - 10 - size * 0.95, size, { bold: true, color: tone.strong });
  const afterWord = resultTop - 16 - size * 1.05;
  d.draw(summary.laid, M, afterWord);
  if (data.score !== null) {
    const score = String(data.score);
    const sx = PAGE.width - M - d.width(score, 38, true) - d.width(" / 100", 10) ;
    d.write("SCORE", PAGE.width - M - d.width("SCORE", 6.5, true), resultTop - 6, 6.5, { bold: true, color: C.muted });
    d.write(score, sx, resultTop - 44, 38, { bold: true });
    d.write("/ 100", sx + d.width(score, 38, true) + d.width(" ", 10), resultTop - 44, 10, { color: C.muted });
  }
  d.y = Math.min(afterWord - summary.height, resultTop - 52) - 14;

  // One line of counts.
  const counts: { n: number; label: string; tone: Tone; counted: boolean }[] = [
    { n: data.issues.critical, label: "Critical", tone: TONE.critical, counted: true },
    { n: data.issues.major, label: "Major", tone: TONE.major, counted: true },
    { n: data.issues.minor, label: "Minor", tone: TONE.minor, counted: true },
    { n: data.issues.suggestion, label: data.issues.suggestion === 1 ? "Suggestion" : "Suggestions", tone: TONE.grey, counted: false },
    { n: data.passedCount, label: "Passed", tone: TONE.pass, counted: true },
    { n: data.humanCheckCount, label: "Human review", tone: TONE.human, counted: false },
    { n: data.notVerifiedCount, label: "Not verified", tone: TONE.grey, counted: false },
  ];
  let cx = M;
  let cy = d.y;
  for (const c of counts) {
    const label = `${c.n} ${c.label}`;
    const w = 10 + d.width(String(c.n), 9.5, true) + d.width(` ${c.label}`, 9) + 12;
    if (cx + w > PAGE.width - M) {
      cx = M;
      cy -= 16;
    }
    d.page.drawCircle({ x: cx + 3, y: cy - 7, size: 3, color: c.n ? c.tone.strong : C.line });
    d.font(true).draw(d.page, String(c.n), { x: cx + 10, y: cy - 10.2, size: 9.5, color: c.n ? C.ink : C.muted });
    d.font(false).draw(d.page, ` ${c.label}`, { x: cx + 10 + d.width(String(c.n), 9.5, true), y: cy - 10.2, size: 9, color: C.text });
    d.lines.push(label);
    cx += w;
  }
  d.y = cy - 16;
  d.rule(4, 16);

  // --- What to fix first ----------------------------------------------------------
  const { priority, remaining } = splitIssues(data.issuesToFix);
  const first = groupRelated(priority);
  const others = groupRelated(remaining);
  const issueLabels: [string, string, string] = ["ISSUE", "WHAT WAS FOUND", "HOW TO FIX"];
  const fixRow = { labels: { expected: "Expected", found: "Found" }, third: "fix" as const };
  if (first.length) {
    heading(d, "What to fix first", priority.length, 60);
    columnLabels(d, issueLabels, layRow(d, first[0], fixRow).h);
    first.forEach((g, i) => row(d, g, { ...fixRow, index: i + 1 }));
  } else {
    heading(d, "What to fix", null, 20);
    paragraph(d, [{ text: "No issues to fix.", bold: true, color: TONE.pass.strong }, { text: " Nothing that counts against the result was found.", color: C.text }], 9.5, 4);
  }

  // --- Other issues (each issue appears once: not repeated from above) ---------------
  if (others.length) {
    heading(d, "Other issues", remaining.length, 60);
    columnLabels(d, issueLabels, layRow(d, others[0], fixRow).h);
    others.forEach((g) => row(d, g, fixRow));
  }

  // --- Check summary: passed · needs human review · not verified (always shown) ------------
  heading(d, "Check summary", null, 70);
  paragraph(
    d,
    [{ text: `Based on ${data.answered} of ${data.applicable} checks that could be answered. Human review and not verified checks never count for or against the result.`, color: C.muted }],
    8.2,
    6
  );

  // The brief's requirements, split by state; those that are issues or human checks are already listed — never twice.
  const listedAbove = (status: string) => status.startsWith("To fix") || status === "Needs a human check";
  const met = data.requirements.filter((r) => r.status === "Passed");
  const notChecked = data.requirements.filter((r) => r.status !== "Passed" && !listedAbove(r.status));
  const above = data.requirements.filter((r) => listedAbove(r.status)).length;

  // Passed.
  const passedBlocks: Block[] = [{ spans: [{ text: `${data.passedCount} ${data.passedCount === 1 ? "check" : "checks"} passed.`, color: C.text }], size: 8.6 }];
  if (met.length) {
    const counts = new Map<string, number>();
    for (const r of met) counts.set(requirementName(r.type), (counts.get(requirementName(r.type)) ?? 0) + 1);
    passedBlocks.push({
      spans: [{ text: `Brief requirements met (${met.length}):`, bold: true }, { text: [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name)).join(" · "), color: C.text }],
      size: 8.4,
      gapBefore: 3,
    });
  }
  if (data.categories.length) {
    const spans: Span[] = [{ text: "Score by category:", bold: true }];
    data.categories.forEach((c, i) =>
      spans.push({ text: `${i ? "· " : ""}${c.label}`, color: C.text }, { text: c.score === "Not checked" ? "not checked" : c.score, bold: c.score !== "Not checked", color: c.score === "Not checked" ? C.muted : C.ink })
    );
    passedBlocks.push({ spans, size: 8.4, gapBefore: 3 });
  }
  summaryRow(d, "Passed", data.passedCount, TONE.pass, passedBlocks);

  // Needs human review: each item (related ones together) — what it should be, what the AI read, why.
  const humanBlocks: Block[] = [];
  for (const g of groupRelated(data.humanChecks)) {
    const spans: Span[] = [
      { text: g.item.severity.toUpperCase(), bold: true, color: TONE.human.strong },
      { text: `${displayTitle(g.item.title)}${g.count > 1 ? ` (${g.count})` : ""} · ${g.item.category}`, bold: true },
    ];
    humanBlocks.push({ spans, size: 8.6, gapBefore: humanBlocks.length ? 6 : 0 });
    for (const p of g.pairs) {
      const pair: Span[] = [];
      if (p.expected) pair.push({ text: "Should be:", bold: true, color: C.muted }, { text: p.expected, color: C.ink });
      if (p.expected && p.found.length) pair.push({ text: "·", color: C.muted });
      if (p.found.length) pair.push({ text: "AI read:", bold: true, color: C.muted }, { text: p.found.join(" · "), color: C.ink });
      if (pair.length) humanBlocks.push({ spans: pair, size: 8.4, gapBefore: 2 });
    }
    for (const r of g.reasons) humanBlocks.push({ spans: [{ text: r, color: C.text }], size: 8.2, gapBefore: 2 });
  }
  if (!humanBlocks.length) {
    humanBlocks.push({ spans: [{ text: "Nothing needs a human check.", color: C.muted }], size: 8.6 });
  } else {
    humanBlocks[0].gapBefore = 4;
    humanBlocks.unshift({ spans: [{ text: "The AI wasn't sure about these — check each one before sending.", color: C.muted }], size: 8.2, gapBefore: 0 });
  }
  summaryRow(d, "Needs human review", data.humanCheckCount, TONE.human, humanBlocks);

  // Not verified: grouped by reason (the reason said once), and the brief's requirements that couldn't be checked.
  const nvBlocks: Block[] = [];
  const byReason = new Map<string, ReportItem[]>();
  for (const it of data.notVerified) {
    const reason = it.explanation.replace(/^\s*Not verified:\s*/i, "").replace(/\s*Not counted for or against the result\.?\s*$/i, "");
    byReason.set(reason, [...(byReason.get(reason) ?? []), it]);
  }
  for (const [reason, items] of byReason) {
    const names = items.map((it) => `${displayTitle(it.title)} · ${it.category}${it.expected ? ` (expected: ${it.expected})` : ""}`).join(", ");
    nvBlocks.push({ spans: [{ text: names, bold: true }, { text: "—", color: C.muted }, { text: reason, color: C.text }], size: 8.4, gapBefore: nvBlocks.length ? 3 : 0 });
  }
  if (notChecked.length) {
    const spans: Span[] = [{ text: "Brief requirements not checked:", bold: true }];
    notChecked.forEach((r, i) =>
      spans.push({ text: `${i ? " · " : ""}${requirementName(r.type)} "${r.value}"${r.status !== "Not checked" ? ` (${r.status.toLowerCase()})` : ""}`, color: C.text })
    );
    nvBlocks.push({ spans, size: 8.4, gapBefore: nvBlocks.length ? 3 : 0 });
  }
  if (!nvBlocks.length) nvBlocks.push({ spans: [{ text: "Everything could be checked.", color: C.muted }], size: 8.6 });
  summaryRow(d, "Not verified", data.notVerifiedCount, TONE.grey, nvBlocks);

  // What else about the brief: where its other requirements are, and any not part of this check.
  const notes: Span[] = [];
  if (!data.requirements.length) notes.push({ text: "No confirmed requirements.", color: C.muted });
  else if (above) notes.push({ text: `${above} brief requirement${above === 1 ? " is" : "s are"} listed above as ${above === 1 ? "an issue or human check" : "issues or human checks"}.`, color: C.muted });
  if (data.unconfirmedRequirements) notes.push({ text: `${data.unconfirmedRequirements} requirement(s) from the brief weren't part of this check — press Check Design again to include them.`, color: C.muted });
  if (notes.length) {
    d.y -= 4;
    paragraph(d, notes, 8.2, 4);
  }

  // --- Footer on every page ------------------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const left = d.clean(`Skybook AI QC · ${data.companyName} · ${data.generatedAt} · not stored — this file is the only copy${data.sampleData ? " · SAMPLE DATA" : ""}`);
    const right = `Page ${i + 1} of ${pages.length}`;
    p.drawLine({ start: { x: M, y: 42 }, end: { x: PAGE.width - M, y: 42 }, thickness: 0.5, color: C.line, lineCap: LineCapStyle.Butt });
    const leftLine = d.wrap([{ text: left }], 7.2, W - 70)[0].map((s) => s.text).join("");
    faces.regular.draw(p, leftLine, { x: M, y: 30, size: 7.2, color: C.muted });
    faces.regular.draw(p, right, { x: PAGE.width - M - faces.regular.width(right, 7.2), y: 30, size: 7.2, color: C.muted });
    d.lines.push(right);
  });

  return { bytes: await doc.save(), lines: d.lines, unicode: faces.unicode };
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
