import { LineCapStyle, PDFDocument, rgb, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import type { ReportData, ReportItem } from "@/lib/report/report-data";
import { isRightToLeft, loadReportFonts, reportFaces, type Face, type FontFiles } from "@/lib/report/report-fonts";
import { resultDisplay } from "@/lib/qc/scoring";
import { alsoNote, NOT_CHECKED, splitNotChecked, verifyNote } from "@/lib/qc/golden-rules-view";

/**
 * Draws the QC report (Phase 8) as an A4 PDF with pdf-lib — pure
 * JavaScript, no native parts, so it runs the same on the production
 * server. Built in memory on download; nothing is written to disk or stored.
 *
 * Short and scannable — one page for a simple report, two with many findings:
 *   Header          a blue band with the Skybook mark and "AI Design QC
 *                   Report"; company, design file and report date; the
 *                   result in large type with the score in a ring; one line
 *                   of counts (issues, to verify, passed)
 *   Findings        one table — Severity | Issue | Suggested fix — grouped
 *                   Critical · Major · Minor · Suggestions. A broken Golden
 *                   Rule is one of them (marked Golden Rule, Mandatory /
 *                   Optional); followed rules aren't listed. Anything a person
 *                   has to look at sits beside the issues of its severity with
 *                   a short "Please verify" note — never its own section;
 *                   Expected / Found inside the issue when there is
 *                   something to compare. Repeats of the same issue share a
 *                   row with every value found.
 *   In short        passed as a count; what couldn't be verified, by name
 * A row never splits across pages, and when the table continues on a new
 * page its column headings are repeated. Presentation only: the data is
 * exactly ReportData.
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
  wash: hex("#f8fafc"),
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
  // Invisible format characters OCR can pass on (zero-width, direction marks / embeddings / isolates,
  // byte-order mark): no font draws them, so they'd show as "?" — they carry no visible text.
  [/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ""],
];

/** A run of text within a line: its own weight and colour. `keep`: one value — kept whole on a line when it fits. */
type Span = { text: string; bold?: boolean; color?: RGB; keep?: boolean };
/** A block: one or more spans, wrapped together to a width. */
type Block = { spans: Span[]; size: number; gapBefore?: number };
/** `rtl`: the paragraph's direction — decided once for the whole block, so each line and span is drawn the same way. */
type Laid = { size: number; gapBefore: number; lines: Span[][]; rtl: boolean };

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

  /**
   * Wraps spans to `width`; a span may break across lines, a too-long word is
   * cut. A `keep` span (one value, e.g. '3.40 : 1 — "Packages" (#67EDF7 on
   * #0B7AB0)') moves to the next line whole rather than splitting — unless it
   * is longer than a whole line, when it wraps like any text. Nothing is dropped.
   */
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
      const whole = span.keep ? this.clean(span.text).replace(/ +/g, " ").trim() : "";
      if (whole && font.width(whole, size) <= width) {
        if (line.length && used + font.width(` ${whole}`, size) > width) push();
        add(span, whole);
        continue;
      }
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
    const laid = blocks.map((b) => ({
      size: b.size,
      gapBefore: b.gapBefore ?? 0,
      lines: this.wrap(b.spans, b.size, width),
      rtl: isRightToLeft(this.clean(b.spans.map((s) => s.text).join(" "))),
    }));
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
          font.draw(this.page, span.text, { x: cx, y: y + b.size * 0.3, size: b.size, color: span.color ?? C.ink, rtl: b.rtl });
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

/** A rounded rectangle; (x, top) is its top-left corner. */
function roundRect(d: Doc, x: number, top: number, w: number, h: number, r: number, o: { fill: RGB; border?: RGB }) {
  const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  d.page.drawSvgPath(path, { x, y: top, color: o.fill, ...(o.border ? { borderColor: o.border, borderWidth: 0.7 } : {}) });
}

/** The score out of 100 as a ring — the share of the ring in the result's colour — with the number inside. */
function scoreRing(d: Doc, score: number, cx: number, cy: number, r: number, width: number, tone: Tone, numberSize = 19) {
  d.page.drawCircle({ x: cx, y: cy, size: r, borderColor: C.line, borderWidth: width });
  const share = Math.max(0, Math.min(100, score)) / 100;
  if (share >= 1) d.page.drawCircle({ x: cx, y: cy, size: r, borderColor: tone.strong, borderWidth: width });
  else if (share > 0) {
    // Clockwise from the top (SVG y points down).
    const a = share * 2 * Math.PI;
    const ex = r * Math.sin(a);
    const ey = -r * Math.cos(a);
    d.page.drawSvgPath(`M 0 ${-r} A ${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`, {
      x: cx,
      y: cy,
      borderColor: tone.strong,
      borderWidth: width,
      borderLineCap: LineCapStyle.Round,
    });
  }
  const n = String(score);
  d.write(n, cx - d.width(n, numberSize, true) / 2, cy - numberSize * 0.12, numberSize, { bold: true });
  d.write("/ 100", cx - d.width("/ 100", 7.5) / 2, cy - numberSize * 0.12 - 13, 7.5, { color: C.muted });
}

/** A section heading, kept with the first `follow` points of what comes after it. */
function heading(d: Doc, title: string, count: number | null, follow: number, color: RGB = C.brand) {
  d.ensure(32 + follow);
  if (d.y < TOP - 30) d.y -= 8;
  const w = tracked(d, title.toUpperCase(), M, d.y - 12, 10.5, 1.1, color);
  if (count !== null) d.write(String(count), M + w + 6, d.y - 12, 9, { bold: true, color: C.muted });
  d.page.drawLine({ start: { x: M, y: d.y - 17 }, end: { x: PAGE.width - M, y: d.y - 17 }, thickness: 0.6, color: C.line });
  d.y -= 22;
}

/** Bold text drawn with extra space between letters; returns its width. Recorded as plain text. */
function tracked(d: Doc, text: string, x: number, baseline: number, size: number, spacing: number, color: RGB): number {
  let cx = x;
  for (const ch of d.clean(text)) {
    d.font(true).draw(d.page, ch, { x: cx, y: baseline, size, color });
    cx += d.font(true).width(ch, size) + spacing;
  }
  d.lines.push(d.clean(text));
  return cx - x - spacing;
}

// Findings as ONE compact table — Severity | Issue | Suggested fix — grouped by
// severity under a thin divider row. A row never splits; when the table continues
// on a new page its column headings are repeated.
type Col = { label: string; width: number };
const PAD = 6; // inside each cell, left and right
const ROW_PAD = 6; // above and below each row's text
const HEAD_H = 19;
const COLS: Col[] = [
  { label: "Severity", width: 82 },
  { label: "Issue", width: 250 },
  { label: "Suggested fix", width: W - 82 - 250 },
];

type TableRow = { cells: Block[][] };
/** `count`: how many findings (a row can hold several repeats of one issue) — the same number as the counts at the top. */
type TableGroup = { title: string; tone: Tone; count: number; verify?: number; rows: TableRow[] };
type LaidRow = { cells: { laid: Laid[]; height: number }[]; h: number };

function layRow(d: Doc, cells: Block[][]): LaidRow {
  const laid = cells.map((blocks, i) => d.lay(blocks.length ? blocks : [{ spans: [{ text: "—", color: C.muted }], size: 8.6 }], COLS[i].width - PAD * 2));
  return { cells: laid, h: Math.max(...laid.map((c) => c.height)) + ROW_PAD * 2 };
}

/** The column headings on a light band. */
function tableHead(d: Doc) {
  d.page.drawRectangle({ x: M, y: d.y - HEAD_H, width: W, height: HEAD_H, color: C.wash });
  d.page.drawLine({ start: { x: M, y: d.y - HEAD_H }, end: { x: PAGE.width - M, y: d.y - HEAD_H }, thickness: 0.6, color: C.line });
  let x = M;
  for (const c of COLS) {
    d.write(c.label.toUpperCase(), x + PAD, d.y - 12.5, 6.8, { bold: true, color: C.muted });
    x += c.width;
  }
  d.y -= HEAD_H;
}

const DIVIDER_H = 18;
/** A thin divider row naming the severity group and how many. */
function groupDivider(d: Doc, g: TableGroup) {
  d.page.drawRectangle({ x: M, y: d.y - DIVIDER_H, width: W, height: DIVIDER_H, color: g.tone.soft });
  const w = tracked(d, g.title.toUpperCase(), M + PAD, d.y - 12, 7.2, 1, g.tone.strong);
  // "7" alone; with items to verify, both said in words: "2 issues · 2 to verify".
  const n = g.verify ? [g.count ? `${g.count} ${g.count === 1 ? "issue" : "issues"}` : "", `${g.verify} to verify`].filter(Boolean).join(" · ") : String(g.count);
  d.write(n, M + PAD + w + 6, d.y - 12, 7.2, { bold: true, color: C.muted });
  d.y -= DIVIDER_H;
}

/**
 * The table under a heading. The heading, the column headings, the first group's
 * divider and its first row stay together; each divider stays with its first row.
 */
function findingsTable(d: Doc, title: string, groups: TableGroup[], o: { heading?: boolean; dividers?: boolean } = {}) {
  const dividers = o.dividers ?? true;
  const laid = groups.map((g) => ({ g, rows: g.rows.map((r) => layRow(d, r.cells)) }));
  const first = HEAD_H + (dividers ? DIVIDER_H : 0) + (laid[0]?.rows[0]?.h ?? 0);
  if (o.heading ?? true) heading(d, title, null, first);
  else d.ensure(first);
  tableHead(d);
  const continueOnNewPage = () => {
    d.newPage();
    tracked(d, `${title} (continued)`.toUpperCase(), M, d.y - 9, 7.5, 1.1, C.brand);
    d.y -= 16;
    tableHead(d);
  };
  for (const { g, rows } of laid) {
    if (dividers) {
      if (d.y - DIVIDER_H - (rows[0]?.h ?? 0) < BOTTOM) continueOnNewPage();
      groupDivider(d, g);
    }
    for (const row of rows) {
      if (d.y - row.h < BOTTOM) continueOnNewPage();
      let x = M;
      row.cells.forEach((cell, i) => {
        d.draw(cell.laid, x + PAD, d.y - ROW_PAD + 2);
        x += COLS[i].width;
      });
      d.y -= row.h;
      d.page.drawLine({ start: { x: M, y: d.y }, end: { x: PAGE.width - M, y: d.y }, thickness: 0.4, color: C.line });
    }
  }
  d.y -= 8;
}

const MANDATORY = /\bmandatory\b/i;

/** Every value found: joined with "·" so a long list wraps compactly. */
function valueSpans(values: string[]): Span[] {
  const spans: Span[] = [];
  values.forEach((v, i) => spans.push(...(i ? [{ text: "·", color: C.muted }] : []), { text: v, color: C.ink, keep: true }));
  return spans;
}

/** The severity cell: the severity in its colour, and a Mandatory / Optional marker when there is one. */
function severityCell(label: string, tone: Tone, marker: string | null): Block[] {
  const cell: Block[] = [{ spans: [{ text: label.toUpperCase(), bold: true, color: tone.strong }], size: 7.4 }];
  if (marker) cell.push({ spans: [{ text: marker.toUpperCase(), bold: true, color: marker === "Mandatory" ? TONE.critical.strong : C.muted }], size: 6.6, gapBefore: 3 });
  return cell;
}

/**
 * One issue row: severity (+ Mandatory / Optional) | what the issue is, where,
 * and — when there is something to compare — what was expected and found | the fix.
 */
function issueRow(g: Related, tone: Tone): TableRow {
  const it = g.item;
  const marker = it.marker ?? (MANDATORY.test(it.explanation) ? "Mandatory" : null);
  const issue: Block[] = [{ spans: [{ text: `${displayTitle(it.title)}${g.count > 1 ? ` (${g.count})` : ""}`, bold: true }], size: 9 }];
  const where = [it.marker ? "Golden Rule" : it.category, it.file].filter(Boolean).join(" · ");
  if (where) issue.push({ spans: [{ text: where, color: C.muted }], size: 7.6, gapBefore: 1 });
  for (const p of g.pairs) {
    if (p.expected && p.found.length) issue.push({ spans: [{ text: "Expected:", bold: true, color: C.muted }, { text: p.expected, color: C.ink }], size: 8.2, gapBefore: 3 });
    if (p.found.length) issue.push({ spans: [{ text: "Found:", bold: true, color: C.muted }, ...valueSpans(p.found)], size: 8.2, gapBefore: p.expected ? 1 : 3 });
  }
  if (it.alsoCovers) issue.push({ spans: [{ text: alsoNote(it.alsoCovers), color: C.muted }], size: 7.6, gapBefore: 3 });
  const fix: Block[] = g.fixes.map((f, i) => ({ spans: [{ text: f, bold: true }], size: 8.6, gapBefore: i ? 3 : 0 }));
  return { cells: [severityCell(it.severity, tone, marker), issue, fix] };
}

/**
 * Something a person has to look at, beside the issues of its severity: what it
 * is, what was expected and found, and a short "Please verify" note saying why
 * — never a separate section, never counted.
 */
function verifyRow(g: Related, tone: Tone, severity: string): TableRow {
  const it = g.item;
  const issue: Block[] = [{ spans: [{ text: `${displayTitle(it.title)}${g.count > 1 ? ` (${g.count})` : ""}`, bold: true }], size: 9 }];
  const where = [it.marker ? "Golden Rule" : it.category, it.file].filter(Boolean).join(" · ");
  issue.push({ spans: [{ text: where, color: C.muted }], size: 7.6, gapBefore: 1 });
  for (const p of g.pairs) {
    const found = p.found.filter((v) => v !== "Not checked");
    if (p.expected && p.expected !== it.title) issue.push({ spans: [{ text: "Expected:", bold: true, color: C.muted }, { text: p.expected, color: C.ink }], size: 8.2, gapBefore: 3 });
    if (found.length) issue.push({ spans: [{ text: "Found:", bold: true, color: C.muted }, ...valueSpans(found)], size: 8.2, gapBefore: 1 });
  }
  if (it.alsoCovers) issue.push({ spans: [{ text: alsoNote(it.alsoCovers, true), color: C.muted }], size: 7.6, gapBefore: 3 });
  const cell: Block[] = [
    { spans: [{ text: severity.toUpperCase(), bold: true, color: tone.strong }], size: 7.4 },
    { spans: [{ text: "PLEASE VERIFY", bold: true, color: TONE.human.strong }], size: 6.6, gapBefore: 3 },
    ...(it.marker ? [{ spans: [{ text: it.marker.toUpperCase(), bold: true, color: it.marker === "Mandatory" ? TONE.critical.strong : C.muted }], size: 6.6, gapBefore: 2 }] : []),
  ];
  const note: Block[] = [{ spans: [{ text: "Please verify:", bold: true, color: TONE.human.strong }, { text: verifyNote(it), color: C.text }], size: 8.4 }];
  return { cells: [cell, issue, note] };
}

/** The Skybook mark (components/layout/skybook-mark.tsx), in flat colours; `size` is its height. */
function skybookMark(d: Doc, x: number, top: number, size: number) {
  const scale = size / 112;
  const at = { x, y: top, scale };
  d.page.drawSvgPath("M14 24 C15 15 19 9 25 6 C21 12 20 18 21 24 Z", { ...at, color: hex("#2E8BD0") });
  d.page.drawSvgPath("M17 22 H73 A11 11 0 0 1 84 33 V97 A11 11 0 0 1 73 108 H17 A11 11 0 0 1 6 97 V33 A11 11 0 0 1 17 22 Z", { ...at, color: hex("#1F5BAA") });
  d.page.drawSvgPath("M2 104 C32 96 60 72 94 20 L104 28 C70 84 36 106 2 114 Z", { ...at, color: C.white });
  d.page.drawSvgPath("M78 40 C84 33 89 26 94 20 L104 28 C99 34 94 40 89 46 Z", { ...at, color: C.white });
  d.page.drawSvgPath("M92 46 L124 8 L110 52 Z", { ...at, color: hex("#27A6E3") });
  d.page.drawSvgPath("M92 46 L104 28 L106 44 Z", { ...at, color: hex("#15607F") });
}

/**
 * Findings of the same check in the same place (e.g. two "Required text"
 * corrections) under ONE header. Each correction keeps its own expected,
 * found and fix lines — combined for reading, never merged into one claim.
 */
export type Section = { item: ReportItem; count: number; groups: Related[] };
export function groupSections(items: ReportItem[]): Section[] {
  const out = new Map<string, Section>();
  for (const g of groupRelated(items)) {
    const key = [g.item.severity, g.item.category, displayTitle(g.item.title), g.item.file ?? ""].join("\u0000");
    const s = out.get(key) ?? { item: g.item, count: 0, groups: [] };
    s.count += g.count;
    s.groups.push(g);
    out.set(key, s);
  }
  return [...out.values()];
}

/** A compact paragraph (label + text), kept together. */
function paragraph(d: Doc, spans: Span[], size = 8.6, gapAfter = 6, x = M, width = W) {
  const p = d.lay([{ spans, size }], width);
  d.ensure(p.height + gapAfter);
  d.y -= d.draw(p.laid, x, d.y) + gapAfter;
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

  // --- Header band: the Skybook mark and the title, on a blue gradient --------------------
  const image = await embedLogo(doc, logo);
  const bandH = 92;
  const bandBottom = PAGE.height - bandH;
  const from = [0x0f, 0x2c, 0x57];
  const to = [0x1d, 0x63, 0xb8];
  const strips = 120;
  for (let i = 0; i < strips; i++) {
    const t = i / (strips - 1);
    const c = from.map((v, k) => Math.round(v + (to[k] - v) * t) / 255);
    d.page.drawRectangle({ x: (PAGE.width / strips) * i, y: bandBottom, width: PAGE.width / strips + 0.5, height: bandH, color: rgb(c[0], c[1], c[2]) });
  }
  d.page.drawSvgPath(`M ${PAGE.width * 0.55} ${bandH} C ${PAGE.width * 0.75} ${bandH - 8} ${PAGE.width * 0.9} ${bandH * 0.5} ${PAGE.width} 0 L ${PAGE.width} ${bandH} Z`, {
    x: 0,
    y: PAGE.height,
    color: C.white,
    opacity: 0.08,
  });
  roundRect(d, M, PAGE.height - 24, 44, 44, 9, { fill: C.white });
  skybookMark(d, M + 5, PAGE.height - 29, 34);
  tracked(d, "SKYBOOK AI QC", M + 58, PAGE.height - 38, 7.2, 1.6, hex("#9CC3EE"));
  d.write("AI Design QC Report", M + 58, PAGE.height - 62, 21, { bold: true, color: C.white });
  if (image) {
    // The client's logo on a white tile, right of the title.
    const scale = Math.min(96 / image.width, 30 / image.height, 1);
    const w = image.width * scale + 16;
    roundRect(d, PAGE.width - M - w, PAGE.height - 24, w, 44, 9, { fill: C.white });
    d.page.drawImage(image, { x: PAGE.width - M - w + 8, y: PAGE.height - 46 - (image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
  }
  d.y = bandBottom - 18;

  // The details: company, design file, report date.
  const facts: [string, string][] = [
    ["Company", data.companyName],
    [data.files.length > 1 ? "Design files" : "Design file", data.files.length ? data.files.join(", ") : "—"],
    ["Report date", data.generatedAt],
  ];
  const shares = [0.3, 0.38, 0.32];
  const cells = facts.map(([label, value], i) => ({ label, v: d.lay([{ spans: [{ text: value, bold: true }], size: 9.2 }], W * shares[i] - 14) }));
  cells.forEach((c, i) => {
    const x = M + W * shares.slice(0, i).reduce((a, b) => a + b, 0);
    d.write(c.label.toUpperCase(), x, d.y - 7, 6.6, { bold: true, color: C.muted });
    d.draw(c.v.laid, x, d.y - 10);
  });
  d.y -= 12 + Math.max(...cells.map((c) => c.v.height));
  const kind = [data.contentType, data.platform].filter(Boolean).join(" · ");
  paragraph(d, [{ text: `Checked as ${kind}${data.providerNote ? ` · analysed by ${data.providerNote}` : ""}`, color: C.muted }], 8, 0);
  d.rule(10, 16);

  if (data.sampleData) paragraph(d, [{ text: "SAMPLE DATA — NOT REAL AI. This is not a real QC result.", bold: true, color: TONE.major.strong }], 9.5, 10);

  // --- The result and score, prominently; one line of counts ------------------------------
  const shown = resultDisplay({ result: data.result, humanChecks: data.humanCheckCount });
  const tone = shown ? RESULT_TONE[shown] : TONE.grey;
  const ringR = 31;
  const ringW = 7;
  const textX = data.score !== null ? M + ringR * 2 + ringW + 20 : M;
  const textW = PAGE.width - M - textX;
  let size = 26;
  while (size > 14 && d.width(data.resultLabel, size, true) > textW) size--;
  const summary = d.lay([{ spans: [{ text: data.resultSummary, color: C.text }], size: 10 }], textW);
  const top = d.y;
  if (data.score !== null) scoreRing(d, data.score, M + ringR + ringW / 2, top - ringR - ringW / 2, ringR, ringW, tone, 21);
  d.write("RESULT", textX, top - 6, 6.6, { bold: true, color: C.muted });
  d.write(data.resultLabel, textX, top - 10 - size * 0.92, size, { bold: true, color: tone.strong });
  d.draw(summary.laid, textX, top - 15 - size * 1.08);
  d.y = Math.min(top - 15 - size * 1.08 - summary.height, data.score !== null ? top - ringR * 2 - ringW : Infinity) - 14;

  const counts: { n: number; label: string; tone: Tone }[] = [
    { n: data.issues.critical, label: "Critical", tone: TONE.critical },
    { n: data.issues.major, label: "Major", tone: TONE.major },
    { n: data.issues.minor, label: "Minor", tone: TONE.minor },
    { n: data.issues.suggestion, label: data.issues.suggestion === 1 ? "Suggestion" : "Suggestions", tone: TONE.grey },
    { n: data.humanChecks.length, label: "To verify", tone: TONE.human },
    { n: data.passedCount, label: "Passed", tone: TONE.pass },
  ];
  let cx = M;
  for (const c of counts) {
    const w = 10 + d.width(String(c.n), 9.5, true) + d.width(` ${c.label}`, 9) + 14;
    d.page.drawCircle({ x: cx + 3, y: d.y - 7, size: 3, color: c.n ? c.tone.strong : C.line });
    d.font(true).draw(d.page, String(c.n), { x: cx + 10, y: d.y - 10.2, size: 9.5, color: c.n ? C.ink : C.muted });
    d.font(false).draw(d.page, ` ${c.label}`, { x: cx + 10 + d.width(String(c.n), 9.5, true), y: d.y - 10.2, size: 9, color: C.text });
    d.lines.push(`${c.n} ${c.label}`);
    cx += w;
  }
  d.y -= 16;
  d.rule(4, 6);

  // --- Findings: one table, grouped by severity — each issue once ------------------------
  const groups: TableGroup[] = [];
  for (const [severity, title, t] of [
    ["Critical", "Critical", TONE.critical],
    ["Major", "Major", TONE.major],
    ["Minor", "Minor", TONE.minor],
    ["Suggestion", "Suggestions", TONE.grey],
  ] as const) {
    const items = data.issuesToFix.filter((it) => it.severity === severity);
    const verify = data.humanChecks.filter((it) => it.severity === severity);
    if (items.length || verify.length) {
      groups.push({
        title,
        tone: t,
        count: items.length,
        verify: verify.length,
        rows: [...groupRelated(items).map((g) => issueRow(g, t)), ...groupRelated(verify).map((g) => verifyRow(g, t, severity))],
      });
    }
  }
  if (groups.length) {
    findingsTable(d, "Findings", groups);
  } else {
    heading(d, "Findings", null, 20);
    paragraph(d, [{ text: "No issues to fix.", bold: true, color: TONE.pass.strong }, { text: " Nothing to fix or verify.", color: C.text }], 9.5, 6);
  }

  // --- In short: passed as a count; what couldn't be checked, by name ---------------------
  const listedAbove = (status: string) => status.startsWith("To fix") || status === "Needs a human check";
  const notChecked = data.requirements.filter((r) => r.status !== "Passed" && !listedAbove(r.status));
  const notes: Span[][] = [
    [{ text: `${data.passedCount} ${data.passedCount === 1 ? "check" : "checks"} passed.`, bold: true, color: TONE.pass.strong }],
  ];
  const unanswered = notChecked.filter((r) => r.status === "Not checked"); // brief items with no check at all
  // What couldn't be checked: missing company settings apart from design checks that couldn't be confirmed.
  const unchecked = splitNotChecked(data.notVerified);
  for (const kind of ["settings", "auto"] as const) {
    const names = unchecked[kind].map((it) => `${displayTitle(it.title)}${it.marker ? " (Golden Rule)" : ""}`);
    if (!names.length) continue;
    notes.push([
      { text: `${NOT_CHECKED[kind].label} (${names.length}):`, bold: true, color: C.text },
      { text: names.join(" · "), color: C.text },
      { text: `— ${NOT_CHECKED[kind].note}`, color: C.muted },
    ]);
  }
  if (unanswered.length) {
    notes.push([
      { text: `Not checked from the brief (${unanswered.length}):`, bold: true, color: C.text },
      { text: unanswered.map((r) => requirementName(r.type)).join(" · "), color: C.text },
    ]);
  }
  if (!data.requirements.length) notes.push([{ text: "No requirements from the brief were checked.", color: C.muted }]);
  if (data.unconfirmedRequirements) notes.push([{ text: `${data.unconfirmedRequirements} requirement(s) from the brief weren't part of this check — press Check Design again to include them.`, color: C.muted }]);
  heading(d, "In short", null, 30);
  for (const n of notes) paragraph(d, n, 8.4, 3);

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
