/**
 * Comparison helpers (plan 5.3): is what the content says the same as what
 * was approved? Pure functions, no AI — they compare text that something
 * else has read (Phase 6), or a test fixture.
 *
 * Each `find…` pulls candidate values out of free text; each `…Match`
 * compares two values. Formats that can't be read with confidence are
 * reported as not found rather than guessed.
 */

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Arabic-Indic (٠–٩) and Eastern Arabic (۰–۹) digits as 0–9, the Arabic percent sign as %, and the Arabic
 * thousands / decimal separators as "," / "." — one character for one, so positions in the text don't move.
 */
export function asciiNumbers(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٪/g, "%")
    .replace(/٬/g, ",")
    .replace(/٫/g, ".");
}

/**
 * Arabic written the ways that mean the same word: without its optional vowel marks (harakat) and the
 * tatweel stretch, and with the alef forms (أ إ آ ٱ) as ا and alef maqsura (ى) as ي. Teh marbuta (ة) is
 * kept as it is — it isn't the same letter as ه.
 */
function foldArabic(value: string): string {
  return value
    .replace(/[ً-ٰٟۖ-ۭـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي");
}

/**
 * Combining marks belong to the letter before them (Hindi vowel signs); one after anything else — an
 * emoji's variation selector in "➡️" / "❤️", a keycap in "1️⃣" — is no part of a word and is dropped.
 */
const withoutStrayMarks = (value: string) => value.replace(/(?<![\p{L}\p{M}])\p{M}+/gu, "");

/**
 * Lower-case words: letters (with the marks that are part of them, as in Hindi), digits and % only;
 * quotes, dashes and punctuation become spaces. "&" is the word "and" ("T&C" = "T and C"); Arabic is
 * folded (foldArabic) and Arabic-Indic digits read as 0–9, so the same words always compare equal.
 */
export function normalizeWords(value: string): string {
  return withoutStrayMarks(foldArabic(asciiNumbers(value.normalize("NFKC"))))
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[‘’ʼ']/g, "") // Skybook’s → skybooks
    .replace(/[^\p{L}\p{M}\p{N}%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** -our words written -or in US English ("colour" / "color"), with what follows ("colourful", "favourite"). */
const OUR_WORDS = ["colour", "favour", "flavour", "honour", "harbour", "neighbour", "behaviour", "labour", "humour", "rumour", "savour", "endeavour", "vapour", "armour", "parlour", "odour", "vigour", "splendour"];
/** -re words written -er in US English ("centre" / "center"). */
const RE_WORDS = ["centre", "theatre", "metre", "litre", "fibre", "calibre", "spectre", "sombre", "lustre", "sabre", "kilometre", "centimetre", "millimetre"];
/** Words whose l is doubled in UK English before -ed / -ing / -er ("travelled" / "traveled"). */
const DOUBLE_L = ["travel", "cancel", "label", "model", "fuel", "signal", "level", "counsel", "marvel", "total", "dial", "jewel", "channel", "tunnel", "panel", "equal", "pedal", "shovel", "snorkel", "duel"];
/** Other UK spellings and their US form. */
const UK_US: Record<string, string> = {
  programme: "program", programmes: "programs", catalogue: "catalog", catalogues: "catalogs", dialogue: "dialog", dialogues: "dialogs",
  grey: "gray", jewellery: "jewelry", aluminium: "aluminum", licence: "license", licences: "licenses", defence: "defense",
  offence: "offense", enrolment: "enrollment", enrol: "enroll", fulfil: "fulfill", fulfilment: "fulfillment", practise: "practice",
  ageing: "aging", cosy: "cozy", mould: "mold", pyjamas: "pajamas", plough: "plow", tyre: "tire", tyres: "tires",
};

/**
 * One word in a single spelling for comparing, so UK and US spellings are the same word ("customised" /
 * "customized", "colour" / "color", "centre" / "center", "travelling" / "traveling"). Only for comparing:
 * what the content shows is always reported as written. Real misspellings are still different words.
 */
function oneSpelling(word: string): string {
  if (Object.hasOwn(UK_US, word)) return UK_US[word];
  const our = OUR_WORDS.find((w) => word.startsWith(w));
  if (our) return `${our.slice(0, -2)}r${word.slice(our.length)}`;
  const re = RE_WORDS.find((w) => word === w || word === `${w}s`);
  if (re) return `${re.slice(0, -2)}er${word.slice(re.length)}`;
  const doubled = DOUBLE_L.find((w) => new RegExp(`^${w}l(?:ed|ing|er|ers)$`).test(word));
  if (doubled) return doubled + word.slice(doubled.length + 1);
  // -ise / -yse ("organise", "organisation", "analysed"): written with z in US English.
  return word.replace(/^(\p{L}{2,}[iy])s(e|es|ed|ing|ation|ations|er|ers)$/u, "$1z$2");
}

/** normalizeWords text with every word in one spelling (oneSpelling). */
const oneSpellingWords = (normalised: string) => normalised.split(" ").map(oneSpelling).join(" ");

export function textMatches(expected: string, detected: string): boolean {
  const a = normalizeWords(expected);
  return a.length > 0 && oneSpellingWords(a) === oneSpellingWords(normalizeWords(detected));
}

/**
 * Text with words broken across lines put back together (Stage 3, A4): a hyphen at the end of a line followed
 * by a lower-case letter on the next ("condi-" / "tions" → "conditions"), and soft hyphens (U+00AD). A capital
 * after the break ("Dubai-" / "Abu Dhabi") is a real hyphenated pair and is left as it is. Only used as an
 * extra reading of the text — the text as written is always checked too, so "state-of-the-" / "art" still
 * reads "state of the art".
 */
export function joinHyphenatedLines(text: string): string {
  return text.replace(/(\p{L})[-\u2010\u2011\u00AD][ \t]*\r?\n[ \t]*(?=\p{Ll})/gu, "$1").replace(/\u00AD/g, "");
}

/** Is `needle` present in `haystack` as whole words (case, punctuation, spacing and UK / US spelling ignored)? */
export function containsText(haystack: string, needle: string): boolean {
  const n = normalizeWords(needle);
  return n.length > 0 && ` ${oneSpellingWords(normalizeWords(haystack))} `.includes(` ${oneSpellingWords(n)} `);
}

type Word = { key: string; raw: string; start: number; end: number };

/**
 * The words of already-normalised text, with where each one is (same word rules as normalizeWords: "&"
 * is the word "and", Arabic folded). `raw` keeps the capitals, for the capitals check.
 */
function wordsOf(value: string): Word[] {
  const out: Word[] = [];
  for (const m of value.matchAll(/[\p{L}\p{M}\p{N}%‘’ʼ']+|&/gu)) {
    const raw = m[0] === "&" ? "&" : withoutStrayMarks(foldArabic(asciiNumbers(m[0]))).replace(/[‘’ʼ']/g, "");
    if (raw) out.push({ key: raw === "&" ? "and" : raw.toLowerCase(), raw, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Where a word has capitals: its first letter, and any after it ("Customised" and "Customized" alike). */
const capitalsOf = (raw: string) => [raw[0] !== raw[0].toLowerCase(), raw.slice(1) !== raw.slice(1).toLowerCase()].join();

/**
 * The same word as written, capitals included — "&" and "and" are the same word either way, and a UK / US
 * spelling of it counts as written when its capitals are the same.
 */
const sameAsWritten = (a: Word, b: Word) =>
  a.raw === b.raw || a.raw === "&" || b.raw === "&" || (a.key !== b.key && capitalsOf(a.raw) === capitalsOf(b.raw));

/**
 * For wording that must be copied exactly: when `needle` is in `haystack` with
 * the same words but different capitals ("T&C Apply" for "T&C apply"), what the
 * content shows. Null when an exact copy is there, when it isn't there at all,
 * when it's set in ALL CAPITALS (a styling choice), or when only its very first
 * letter differs (the start of a line).
 */
export function capitalizationDifference(haystack: string, needle: string): string | null {
  const want = wordsOf(needle.normalize("NFKC"));
  const text = haystack.normalize("NFKC");
  const found = wordsOf(text);
  if (!want.length) return null;
  let different: string | null = null;
  for (let i = 0; i + want.length <= found.length; i++) {
    const span = found.slice(i, i + want.length);
    if (!span.every((w, j) => oneSpelling(w.key) === oneSpelling(want[j].key))) continue;
    // The same (perhaps bar the very first letter, the start of a line).
    if (span.every((w, j) => sameAsWritten(w, want[j]) || (j === 0 && w.raw.slice(1) === want[j].raw.slice(1)))) return null;
    const letters = span
      .filter((w) => w.raw !== "&")
      .map((w) => w.raw)
      .join("")
      .replace(/[^\p{L}]/gu, "");
    if (letters.toUpperCase() === letters) continue; // ALL CAPS styling
    different ??= text.slice(span[0].start, span[span.length - 1].end);
  }
  return different;
}

/** One place a word sequence appears (wordSequenceMatches). */
export type WordSequenceMatch = {
  text: string;
  start: number;
  end: number;
  /** The word just before it (normalised), or null at the start. */
  previousWord: string | null;
  /** Whether punctuation stands between that word and the match ("لا، تطبق…"): then it isn't part of the same phrase. */
  separatedFromPrevious: boolean;
  after: string;
};

/**
 * Every place `needle`'s words appear in `haystack` as a complete, consecutive run of whole words — the same
 * word rules as containsText (case, punctuation, spacing, Arabic vowel marks and alef forms, UK / US
 * spelling, "&" = "and" ignored). Each with the text as written (of the NFKC form), the word just before it
 * (normalised, or null at the start) and the text after it. Never a part of a word.
 */
export function wordSequenceMatches(haystack: string, needle: string): WordSequenceMatch[] {
  const want = wordsOf(needle.normalize("NFKC")).map((w) => oneSpelling(w.key));
  const text = haystack.normalize("NFKC");
  const found = wordsOf(text);
  if (!want.length) return [];
  const out: WordSequenceMatch[] = [];
  for (let i = 0; i + want.length <= found.length; i++) {
    if (!want.every((key, j) => oneSpelling(found[i + j].key) === key)) continue;
    const start = found[i].start;
    const end = found[i + want.length - 1].end;
    const between = i > 0 ? text.slice(found[i - 1].end, start) : "";
    out.push({
      text: text.slice(start, end),
      start,
      end,
      previousWord: i > 0 ? oneSpelling(found[i - 1].key) : null,
      separatedFromPrevious: /[^\s]/u.test(between),
      after: text.slice(end),
    });
  }
  return out;
}

/**
 * An exact pixel size from a requirement: "1080 × 1080", "1080x1080 px",
 * "1080 by 1080 pixels". Null when there's no single size, or it's in
 * another unit (mm, cm, inches, points).
 */
export function parseExactSize(value: string): { width: number; height: number } | null {
  const text = value.normalize("NFKC");
  if (/\d\s*(?:mm|cm|in|inch|inches|pt|")(?![\p{L}])/iu.test(text)) return null;
  const sizes = [...text.matchAll(/(?<![\d.])(\d{2,5})\s*(?:px\s*)?(?:x|×|\*|by)\s*(\d{2,5})(?![\d.])/giu)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  const distinct = new Set(sizes.map((s) => `${s.width}x${s.height}`));
  return distinct.size === 1 ? sizes[0] : null;
}

/**
 * The exact pixel size a Dimensions requirement gives: as parseExactSize, and
 * also when the "×" was lost on the way ("1080  1080 px" — an AI copying the
 * brief can drop the symbol). That second form must be exactly two numbers and
 * at most a pixel unit — nothing else — so no other wording is read as a size.
 */
export function parseDimensions(value: string): { width: number; height: number } | null {
  const exact = parseExactSize(value);
  if (exact) return exact;
  const m = value.normalize("NFKC").trim().match(/^(\d{2,5})\s+(\d{2,5})\s*(?:px|pixels?)?$/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** A size written the one standard way: "1080 × 1080 px". */
export const sizeText = (size: { width: number; height: number }) => `${size.width} × ${size.height} px`;

/**
 * The one exact pixel size a brief gives, read from its own text (no AI) —
 * e.g. "Dimensions 1080 × 1080 px". Only on a line that is clearly about size
 * (it says dimension(s), size, resolution, px / pixels, or uses "×"), and only
 * when the brief gives exactly one such size; several sizes, or sizes in mm /
 * inches, are left for the designer and the platform choice.
 */
export function findExactSize(text: string): { width: number; height: number } | null {
  const found = new Map<string, { width: number; height: number }>();
  for (const line of text.normalize("NFKC").split(/\r?\n/)) {
    if (!/dimension|size|resolution|px|pixel|×/i.test(line)) continue;
    const size = parseExactSize(line);
    if (size) found.set(`${size.width}x${size.height}`, size);
    else if ([...line.matchAll(/(?<![\d.])\d{2,5}\s*(?:px\s*)?(?:x|×|\*|by)\s*\d{2,5}(?![\d.])/giu)].length > 0) return null; // several on one line, or another unit
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** Damerau–Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How many letter changes still count as "the same name, misspelt". Short names must be exact. */
export function allowedEdits(length: number): number {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

export type NameCheck =
  | { status: "exact" }
  | { status: "misspelt"; found: string }
  /** The same name with different numbers ("iPhone 15" for "iPhone 16"): a different value, not a misspelling. */
  | { status: "different"; found: string }
  | { status: "absent" };

/** "Skybook Villas's" / "Skybook Villas’" → "Skybook Villas": a possessive is the name itself, not a misspelling. */
const withoutPossessives = (text: string) =>
  text.replace(/(\p{L})['’ʼ]s(?![\p{L}\p{N}])/gu, "$1").replace(/(\p{L}s)['’ʼ](?![\p{L}\p{N}])/gu, "$1");

/** The numbers in a normalised name, in order ("iphone 16 pro" → "16"). */
const numbersIn = (normalised: string) => (normalised.match(/\d+(?:[.,]\d+)?/g) ?? []).join(" ");

/**
 * Looks for a name (company, product, approved term) in text: exactly, or as
 * a close misspelling ("Skybok", "Sky Book", "Skyobok"). Comparing letters
 * only, so spacing and punctuation differences count as misspellings too.
 */
export function findName(text: string, name: string): NameCheck {
  if (containsText(text, name) || containsText(withoutPossessives(text), name)) return { status: "exact" };
  const target = normalizeWords(name);
  const compact = oneSpellingWords(target).replace(/ /g, "");
  if (!compact) return { status: "absent" };
  const words = normalizeWords(text).split(" ").filter(Boolean);
  const n = target.split(" ").length;
  const limit = allowedEdits(compact.length);
  let best: { found: string; distance: number } | null = null;
  for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const window = words.slice(i, i + size).join(" ");
      const distance = editDistance(oneSpellingWords(window).replace(/ /g, ""), compact);
      if (distance <= limit && (!best || distance < best.distance)) best = { found: window, distance };
    }
  }
  if (!best) return { status: "absent" };
  // Close in letters but with other numbers: another model, size or year — a wrong value, not a typo.
  return numbersIn(best.found) !== numbersIn(target) ? { status: "different", found: best.found } : { status: "misspelt", found: best.found };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

type Phone = { digits: string; international: boolean };

function parsePhone(value: string): Phone | null {
  // Arabic-Indic / Eastern Arabic digits count as the same digits (asciiNumbers).
  const trimmed = asciiNumbers(value).trim();
  // "971+ 4 123 4567": "+971 4 123 4567" read from right-to-left text (findPhones only returns this form
  // when the context confirms it — see rtlInternationalPhones).
  const rtlCode = /^(\d{2,3})\+[\s\u200E\u200F\u061C]/.exec(trimmed)?.[1];
  const international = /^(\+|00)/.test(trimmed) || (rtlCode !== undefined && (RTL_CODES_ALONE.has(rtlCode) || RTL_CODES_WITH_WORD.has(rtlCode)));
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;
  return { digits, international };
}

export type PhoneMatch = "match" | "match_without_country_code" | "mismatch";

/**
 * Same phone number? Formatting is ignored. A local form ("04 123 4567")
 * matches the international one ("+971 4 123 4567") but says so; two
 * numbers both written with a country code must be identical.
 */
export function phonesMatch(expected: string, detected: string): PhoneMatch {
  const a = parsePhone(expected);
  const b = parsePhone(detected);
  if (!a || !b) return "mismatch";
  if (a.digits === b.digits) return "match";
  if (a.international && b.international) return "mismatch";
  const [full, local] = a.international ? [a, b] : b.international ? [b, a] : a.digits.length >= b.digits.length ? [a, b] : [b, a];
  const national = local.digits.replace(/^0+/, "");
  return national.length >= 7 && full.digits.endsWith(national) ? "match_without_country_code" : "mismatch";
}

const DATE_LIKE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;

/** "2025 - 2026", "2025/2026": a span of years, not a phone number. */
const YEAR_RANGE = /^(19|20)\d{2}\s*[-/]\s*(19|20)\d{2}$/;

/**
 * The spaces that \s stands for, without the line breaks (\n \r \v \f U+2028 U+2029): a phone number
 * never runs on to the next line - in a numbered brief, "+971 4 123 4567" followed by "2. Event date" is
 * not "+971 4 123 4567 2".
 */
const SAME_LINE_SPACE = String.raw`\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF`;
/** A phone-number-like run on one line (findPhones): digits, spaces, dashes, dots, brackets, direction marks. */
const PHONE_RUN = new RegExp(String.raw`(?:\+|00)?\(?\d[\d${SAME_LINE_SPACE}().\u200E\u200F\u061C-]{5,}\d`, "g");

/**
 * Phone-number-like runs of 7–15 digits (spaces, dashes, dots, brackets allowed) — in Western, Arabic-Indic
 * (٠–٩) or Eastern Arabic (۰–۹) digits, with the invisible direction marks Arabic text can carry inside a
 * number (U+200E, U+200F, U+061C). Each is returned exactly as written in the text.
 */
export function findPhones(text: string): string[] {
  const found = rtlInternationalPhones(text);
  const inRtl = (at: number) => found.some((p) => at >= p.start && at < p.end);
  // asciiNumbers swaps one character for one, so a match's position is the same in the original text.
  for (const match of asciiNumbers(text).matchAll(PHONE_RUN)) {
    if (inRtl(match.index)) continue; // already part of a right-to-left international number
    const ascii = match[0].trim().replace(/[\u200E\u200F\u061C]/g, "");
    const digits = ascii.replace(/\D/g, "").length;
    if (digits < 7 || digits > 15 || DATE_LIKE.test(ascii) || YEAR_RANGE.test(ascii)) continue;
    const start = match.index + (match[0].length - match[0].trimStart().length);
    found.push({ start, end: start + match[0].trim().length, text: text.slice(match.index, match.index + match[0].length).trim() });
  }
  return found.sort((a, b) => a.start - b.start).map((p) => p.text);
}

/**
 * Country codes a right-to-left "+" may follow ("971+" for "+971"): Arabic- and Persian-speaking countries.
 * The three-digit ones are enough on their own; the two-digit ones (Egypt 20, Iran 98) also need a phone word
 * on the line, because "20+" and "98+" are just as often counts or prices.
 */
const RTL_CODES_ALONE = new Set(["212", "213", "216", "218", "249", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "973", "974"]);
const RTL_CODES_WITH_WORD = new Set(["20", "98"]);
const PHONE_WORD = /(?:هاتف|تلفون|تليفون|اتصل|اتصال|للحجز|للاستفسار|للتواصل|جوال|موبايل|واتساب|واتس|تلفن|تماس|شماره|موبایل)|\b(?:tel|phone|call|whatsapp|mobile)\b/iu;
/** Arabic-script letters or digits (Arabic, Persian, Urdu…): the line is written right to left. */
const RTL_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * "+971 4 123 4567" as right-to-left text often comes out: "٩٧١+ ٤ ١٢٣ ٤٥٦٧" — the "+" after the country
 * code. Taken as the international number only when everything says it's a phone number:
 *  - a known country code of 2–3 digits, not part of a longer number or sum ("5+971", "+971+", "5 + 971+");
 *  - then the "+", a space, and a national number of 7–12 digits (not a date or a span of years);
 *  - the number's own line is in Arabic script (letters or digits), and the number stays on that line;
 *  - no percent, currency or "+" straight after it;
 *  - for the two-digit codes, a phone word on that line too.
 * Returned exactly as written; parsePhone reads it as international.
 */
function rtlInternationalPhones(text: string): { start: number; end: number; text: string }[] {
  if (!RTL_SCRIPT.test(text)) return [];
  const ascii = asciiNumbers(text);
  const after = new RegExp(String.raw`^[ \t\u200E\u200F\u061C]*(?:[%+\u2030]|(?:${CURRENCY_PATTERN})(?![\p{L}]))`, "iu");
  // The line the number starts on (a design's text is often several lines joined).
  const lineOf = (at: number) => text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at) === -1 ? undefined : text.indexOf("\n", at));
  const out: { start: number; end: number; text: string }[] = [];
  // Not part of a longer number or a sum: no digit or sign straight before the code, and no arithmetic sign
  // before it with only spaces between ("٥ + ٩٧١+ …"). "-" and "/" with spaces are left alone: they separate
  // two phone numbers ("… / ٩٧١+ ٥٠ …").
  for (const m of ascii.matchAll(/(?<![\d+\-*/\u00D7\u00F7=.,])(?<![+*\u00D7\u00F7=][ \t\u200E\u200F\u061C]+)(\d{2,3})\+[ \t\u200E\u200F\u061C]+(\d[\d \t().\u200E\u200F\u061C-]{5,}\d)/g)) {
    const code = m[1];
    const line = lineOf(m.index);
    if (!RTL_SCRIPT.test(line)) continue;
    if (!RTL_CODES_ALONE.has(code) && !(RTL_CODES_WITH_WORD.has(code) && PHONE_WORD.test(line))) continue;
    const national = m[2].replace(/[\u200E\u200F\u061C]/g, "").trim();
    const digits = national.replace(/\D/g, "").length;
    if (digits < 7 || digits > 12 || DATE_LIKE.test(national) || YEAR_RANGE.test(national)) continue;
    const end = m.index + m[0].length;
    if (after.test(ascii.slice(end))) continue;
    out.push({ start: m.index, end, text: text.slice(m.index, end) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Email and website
// ---------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function findEmails(text: string): string[] {
  return [...text.matchAll(EMAIL)].map((m) => m[0]);
}

export function emailsMatch(expected: string, detected: string): boolean {
  const clean = (v: string) => v.trim().toLowerCase().replace(/^mailto:/, "");
  return clean(expected) === clean(detected) && clean(expected).includes("@");
}

/** host + path, lower-case, without scheme, "www." or trailing slash. */
export function normalizeWebsite(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

export function websitesMatch(expected: string, detected: string): boolean {
  const a = normalizeWebsite(expected);
  return a.length > 0 && a === normalizeWebsite(detected);
}

/**
 * Domain endings accepted WITHOUT "https://" or "www." — so "St.Regis" or
 * "Dubai.Today" in a sentence isn't taken for a website. A website written
 * with a scheme or "www." is accepted with any ending.
 */
const BARE_DOMAIN_ENDINGS = new Set([
  "com", "net", "org", "info", "biz", "co", "io", "me", "app", "dev", "online", "site", "store", "shop", "travel",
  "ae", "sa", "qa", "kw", "bh", "om", "eg", "jo", "lb", "in", "pk", "uk", "us", "eu", "de", "fr", "it", "es", "nl", "ch", "au", "ca",
]);

export function findWebsites(text: string): string[] {
  const withoutEmails = text.replace(EMAIL, " ");
  return [
    ...withoutEmails.matchAll(/\b(https?:\/\/)?(www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,})(?:\/[^\s]*)?/gi),
  ]
    .filter((m) => m[1] || m[2] || BARE_DOMAIN_ENDINGS.has(m[3].toLowerCase()))
    .map((m) => m[0].replace(/[.,;:!?)]+$/, ""));
}

// ---------------------------------------------------------------------------
// Price and percentage
// ---------------------------------------------------------------------------

/**
 * Currencies as written, most specific first. Each entry: the token (a whole word, matched ignoring case),
 * the currency it stands for. Stage 3 (A3) added the full English and Arabic names ("Saudi riyals",
 * "ريال سعودي", "دينار كويتي", "dollars", "يورو"…), "Dhs." / "Dh." with a dot, and the Gulf abbreviations
 * SR, QR, KD, BD and RO (capitals only — see CAPITALS_ONLY).
 *
 * A bare "riyal" / "ريال" is Saudi, Qatari or Omani, and a bare "dinar" / "دينار" Kuwaiti or Bahraini: they
 * stand for a currency FAMILY (RIYAL, DINAR) that matches any of its members (sameCurrency) — never AED,
 * USD or another family.
 */
const CURRENCY_TOKENS: [string, string][] = [
  // Full names (several words) first.
  [String.raw`ريال(?:ات)?\s+سعودي(?:ة)?|saudi\s+riyals?`, "SAR"],
  [String.raw`ريال(?:ات)?\s+قطري(?:ة)?|qatari\s+riyals?`, "QAR"],
  [String.raw`ريال(?:ات)?\s+عماني(?:ة)?|omani\s+rials?`, "OMR"],
  [String.raw`(?:دينار|دنانير)\s+كويتي(?:ة)?|kuwaiti\s+dinars?`, "KWD"],
  [String.raw`(?:دينار|دنانير)\s+بحريني(?:ة)?|bahraini\s+dinars?`, "BHD"],
  [String.raw`(?:درهم|دراهم)\s+[اإ]ماراتي(?:ة)?|uae\s+dirhams?`, "AED"],
  [String.raw`جنيه(?:ات)?\s+مصري(?:ة)?|egyptian\s+pounds?`, "EGP"],
  [String.raw`us\s+dollars?|دولار(?:ات)?\s+[اأ]مريكي(?:ة)?`, "USD"],
  // Symbols, codes and single words.
  [String.raw`us\$|\$|usd|dollars?|دولار(?:ات|اً|ا)?`, "USD"],
  [String.raw`€|eur|euros?|يورو`, "EUR"],
  [String.raw`£|gbp`, "GBP"],
  [String.raw`aed|dhs?\.?|dirhams?|د\.إ|درهم|دراهم`, "AED"],
  [String.raw`sar|﷼|ر\.س|SR`, "SAR"],
  [String.raw`qar|ر\.ق|QR`, "QAR"],
  [String.raw`kwd|د\.ك|KD`, "KWD"],
  [String.raw`bhd|د\.ب|BD`, "BHD"],
  [String.raw`omr|ر\.ع|RO`, "OMR"],
  // Not "ريال مدريد" (Real Madrid).
  [String.raw`ريال(?:ات|اً|ا)?(?!\s+مدريد)|riyals?|rials?`, "RIYAL"],
  [String.raw`دينار(?:اً|ا)?|دنانير|dinars?`, "DINAR"],
  [String.raw`₹|inr|rs\.?`, "INR"],
  [String.raw`pkr`, "PKR"],
  [String.raw`egp|ج\.م|جنيه(?:ات)?`, "EGP"],
];
/** Two-letter Gulf abbreviations count only in capitals ("SR 99"): "Sr. 5", "ro 3" or "kd" are not currencies. */
const CAPITALS_ONLY = new Set(["SR", "QR", "KD", "BD", "RO"]);
const CURRENCY_PATTERN = `(?:${CURRENCY_TOKENS.map(([token]) => token).join("|")})`;
/** A currency family ("ريال" alone) and the currencies it can be. */
const CURRENCY_FAMILIES: Record<string, readonly string[]> = { RIYAL: ["SAR", "QAR", "OMR"], DINAR: ["KWD", "BHD"] };
/** The same currency — or a family and one of its members ("ريال" and SAR). Two different families never are. */
function sameCurrency(a: string, b: string): boolean {
  return a === b || Boolean(CURRENCY_FAMILIES[a]?.includes(b)) || Boolean(CURRENCY_FAMILIES[b]?.includes(a));
}
/**
 * An amount as written: "1,299" / "1,299.50" (comma thousands), "1.299" / "1.299,50" (dot thousands, as in
 * much of Europe), or a plain "1299" / "12.50" / "12,50". Which one it is is decided by amountOf.
 */
const AMOUNT_PATTERN = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,3})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,3})?`;

/**
 * Currencies with three decimals (1 dinar / rial = 1,000 fils / baisa): "KWD 1.299" is 1.299, not 1,299. A bare
 * "dinar" is Kuwaiti or Bahraini — both three decimals; a bare "riyal" is usually Saudi or Qatari (two).
 */
const THREE_DECIMALS = new Set(["KWD", "BHD", "OMR", "DINAR"]);

/** The number an amount stands for, given its currency (see AMOUNT_PATTERN). */
function amountOf(raw: string, currency: string | undefined): number {
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return Number(raw.replace(/,/g, ""));
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)) {
    if (currency && THREE_DECIMALS.has(currency) && /^\d+\.\d{3}$/.test(raw)) return Number(raw);
    return Number(raw.replace(/\./g, "").replace(",", "."));
  }
  return Number(raw.replace(",", "."));
}

function currencyOf(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const written = token.trim();
  return CURRENCY_TOKENS.find(([pattern]) => new RegExp(`^(?:${pattern})$`, "iu").test(written))?.[1];
}

export type Price = { amount: number; currency?: string; text: string };

/** Prices in text, with where each one is (see findPrices). */
function priceMatches(text: string): (Price & { index: number })[] {
  // A currency word is a word of its own ("Doors 7" isn't "Rs 7"), and an amount isn't the end of a longer number.
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${CURRENCY_PATTERN})\s?(${AMOUNT_PATTERN})(?![\p{N}])|(?<![\p{L}\p{N}.,])(${AMOUNT_PATTERN})\s?(${CURRENCY_PATTERN})(?![\p{L}])`,
    "giu"
  );
  // Read with Western digits; the positions are the same in the original, so its own text is shown.
  return [...asciiNumbers(text).matchAll(pattern)]
    .filter((m) => {
      const token = (m[1] ?? m[4]).trim();
      return !CAPITALS_ONLY.has(token.toUpperCase()) || token === token.toUpperCase();
    })
    .map((m) => {
      const currency = currencyOf(m[1] ?? m[4]);
      return { amount: amountOf(m[2] ?? m[3], currency), currency, text: text.slice(m.index, m.index + m[0].length), index: m.index };
    });
}

/** Amounts written next to a currency ("AED 1,299", "$49.99", "99 dirhams", "١٬٢٩٩ درهم"). */
export function findPrices(text: string): Price[] {
  return priceMatches(text).map(({ amount, currency, text: shown }) => ({ amount, currency, text: shown }));
}

/**
 * A price shown as the OLD price next to the new one — "Was AED 1,500", "instead of AED 1,500",
 * "بدلاً من ١٬٥٠٠ درهم": the word right before it says so. Used so an offer's old price isn't taken for
 * a stray price; anything not introduced this way is still checked.
 */
const OLD_PRICE_WORDS = /(?:\b(?:was|before|originally|instead of|regular(?:ly)?|usual(?:ly)?|normally|rrp|old|previously)(?:\s+price)?|بدلاً من|بدلا من|كان|سابقاً|سابقا|السعر الأصلي)[\s:–-]*$/iu;
export function oldPrices(text: string): Price[] {
  return priceMatches(text)
    .filter((p) => OLD_PRICE_WORDS.test(text.slice(Math.max(0, p.index - 30), p.index)))
    .map(({ amount, currency, text: shown }) => ({ amount, currency, text: shown }));
}

/** A typed price requirement ("AED 1,299" or just "1299"). */
export function parsePrice(value: string): Price | null {
  const [withCurrency] = findPrices(value);
  if (withCurrency) return withCurrency;
  const bare = new RegExp(String.raw`^\s*(${AMOUNT_PATTERN})\s*$`).exec(asciiNumbers(value));
  return bare ? { amount: amountOf(bare[1], undefined), text: value.trim() } : null;
}

export type PriceMatch = "match" | "currency_missing" | "mismatch";

export function pricesMatch(expected: Price, detected: Price): PriceMatch {
  if (Math.abs(expected.amount - detected.amount) > 0.001) return "mismatch";
  if (expected.currency && detected.currency && !sameCurrency(expected.currency, detected.currency)) return "mismatch";
  if (expected.currency && !detected.currency) return "currency_missing";
  return "match";
}

export function findPercentages(text: string): number[] {
  return [...asciiNumbers(text).matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi)].map((m) => Number(m[1]));
}

export function parsePercentage(value: string): number | null {
  const [found] = findPercentages(value);
  if (found !== undefined) return found;
  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(asciiNumbers(value));
  return bare ? Number(bare[1]) : null;
}

// ---------------------------------------------------------------------------
// Date and time
// ---------------------------------------------------------------------------

/** A date's reading. `text`: how it was written — set for Arabic month-name dates, so findings show them as written. */
export type DateValue = { day: number; month: number; year?: number; text?: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const monthOf = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: string | undefined) => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));
const valid = (d: DateValue) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31;

/**
 * Arabic month names (Stage 3, A2): the Gulf / Egyptian forms of the Gregorian months (يناير … ديسمبر) and
 * the Levantine ones (كانون الثاني … كانون الأول), with the usual spelling variants — any alef form (أ إ آ ا),
 * يونيو / يونيه, يوليو / يوليه, "تشرين الأول" or "تشرين أول".
 */
const AR_ALEF = "[اأإآ]";
const AR_MONTHS: [string, number][] = [
  [String.raw`يناير|كانون\s+(?:ال)?ثاني`, 1],
  [String.raw`فبراير|شباط`, 2],
  [String.raw`مارس|${AR_ALEF}ذار`, 3],
  [String.raw`${AR_ALEF}بريل|نيسان`, 4],
  [String.raw`مايو|${AR_ALEF}يار`, 5],
  [String.raw`يوني[وه]|حزيران`, 6],
  [String.raw`يولي[وه]|تموز`, 7],
  [String.raw`${AR_ALEF}غسطس|[آا]ب`, 8],
  [String.raw`سبتمبر|${AR_ALEF}يلول`, 9],
  [String.raw`${AR_ALEF}كتوبر|تشرين\s+(?:ال)?${AR_ALEF}ول`, 10],
  [String.raw`نوفمبر|تشرين\s+(?:ال)?ثاني`, 11],
  [String.raw`ديسمبر|كانون\s+(?:ال)?${AR_ALEF}ول`, 12],
];
const AR_MONTH_NAME = AR_MONTHS.map(([pattern]) => `(?:${pattern})`).join("|");
const arabicMonthOf = (name: string) => AR_MONTHS.find(([pattern]) => new RegExp(`^(?:${pattern})$`, "u").test(name.trim()))?.[1] ?? 0;
/**
 * "٣١ ديسمبر ٢٠٢٦", "31 ديسمبر 2026م", "١٥ من شهر أيار، عام ٢٠٢٦", "١ كانون الثاني (يناير) ٢٠٢٦" — a day (1–2
 * digits, not part of a longer number, time or price), an optional "من" / "شهر", the month (optionally
 * followed by its other name in brackets or after a slash), and an optional year (4 digits, optionally
 * after "،", "عام" / "سنة", and with a trailing "م"). The month must be a whole word: "مايونيز" and "آبار"
 * aren't months. Run on asciiNumbers text (Arabic-Indic digits become 0–9, one character for one).
 */
const ARABIC_DATE = new RegExp(
  String.raw`(?<![\d.,:/-])(\d{1,2})\s*(?:من\s+)?(?:شهر\s+)?(${AR_MONTH_NAME})(?!\p{L})(?:\s*[(/]\s*(?:${AR_MONTH_NAME})(?!\p{L})\s*\)?)?(?:\s*[،,]?\s*(?:(?:عام|سنة|لعام|لسنة)\s+)?(\d{4})(?!\d)(?:\s*م(?!\p{L}))?)?`,
  "gu"
);

/**
 * Dates in text. Each mention gives every reading it could have: "03/04/2026"
 * is both 3 April and 4 March, so it matches either — never silently one.
 */
export function findDates(text: string, options: { withoutYear?: boolean } = {}): DateValue[][] {
  const mentions: DateValue[][] = [];
  const t = asciiNumbers(text).toLowerCase();
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    mentions.push([{ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }].filter(valid));
  }
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = fullYear(m[3]);
    const readings = [{ day: a, month: b, year }, { day: b, month: a, year }].filter(valid);
    mentions.push(a === b ? readings.slice(0, 1) : readings);
  }
  const dayFirst = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}(?:,?\s+(\d{4}))?\b`, "g");
  for (const m of t.matchAll(dayFirst)) mentions.push([{ day: Number(m[1]), month: monthOf(m[2]), year: fullYear(m[3]) }].filter(valid));
  const monthFirst = new RegExp(String.raw`\b${MONTH_WORD}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "g");
  for (const m of t.matchAll(monthFirst)) mentions.push([{ day: Number(m[2]), month: monthOf(m[1]), year: fullYear(m[3]) }].filter(valid));
  // Arabic month names, kept as written (asciiNumbers is one character for one, so the index is the same).
  for (const m of asciiNumbers(text).matchAll(ARABIC_DATE)) {
    const written = text.slice(m.index, m.index + m[0].length).trim();
    mentions.push([{ day: Number(m[1]), month: arabicMonthOf(m[2]), year: fullYear(m[3]), text: written }].filter(valid));
  }
  // "18/10" with no year, only when asked: it can be read as a date to MATCH a brief's date, but "24/7"
  // or "3/4" must never be taken for an unexpected date. Not with "." — "12.50" is a price.
  if (options.withoutYear) {
    for (const m of t.matchAll(/(?<![\d/.-])(\d{1,2})[/-](\d{1,2})(?![\d/.-])/g)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const readings = [{ day: a, month: b }, { day: b, month: a }].filter(valid);
      mentions.push(a === b ? readings.slice(0, 1) : readings);
    }
  }
  return mentions.filter((readings) => readings.length > 0);
}

/**
 * Dates in text written one way — day/month/year, no leading zeros — so wording that gives a date can be
 * compared by its words: "31 Dec 2026", "31st December 2026", "December 31, 2026", "2026-12-31" and
 * "31/12/2026" all read "31/12/2026"; "31 Dec" reads "31/12". A numeric date is written day first when
 * that's certain (one number over 12: "12/31/2026" → "31/12/2026"); when it isn't ("03/04/2026") its numbers
 * stay in the order written. Only for comparing wording — values are still compared with findDates.
 */
export function datesWrittenOneWay(text: string): string {
  const write = (day: number, month: number, year?: number) => `${day}/${month}${year !== undefined ? `/${year}` : ""}`;
  return asciiNumbers(text)
    .replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (all, y, m, d) => (valid({ day: +d, month: +m }) ? write(+d, +m, +y) : all))
    .replace(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g, (all, a, b, y) => {
      const [first, second] = [Number(a), Number(b)];
      const [day, month] = first <= 12 && second > 12 ? [second, first] : [first, second];
      return valid({ day, month }) ? write(day, month, fullYear(y)) : all;
    })
    .replace(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}(?:,?\s+(\d{4}))?\b`, "gi"), (all, d, m, y) =>
      valid({ day: +d, month: monthOf(m) }) ? write(+d, monthOf(m), fullYear(y)) : all
    )
    .replace(new RegExp(String.raw`\b${MONTH_WORD}\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, "gi"), (all, m, d, y) =>
      valid({ day: +d, month: monthOf(m) }) ? write(+d, monthOf(m), fullYear(y)) : all
    )
    .replace(ARABIC_DATE, (all, d, m, y) => (valid({ day: +d, month: arabicMonthOf(m) }) ? write(+d, arabicMonthOf(m), fullYear(y)) : all));
}

/** Same date? A missing year on either side matches any year. */
export function datesMatch(expected: DateValue[], detected: DateValue[]): boolean {
  return expected.some((a) =>
    detected.some((b) => a.day === b.day && a.month === b.month && (a.year === undefined || b.year === undefined || a.year === b.year))
  );
}

/** Times as minutes after midnight: "7 PM", "7:30pm", "19:00", "7.30 a.m." — never part of a price ("AED 12.50"). */
export function findTimes(text: string): number[] {
  const times: number[] = [];
  const prices = priceMatches(text).map((p) => [p.index, p.index + p.text.length]);
  const inPrice = (start: number, end: number) => prices.some(([a, b]) => start < b && a < end);
  for (const m of asciiNumbers(text).toLowerCase().matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|\b(\d{1,2})[:.](\d{2})\b(?!\s?[ap]\.?m)/g)) {
    if (inPrice(m.index, m.index + m[0].length)) continue;
    if (m[3]) {
      let hour = Number(m[1]) % 12;
      if (m[3].startsWith("p")) hour += 12;
      if (Number(m[1]) > 12) continue;
      times.push(hour * 60 + Number(m[2] ?? 0));
    } else {
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      if (hour <= 23 && minute <= 59) times.push(hour * 60 + minute);
    }
  }
  return times;
}

// ---------------------------------------------------------------------------
// CTA
// ---------------------------------------------------------------------------

/** Same call to action? Case, punctuation and arrows / emoji around it are ignored. */
export function ctaMatches(expected: string, detected: string): boolean {
  return textMatches(expected, detected);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export function parseHex(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x contrast ratio between two colours (1–21). */
export function contrastRatio(a: string, b: string): number | null {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return null;
  const lum = ([r, g, bl]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

function toLab(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linear);
  const xyz = [
    (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883,
  ].map((v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** CIE76 colour difference (ΔE). Under ~2 is hard to tell apart; over ~10 is clearly different. */
export function colorDifference(a: string, b: string): number | null {
  const x = toLab(a);
  const y = toLab(b);
  if (!x || !y) return null;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** How far a colour is from grey (its chroma); under NEUTRAL_CHROMA it counts as a neutral. */
export const NEUTRAL_CHROMA = 8;
export function chroma(hex: string): number | null {
  const lab = toLab(hex);
  return lab === null ? null : Math.hypot(lab[1], lab[2]);
}

/** Black, white and greys (very low colourfulness) — allowed alongside any palette. */
export function isNeutral(hex: string): boolean {
  const c = chroma(hex);
  return c !== null && c < NEUTRAL_CHROMA;
}

/** Fonts are the same family when their names match ignoring case, spaces and style words. */
export function sameFontFamily(a: string, b: string): boolean {
  const clean = (v: string) =>
    v
      .toLowerCase()
      .replace(/\b(regular|bold|italic|light|medium|semibold|black|thin|extrabold|extralight)\b/g, "")
      .replace(/[^a-z0-9]/g, "");
  return clean(a).length > 0 && clean(a) === clean(b);
}
