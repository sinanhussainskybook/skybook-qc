import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { StandardFonts, type PDFDocument, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

/**
 * Fonts for the QC report (Phase 8.1). Text is drawn with Noto Sans (Latin +
 * Latin Extended) and Noto Sans Arabic — SIL Open Font License, embedded in
 * full (pdf-lib's subsetting breaks Arabic) — so Arabic (and other) client
 * text is readable, not "?". Each character uses the first font that has it.
 * Arabic letters are joined by shapeArabic (presentation forms) and drawn
 * right to left. If the font files can't be loaded, the built-in Helvetica is
 * used exactly as before.
 *
 * Simple bidi: a paragraph with Arabic and no Latin letters reads right to
 * left (its runs are reversed); a mixed paragraph ("Found: 3.94 : 1 —
 * "<Arabic>"") reads left to right with each Arabic phrase — its words, and
 * any number that follows them ("عرض الصيف 20%") — laid out right to left;
 * quotes, separators and anything before the phrase stay where they are.
 * Every number keeps its own digits in reading order (Western or
 * Arabic-Indic). The direction is decided for the WHOLE paragraph
 * (isRightToLeft), never for one styled piece of it: a value after a bold
 * label is part of the label's left-to-right line.
 */

export type FontFiles = { regular: Uint8Array[]; bold: Uint8Array[] };

export interface Face {
  canDraw(ch: string): boolean;
  width(text: string, size: number): number;
  /** `rtl`: the paragraph's direction (isRightToLeft of the whole paragraph); by default, this text's own. */
  draw(page: PDFPage, text: string, o: { x: number; y: number; size: number; color: RGB; rtl?: boolean }): void;
}

const FONT_DIR = (pkg: string) => path.join(process.cwd(), "node_modules", "@fontsource", pkg, "files");
const FILES = {
  regular: [
    path.join(FONT_DIR("noto-sans"), "noto-sans-latin-400-normal.woff"),
    path.join(FONT_DIR("noto-sans"), "noto-sans-latin-ext-400-normal.woff"),
    path.join(FONT_DIR("noto-sans-arabic"), "noto-sans-arabic-arabic-400-normal.woff"),
  ],
  bold: [
    path.join(FONT_DIR("noto-sans"), "noto-sans-latin-700-normal.woff"),
    path.join(FONT_DIR("noto-sans"), "noto-sans-latin-ext-700-normal.woff"),
    path.join(FONT_DIR("noto-sans-arabic"), "noto-sans-arabic-arabic-700-normal.woff"),
  ],
};

/**
 * WOFF → plain TrueType (SFNT). WOFF is TrueType with each table
 * zlib-compressed; PDF viewers need the plain font, so the tables are
 * unpacked and written back with a standard table directory.
 */
export function woffToSfnt(woff: Uint8Array): Uint8Array {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (v.getUint32(0) !== 0x774f4646) return woff; // not WOFF ("wOFF") → already a font
  const flavor = v.getUint32(4);
  const numTables = v.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const offset = v.getUint32(e + 4);
    const compLength = v.getUint32(e + 8);
    const origLength = v.getUint32(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw;
    if (data.length !== origLength) throw new Error("damaged font table");
    tables.push({ tag: v.getUint32(e), checksum: v.getUint32(e + 16), data });
  }
  const pad = (n: number) => (n + 3) & ~3;
  const size = 12 + numTables * 16 + tables.reduce((n, t) => n + pad(t.data.length), 0);
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(numTables));
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  o.setUint16(6, pow * 16);
  o.setUint16(8, Math.log2(pow));
  o.setUint16(10, numTables * 16 - pow * 16);
  let at = 12 + numTables * 16;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    o.setUint32(r, t.tag);
    o.setUint32(r + 4, t.checksum);
    o.setUint32(r + 8, at);
    o.setUint32(r + 12, t.data.length);
    out.set(t.data, at);
    at += pad(t.data.length);
  });
  return out;
}

let cached: Promise<FontFiles | null> | null = null;

