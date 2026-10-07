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

/** Lower-case words: letters, digits and % only; quotes, dashes and punctuation become spaces. */
export function normalizeWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ']/g, "") // Skybook’s → skybooks
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim();
}

export function textMatches(expected: string, detected: string): boolean {
  const a = normalizeWords(expected);
  return a.length > 0 && a === normalizeWords(detected);
}

/** Is `needle` present in `haystack` as whole words (case, punctuation and spacing ignored)? */
export function containsText(haystack: string, needle: string): boolean {
  const n = normalizeWords(needle);
  return n.length > 0 && ` ${normalizeWords(haystack)} `.includes(` ${n} `);
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
  | { status: "absent" };

/**
 * Looks for a name (company, product, approved term) in text: exactly, or as
 * a close misspelling ("Skybok", "Sky Book", "Skyobok"). Comparing letters
 * only, so spacing and punctuation differences count as misspellings too.
 */
export function findName(text: string, name: string): NameCheck {
  if (containsText(text, name)) return { status: "exact" };
  const target = normalizeWords(name);
  const compact = target.replace(/ /g, "");
  if (!compact) return { status: "absent" };
  const words = normalizeWords(text).split(" ").filter(Boolean);
  const n = target.split(" ").length;
  const limit = allowedEdits(compact.length);
  let best: { found: string; distance: number } | null = null;
  for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const window = words.slice(i, i + size).join(" ");
      const distance = editDistance(window.replace(/ /g, ""), compact);
      if (distance <= limit && (!best || distance < best.distance)) best = { found: window, distance };
    }
  }
  return best ? { status: "misspelt", found: best.found } : { status: "absent" };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

type Phone = { digits: string; international: boolean };

function parsePhone(value: string): Phone | null {
  const trimmed = value.trim();
  const international = /^(\+|00)/.test(trimmed);
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

/** Phone-number-like runs of 7–15 digits (spaces, dashes, dots, brackets allowed). */
export function findPhones(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:\+|00)?\(?\d[\d\s().-]{5,}\d/g)) {
    const raw = match[0].trim();
    const digits = raw.replace(/\D/g, "").length;
    if (digits < 7 || digits > 15 || DATE_LIKE.test(raw) || YEAR_RANGE.test(raw)) continue;
    found.push(raw);
  }
  return found;
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

const CURRENCY_TOKENS: [RegExp, string][] = [
  [/^(us\$|\$|usd)$/i, "USD"],
  [/^(€|eur|euro|euros)$/i, "EUR"],
  [/^(£|gbp)$/i, "GBP"],
  [/^(aed|dhs?|dirhams?|د\.إ)$/i, "AED"],
  [/^(sar|﷼)$/i, "SAR"],
  [/^(qar)$/i, "QAR"],
  [/^(kwd)$/i, "KWD"],
  [/^(bhd)$/i, "BHD"],
  [/^(omr)$/i, "OMR"],
  [/^(₹|inr|rs\.?)$/i, "INR"],
  [/^(pkr)$/i, "PKR"],
  [/^(egp)$/i, "EGP"],
];
const CURRENCY_PATTERN = String.raw`(?:US\$|\$|€|£|₹|﷼|د\.إ|USD|EUR|GBP|AED|DHS?|dirhams?|euros?|SAR|QAR|KWD|BHD|OMR|INR|Rs\.?|PKR|EGP)`;
const AMOUNT_PATTERN = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;

function currencyOf(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return CURRENCY_TOKENS.find(([pattern]) => pattern.test(token.trim()))?.[1];
}

export type Price = { amount: number; currency?: string; text: string };

/** Amounts written next to a currency ("AED 1,299", "$49.99", "99 dirhams"). */
export function findPrices(text: string): Price[] {
  const pattern = new RegExp(
    String.raw`(${CURRENCY_PATTERN})\s?(${AMOUNT_PATTERN})|(${AMOUNT_PATTERN})\s?(${CURRENCY_PATTERN})(?![A-Za-z])`,
    "gi"
  );
  return [...text.matchAll(pattern)].map((m) => ({
    amount: Number((m[2] ?? m[3]).replace(/,/g, "")),
    currency: currencyOf(m[1] ?? m[4]),
    text: m[0],
  }));
}

/** A typed price requirement ("AED 1,299" or just "1299"). */
export function parsePrice(value: string): Price | null {
  const [withCurrency] = findPrices(value);
  if (withCurrency) return withCurrency;
  const bare = new RegExp(String.raw`^\s*(${AMOUNT_PATTERN})\s*$`).exec(value);
  return bare ? { amount: Number(bare[1].replace(/,/g, "")), text: value.trim() } : null;
}

export type PriceMatch = "match" | "currency_missing" | "mismatch";

export function pricesMatch(expected: Price, detected: Price): PriceMatch {
  if (Math.abs(expected.amount - detected.amount) > 0.001) return "mismatch";
  if (expected.currency && detected.currency && expected.currency !== detected.currency) return "mismatch";
  if (expected.currency && !detected.currency) return "currency_missing";
  return "match";
}

export function findPercentages(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi)].map((m) => Number(m[1]));
}

export function parsePercentage(value: string): number | null {
  const [found] = findPercentages(value);
  if (found !== undefined) return found;
  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  return bare ? Number(bare[1]) : null;
}

// ---------------------------------------------------------------------------
// Date and time
// ---------------------------------------------------------------------------

export type DateValue = { day: number; month: number; year?: number };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const monthOf = (word: string) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: string | undefined) => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));
const valid = (d: DateValue) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31;

/**
 * Dates in text. Each mention gives every reading it could have: "03/04/2026"
 * is both 3 April and 4 March, so it matches either — never silently one.
 */
export function findDates(text: string): DateValue[][] {
  const mentions: DateValue[][] = [];
  const t = text.toLowerCase();
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
  return mentions.filter((readings) => readings.length > 0);
}

/** Same date? A missing year on either side matches any year. */
export function datesMatch(expected: DateValue[], detected: DateValue[]): boolean {
  return expected.some((a) =>
    detected.some((b) => a.day === b.day && a.month === b.month && (a.year === undefined || b.year === undefined || a.year === b.year))
  );
}

/** Times as minutes after midnight: "7 PM", "7:30pm", "19:00", "7.30 a.m.". */
export function findTimes(text: string): number[] {
  const times: number[] = [];
  for (const m of text.toLowerCase().matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|\b(\d{1,2})[:.](\d{2})\b(?!\s?[ap]\.?m)/g)) {
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

/** Black, white and greys (very low colourfulness) — allowed alongside any palette. */
export function isNeutral(hex: string): boolean {
  const lab = toLab(hex);
  return lab !== null && Math.hypot(lab[1], lab[2]) < 8;
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