/** The report fonts from the installed packages, read once; null if unavailable. */
export function loadReportFonts(): Promise<FontFiles | null> {
  cached ??= (async () => {
    try {
      const read = (files: string[]) => Promise.all(files.map(async (f) => woffToSfnt(new Uint8Array(await readFile(f)))));
      return { regular: await read(FILES.regular), bold: await read(FILES.bold) };
    } catch {
      return null;
    }
  })();
  return cached;
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/**
 * Arabic letter shaping into Unicode presentation forms (isolated, final,
 * initial, medial), so every drawn glyph is the font's glyph for that code
 * point — pdf-lib's own shaping mismatches widths for substituted glyphs.
 * [isolated, final, initial?, medial?]; two forms = joins on the right only.
 */
const FORMS: Record<number, number[]> = {
  0x0621: [0xfe80], 0x0622: [0xfe81, 0xfe82], 0x0623: [0xfe83, 0xfe84], 0x0624: [0xfe85, 0xfe86], 0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c], 0x0627: [0xfe8d, 0xfe8e], 0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92], 0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98], 0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c], 0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4], 0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8], 0x062f: [0xfea9, 0xfeaa], 0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae], 0x0632: [0xfeaf, 0xfeb0], 0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], 0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc], 0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0], 0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8], 0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc], 0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4], 0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8], 0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0], 0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4], 0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec], 0x0648: [0xfeed, 0xfeee], 0x0649: [0xfeef, 0xfef0], 0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59], 0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d], 0x0698: [0xfb8a, 0xfb8b],
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91], 0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95], 0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff],
};
/** Lam + alef ligatures: [isolated, final]. */
const LAM_ALEF: Record<number, [number, number]> = { 0x0622: [0xfef5, 0xfef6], 0x0623: [0xfef7, 0xfef8], 0x0625: [0xfef9, 0xfefa], 0x0627: [0xfefb, 0xfefc] };
const TATWEEL = 0x0640;
const isMark = (cp: number) => (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06ed);
const joinsForward = (cp: number | undefined) => cp === TATWEEL || (cp !== undefined && (FORMS[cp]?.length ?? 0) === 4);
const joinsBack = (cp: number | undefined) => cp === TATWEEL || (cp !== undefined && (FORMS[cp]?.length ?? 0) >= 2);

/** Arabic text in logical order → the same text in contextual presentation forms (still logical order). */
export function shapeArabic(text: string): string {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  const neighbour = (i: number, step: 1 | -1) => {
    for (let j = i + step; j >= 0 && j < cps.length; j += step) if (!isMark(cps[j])) return cps[j];
    return undefined;
  };
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS[cp];
    if (!forms) {
      out.push(cp);
      continue;
    }
    const prev = joinsForward(neighbour(i, -1));
    const next = neighbour(i, 1);
    if (cp === 0x0644 && next !== undefined && LAM_ALEF[next]) {
      out.push(LAM_ALEF[next][prev ? 1 : 0]);
      let j = i + 1;
      while (isMark(cps[j])) out.push(cps[j++]);
      i = j; // the alef is part of the ligature
      continue;
    }
    const canNext = forms.length === 4 && joinsBack(next);
    out.push(prev && canNext ? forms[3] : prev ? forms[1] : canNext ? forms[2] : forms[0]);
  }
  return String.fromCodePoint(...out);
}
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;

/**
 * A number — Western or Arabic-Indic digits with their separators, and a
 * percent sign: one unit, its digits always in reading order.
 */
const NUMBER = /^[0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,٫٬]*[0-9٠-٩۰-۹])?[%٪‰]?$/;
/** A line's pieces: numbers, runs of spaces, Arabic words (digits apart), and single other characters. */
const TOKENS =
  /[0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,٫٬]*[0-9٠-٩۰-۹])?[%٪‰]?| +|[؀-ٟ٪-ۯۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+|[\s\S]/g;

/** A paragraph reads right to left when it has Arabic and no Latin letters at all. */
export const isRightToLeft = (text: string) => ARABIC.test(text) && !LATIN_LETTER.test(text);

/** The built-in Helvetica (Western characters only). */
export async function standardFaces(doc: PDFDocument): Promise<{ regular: Face; bold: Face }> {
  const make = (font: PDFFont): Face => {
    const known = new Map<string, boolean>();
    return {
      canDraw(ch) {
        let ok = known.get(ch);
        if (ok === undefined) {
          try {
            font.encodeText(ch);
            ok = true;
          } catch {
            ok = false;
          }
          known.set(ch, ok);
        }
        return ok;
      },
      width: (text, size) => font.widthOfTextAtSize(text, size),
      draw: (page, text, o) => page.drawText(text, { x: o.x, y: o.y, size: o.size, color: o.color, font }),
    };
  };
  return { regular: make(await doc.embedFont(StandardFonts.Helvetica)), bold: make(await doc.embedFont(StandardFonts.HelveticaBold)) };
}

type Fontkit = { hasGlyphForCodePoint(cp: number): boolean };

/** Noto Sans + Noto Sans Arabic, embedded in full. */
export async function unicodeFaces(doc: PDFDocument, files: FontFiles): Promise<{ regular: Face; bold: Face }> {
  doc.registerFontkit(fontkit);
  const make = async (bytes: Uint8Array[]): Promise<Face> => {
    // Full embed: pdf-lib's subsetting drops the shaped (joined) Arabic letter forms.
    // No font-level shaping: pdf-lib records glyph widths but not the mark
    // positions shaping relies on, so ligatures ("fi") gap and Arabic dots
    // drift. Arabic is joined by shapeArabic instead; each code point then
    // draws its own complete glyph.
    const OFF = { liga: false, clig: false, calt: false, ccmp: false, locl: false, rlig: false, init: false, medi: false, fina: false, isol: false, mark: false, mkmk: false, kern: false };
    const fonts = await Promise.all(bytes.map((b) => doc.embedFont(b, { subset: false, features: OFF })));
    const kits = bytes.map((b) => (fontkit as unknown as { create(b: Buffer): Fontkit }).create(Buffer.from(b)));
    const pick = (ch: string): number => {
      const cp = ch.codePointAt(0) ?? 0;
      return kits.findIndex((k) => k.hasGlyphForCodePoint(cp));
    };
    /**
     * Splits a line into runs that share a font. Each Arabic word is one
     * shaped run (fontkit draws it right to left); spaces use the Latin font.
     * Word order: in a left-to-right paragraph each Arabic phrase (its words
     * and any numbers that follow them) is reversed; in a right-to-left
     * paragraph (`rtl`, decided for the whole paragraph) every run is reversed.
     */
    const runs = (raw: string, rtl = isRightToLeft(raw)): { font: PDFFont; text: string }[] => {
      type Item = { index: number; text: string; kind: "arabic" | "number" | "space" | "other" };
      const items: Item[] = [];
      for (const token of raw.match(TOKENS) ?? []) {
        if (/^ +$/.test(token)) {
          items.push({ index: Math.max(0, pick(" ")), text: token, kind: "space" });
        } else if (NUMBER.test(token)) {
          // A number keeps its digits in reading order. The font engine lays out Arabic-script
          // characters (Arabic-Indic digits, ٪) right to left, so those are handed over reversed.
          const text = ARABIC.test(token) ? [...token].reverse().join("") : token;
          items.push({ index: Math.max(0, pick([...token][0])), text, kind: "number" });
        } else if (ARABIC.test(token)) {
          const shaped = shapeArabic(token);
          items.push({ index: Math.max(0, pick([...shaped][0])), text: shaped, kind: "arabic" });
        } else {
          for (const ch of token) {
            const index = Math.max(0, pick(ch));
            const last = items[items.length - 1];
            if (last && last.kind === "other" && last.index === index) last.text += ch;
            else items.push({ index, text: ch, kind: "other" });
          }
        }
      }
      let ordered: Item[];
      if (rtl) {
        ordered = [...items].reverse(); // a right-to-left paragraph
      } else {
        ordered = [];
        const inPhrase = (it: Item | undefined) => it !== undefined && (it.kind === "arabic" || it.kind === "number");
        for (let i = 0; i < items.length; ) {
          if (items[i].kind !== "arabic") {
            ordered.push(items[i++]);
            continue;
          }
          // An Arabic phrase: Arabic words — and numbers that follow them ("عرض الصيف 20%") — with single
          // spaces between; read right to left as a whole. A number BEFORE the Arabic stays where it is.
          let j = i + 1;
          while (j < items.length) {
            if (inPhrase(items[j])) j++;
            else if (items[j].kind === "space" && items[j].text.length === 1 && inPhrase(items[j + 1])) j += 2;
            else break;
          }
          ordered.push(...items.slice(i, j).reverse());
          i = j;
        }
      }
      return ordered.map((r) => ({ font: fonts[r.index], text: r.text }));
    };
    return {
      canDraw: (ch) => pick(ch) >= 0,
      width: (text, size) => runs(text).reduce((sum, r) => sum + r.font.widthOfTextAtSize(r.text, size), 0),
      draw(page, text, { rtl, ...o }) {
        let x = o.x;
        for (const r of runs(text, rtl)) {
          page.drawText(r.text, { ...o, x, font: r.font });
          x += r.font.widthOfTextAtSize(r.text, o.size);
        }
      },
    };
  };
  return { regular: await make(files.regular), bold: await make(files.bold) };
}

/** Unicode faces when the fonts are available and embed cleanly; otherwise Helvetica. */
export async function reportFaces(doc: PDFDocument, files: FontFiles | null): Promise<{ regular: Face; bold: Face; unicode: boolean }> {
  if (files) {
    try {
      return { ...(await unicodeFaces(doc, files)), unicode: true };
    } catch {
      // fall through to the built-in font
    }
  }
  return { ...(await standardFaces(doc)), unicode: false };
}
