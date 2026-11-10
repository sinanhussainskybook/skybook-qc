import {
  datesMatch,
  datesWrittenOneWay,
  findDates,
  findPrices,
  normalizeWords,
  parsePrice,
  pricesMatch,
  wordSequenceMatches,
  type DateValue,
  type Price,
} from "@/lib/qc/compare";
import type { QcContext } from "@/lib/qc/rules/context";

/**
 * Approved English ↔ Arabic equivalents for common calls to action and disclaimers (Stage 3, Track A5).
 *
 * A CONTROLLED list, reviewed and approved phrase by phrase (2026-11-10). Nothing outside it is ever treated
 * as equivalent: no AI translation, no guessing, no fuzzy or part-of-a-word matching. Each family lists its
 * approved English forms and its approved Arabic forms — gender, plural and Gulf "الحين" forms only where
 * they were approved for that phrase. Arabic is compared with the app's usual tolerance (vowel marks,
 * tatweel, alef forms: الآن = الان, تُطبّق = تطبق).
 *
 * How it's used (matchEquivalent):
 *   - only when the required wording IS one of these phrases, complete (a requirement that merely contains
 *     one is never matched this way);
 *   - only ACROSS languages — English required, an approved Arabic form shown, or the reverse; wording in the
 *     same language is compared exactly as before;
 *   - the shown form must appear as complete words, and not right after a negation (لا, غير, not…) — the
 *     approved negative phrases themselves ("non-refundable", "غير شاملة…") are whole patterns and work;
 *   - a date or price inside the phrase ({value}) is checked separately and must match.
 */

export type PhraseKind = "cta" | "legal";
export type PhraseLanguage = "en" | "ar";
export type PhraseFamily = {
  id: string;
  kind: PhraseKind;
  /** A date or a price that follows the phrase ({value} in its forms) and must match. */
  slot?: "date" | "price";
  en: readonly string[];
  ar: readonly string[];
};

const VALUE = "{value}";

export const PHRASE_FAMILIES: readonly PhraseFamily[] = [
  // ---- Calls to action ----------------------------------------------------------------------------------
  { id: "C1 book_now", kind: "cta", en: ["Book now"], ar: ["احجز الآن", "احجزوا الآن", "احجزي الآن", "احجز الحين"] },
  { id: "C2 reserve_now", kind: "cta", en: ["Reserve now"], ar: ["احجز الآن", "احجزوا الآن", "احجزي الآن", "احجز الحين"] },
  { id: "C3 shop_now", kind: "cta", en: ["Shop now"], ar: ["تسوّق الآن", "تسوقوا الآن", "تسوقي الآن", "تسوق الحين"] },
  { id: "C4 buy_now", kind: "cta", en: ["Buy now"], ar: ["اشترِ الآن", "اشتري الآن", "اشتروا الآن"] },
  { id: "C5 order_now", kind: "cta", en: ["Order now"], ar: ["اطلب الآن", "اطلبوا الآن", "اطلبي الآن", "اطلب الحين"] },
  { id: "C6 call_now", kind: "cta", en: ["Call now"], ar: ["اتصل الآن", "اتصلوا الآن", "اتصلي الآن", "اتصل الحين"] },
  { id: "C7 call_us_now", kind: "cta", en: ["Call us now"], ar: ["اتصل بنا الآن", "اتصلوا بنا الآن"] },
  // Decision 1: اتصل بنا is "Call us" only — never "Contact us".
  { id: "C7b call_us", kind: "cta", en: ["Call us"], ar: ["اتصل بنا"] },
  { id: "C8 contact_us", kind: "cta", en: ["Contact us", "Get in touch"], ar: ["تواصل معنا", "تواصلوا معنا"] },
  {
    id: "C9 whatsapp_us",
    kind: "cta",
    en: ["WhatsApp us"],
    ar: ["راسلنا على واتساب", "راسلنا على الواتساب", "تواصل معنا عبر واتساب", "تواصل معنا عبر الواتساب", "راسلونا على واتساب", "راسلونا على الواتساب"],
  },
  { id: "C10 learn_more", kind: "cta", en: ["Learn more"], ar: ["اعرف المزيد", "اعرفوا المزيد", "لمعرفة المزيد"] },
  // Decision 2: اكتشف المزيد is "Discover more" only — never "Learn more".
  { id: "C11 discover_more", kind: "cta", en: ["Discover more"], ar: ["اكتشف المزيد", "اكتشفوا المزيد"] },
  { id: "C12 read_more", kind: "cta", en: ["Read more"], ar: ["اقرأ المزيد"] },
  { id: "C13 register_now", kind: "cta", en: ["Register now", "Sign up now"], ar: ["سجّل الآن", "سجلوا الآن", "سجلي الآن"] },
  { id: "C14 subscribe_now", kind: "cta", en: ["Subscribe now"], ar: ["اشترك الآن", "اشتركوا الآن"] },
  { id: "C15 download_app", kind: "cta", en: ["Download the app"], ar: ["حمّل التطبيق", "نزّل التطبيق", "حمّلوا التطبيق"] },
  { id: "C16 get_offer", kind: "cta", en: ["Get the offer", "Claim the offer"], ar: ["احصل على العرض", "احصل على عرضك", "احصلوا على العرض"] },
  { id: "C17 enquire_now", kind: "cta", en: ["Enquire now"], ar: ["استفسر الآن", "استفسروا الآن"] },
  { id: "C18 apply_now", kind: "cta", en: ["Apply now"], ar: ["قدّم الآن", "قدم طلبك الآن", "قدموا الآن"] },
  { id: "C19 visit_us", kind: "cta", en: ["Visit us"], ar: ["زورونا", "تفضلوا بزيارتنا"] },
  { id: "C20 visit_website", kind: "cta", en: ["Visit our website"], ar: ["زوروا موقعنا الإلكتروني", "تفضلوا بزيارة موقعنا", "زوروا موقعنا"] },
  { id: "C21 start_now", kind: "cta", en: ["Start now"], ar: ["ابدأ الآن", "ابدأوا الآن"] },

  // ---- Disclaimers and legal wording ----------------------------------------------------------------------
  { id: "D1 tc_apply", kind: "legal", en: ["Terms and conditions apply", "T&C apply", "T&Cs apply"], ar: ["تطبق الشروط والأحكام", "الشروط والأحكام تنطبق"] },
  // Shorter than D1 (no الأحكام): never accepted for D1 — "تطبق الشروط" isn't the whole of "تطبق الشروط والأحكام".
  { id: "D2 conditions_apply", kind: "legal", en: ["Conditions apply"], ar: ["تطبق الشروط"] },
  // Adjustment: نفاذ (a common spelling) is kept as a valid variation.
  { id: "D3 while_stocks_last", kind: "legal", en: ["While stocks last"], ar: ["حتى نفاد الكمية", "حتى نفاذ الكمية", "لحين نفاد الكمية", "ما دامت الكمية متوفرة"] },
  { id: "D4 limited_time", kind: "legal", en: ["Limited time offer"], ar: ["عرض لفترة محدودة", "عرض لمدة محدودة"] },
  // Decision 4: D5 ("Offer valid until") and D6 ("Offer ends") are one family; the date is always checked.
  {
    id: "D5/D6 offer_until",
    kind: "legal",
    slot: "date",
    en: [`Offer valid until ${VALUE}`, `Offer ends ${VALUE}`],
    ar: [`العرض ساري حتى ${VALUE}`, `العرض صالح حتى ${VALUE}`, `العرض ساري لغاية ${VALUE}`, `ينتهي العرض في ${VALUE}`, `ينتهي العرض بتاريخ ${VALUE}`],
  },
  // Adjustment: "شاملة الضريبة" is NOT accepted — it doesn't say which tax.
  { id: "D7 vat_included", kind: "legal", en: ["Prices include VAT"], ar: ["الأسعار شاملة ضريبة القيمة المضافة", "السعر شامل ضريبة القيمة المضافة"] },
  // "+ VAT" / "+ ضريبة القيمة المضافة" are left out: without the "+" (punctuation isn't a word) they'd read as "VAT"
  // alone, which also appears inside "Prices include VAT".
  { id: "D8 vat_excluded", kind: "legal", en: ["Prices exclude VAT"], ar: ["الأسعار غير شاملة ضريبة القيمة المضافة", "لا تشمل ضريبة القيمة المضافة"] },
  { id: "D9 availability", kind: "legal", en: ["Subject to availability"], ar: ["حسب التوفر", "رهناً بالتوفر", "بحسب التوافر", "يخضع للتوفر"] },
  { id: "D10 illustration", kind: "legal", en: ["Images are for illustration purposes only"], ar: ["الصور لأغراض توضيحية فقط", "الصور للتوضيح فقط"] },
  { id: "D11 prices_change", kind: "legal", en: ["Prices are subject to change"], ar: ["الأسعار قابلة للتغيير", "الأسعار عرضة للتغيير"] },
  {
    id: "D12 no_combining",
    kind: "legal",
    en: ["Cannot be combined with other offers"],
    ar: ["لا يمكن الجمع بين هذا العرض وأي عرض آخر", "لا يُجمع مع عروض أخرى", "لا يسري مع العروض الأخرى"],
  },
  { id: "D13 per_person", kind: "legal", en: ["Per person"], ar: ["للشخص الواحد", "للفرد", "للشخص"] },
  // Adjustment: both meanings are required — per person AND twin sharing. The sharing phrase alone is not enough.
  {
    id: "D14 per_person_twin",
    kind: "legal",
    en: ["Per person, twin sharing"],
    ar: ["للشخص الواحد", "للفرد", "للشخص"].flatMap((perPerson) =>
      ["على أساس غرفة مزدوجة", "على أساس المشاركة في غرفة مزدوجة"].map((sharing) => `${perPerson} ${sharing}`)
    ),
  },
  { id: "D15 starting_from", kind: "legal", slot: "price", en: [`Starting from ${VALUE}`, `From ${VALUE}`], ar: [`ابتداءً من ${VALUE}`, `يبدأ من ${VALUE}`, `تبدأ الأسعار من ${VALUE}`] },
  { id: "D16 non_refundable", kind: "legal", en: ["Non-refundable"], ar: ["غير قابل للاسترداد", "غير مسترد"] },
];

/**
 * Words that, right before an approved form, turn it into its opposite ("لا تطبق الشروط والأحكام"). Only the
 * word immediately before counts — never a window of words — and not when punctuation separates it
 * ("لا، تطبق الشروط والأحكام" is "No, T&C apply"). Apostrophes are dropped when words are compared, so
 * "don't" is "dont" here.
 */
const ARABIC_NEGATIONS = [
  "لا", "غير", "ليس", "ليست", "لن", "لم",
  // Review fix (approved): Arabic "without" words and colloquial negations.
  "بدون", "دون", "بلا", "ما", "مو", "مش", "مب",
];
const NEGATIONS = new Set([
  "not", "no", "non", "never",
  // Review fix (approved): English contractions and "cannot".
  "dont", "doesnt", "wont", "isnt", "arent", "cant", "cannot",
  ...ARABIC_NEGATIONS,
  // Second review fix (approved): the same Arabic negations joined to و ("and") — ولا, وبدون, ولم… — which Arabic
  // writes as one word. Still only the word immediately before the phrase.
  ...ARABIC_NEGATIONS.map((word) => `و${word}`),
]);

/**
 * Exception wording (second review fix, approved): after legal wording, a clause later on the same line that
 * STARTS with one of these ("الأسعار شاملة ضريبة القيمة المضافة، باستثناء الرسوم") limits it — a person decides,
 * even though punctuation separates it.
 */
// Final adjustment (approved): also with و ("and") joined — وباستثناء, وما عدا.
const EXCEPTION_WORDS = ["باستثناء", "ما عدا", "وباستثناء", "وما عدا", "except", "excluding"];

/**
 * Approved overlaps (review fix): an approved form that sits inside a LONGER approved form of another family.
 * `counts`: the longer phrase satisfies the shorter requirement; `human_check`: it adds a condition, so a
 * person decides. A test checks that every overlap in the list has a decision here.
 */
export const PHRASE_OVERLAPS: readonly { inner: string; outer: string; decision: "counts" | "human_check" }[] = [
  { inner: "D2 conditions_apply", outer: "D1 tc_apply", decision: "counts" },
  { inner: "D13 per_person", outer: "D14 per_person_twin", decision: "human_check" },
  { inner: "C7b call_us", outer: "C7 call_us_now", decision: "human_check" },
  { inner: "C8 contact_us", outer: "C9 whatsapp_us", decision: "human_check" },
];

/**
 * Approved extensions of LEGAL wording that still count (review fix): D11 with "without notice". Any other
 * words after legal wording in the same clause may add a condition, so a person decides. Calls to action
 * accept extensions ("حمّل التطبيق الآن", "احجز الآن واحصل على خصم ٢٠٪") — except the overlaps above.
 */
const APPROVED_EXTENSIONS: Record<string, readonly string[]> = {
  "D11 prices_change": ["دون إشعار مسبق", "بدون إشعار مسبق", "without notice", "without prior notice"],
};

type SlotValue = { date: DateValue[] } | { price: Price };
type Identified = { family: PhraseFamily; language: PhraseLanguage; value?: SlotValue };

const wordsKey = (s: string) => normalizeWords(s);

/** The value after a slot phrase's words, when that's ALL there is: one date, or one price. */
function slotValue(rest: string, slot: "date" | "price"): SlotValue | null {
  const words = wordsKey(rest);
  if (!words) return null;
  if (slot === "date") {
    const found = findDates(rest, { withoutYear: true });
    // Nothing but the date: written one way, only its numbers remain ("31 12 2026").
    return found.length === 1 && /^\d+( \d+){1,2}$/.test(wordsKey(datesWrittenOneWay(rest))) ? { date: found[0] } : null;
  }
  const prices = findPrices(rest);
  if (prices.length === 1 && wordsKey(prices[0].text) === words) return { price: prices[0] };
  const bare = prices.length === 0 ? parsePrice(rest) : null;
  return bare ? { price: bare } : null;
}

/**
 * Every approved phrase family the wording IS (complete), with its language. Usually one; an Arabic form
 * shared by two families ("احجز الآن" is both Book now and Reserve now) gives both.
 */
function identifyPhrases(wording: string): Identified[] {
  const key = wordsKey(wording);
  if (!key) return [];
  const out: Identified[] = [];
  for (const family of PHRASE_FAMILIES) {
    const hit = identifyIn(family, wording, key);
    if (hit) out.push(hit);
  }
  return out;
}

/** Which approved phrase the wording IS (complete), in which language — the first family, or null. */
export function identifyPhrase(wording: string): Identified | null {
  return identifyPhrases(wording)[0] ?? null;
}

/** The wording as a complete form of this family (and, for a slot phrase, its date / price) — or null. */
function identifyIn(family: PhraseFamily, wording: string, key: string): Identified | null {
  for (const language of ["en", "ar"] as const) {
    for (const form of family[language]) {
      if (!family.slot) {
        if (wordsKey(form) === key) return { family, language };
        continue;
      }
      const prefix = form.replace(VALUE, "").trim();
      const start = wordSequenceMatches(wording, prefix).find((m) => m.previousWord === null);
      const value = start ? slotValue(start.after, family.slot) : null;
      if (value) return { family, language, value };
    }
  }
  return null;
}

/** The language a piece of text is written in: Arabic when Arabic letters outnumber the others. */
export function textLanguage(text: string): PhraseLanguage {
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu) ?? []).length;
  const other = (text.match(/[^\P{L}\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/gu) ?? []).length;
  return arabic > other ? "ar" : "en";
}

type Base = { family: PhraseFamily; requiredLanguage: PhraseLanguage; shownLanguage: PhraseLanguage; shown: string };
export type EquivalentMatch =
  /** An approved form in the other language is shown (with the same date / price). `shown`: as written. */
  | ({ kind: "present" } & Base)
  /** The approved form is shown, but its date / price is a different one. */
  | ({ kind: "value_differs" } & Base)
  /**
   * The approved form is shown, but as part of a longer approved phrase that adds a condition (an approved
   * overlap marked human_check), or legal wording followed by more words in the same clause: a person decides.
   */
  | ({ kind: "needs_check"; reason: "overlap" | "extension" } & Base);

/** Punctuation that ends a clause. */
const CLAUSE_END = /[.,،؛;:!?؟*()[\]\-–—|/•]/u;

/**
 * The words after a legal phrase in the same clause (up to punctuation or the end of the line), unless they
 * are an approved extension of it or start another approved phrase ("تطبق الشروط والأحكام حتى نفاد الكمية").
 * Empty when the wording is complete as it stands.
 */
function extraWords(family: PhraseFamily, after: string): string {
  const [clause, ...laterClauses] = after.split(/\r?\n/)[0].split(CLAUSE_END).map((c) => c.trim());
  // An exception later on the line, after punctuation: never complete.
  const exception = laterClauses.find((c) => EXCEPTION_WORDS.some((word) => wordSequenceMatches(c, word).some((m) => m.previousWord === null)));
  if (exception) return exception;
  if (!wordsKey(clause)) return "";
  for (const extension of APPROVED_EXTENSIONS[family.id] ?? []) {
    const [hit] = wordSequenceMatches(clause, extension);
    if (hit && hit.previousWord === null && !wordsKey(hit.after)) return "";
  }
  const startsAnotherPhrase = PHRASE_FAMILIES.some((f) =>
    [...f.en, ...f.ar].some((form) => wordSequenceMatches(clause, form.replace(VALUE, "").trim()).some((m) => m.previousWord === null))
  );
  return startsAnotherPhrase ? "" : clause;
}

/**
 * Whether an approved form of another family, longer than the match, covers it — with the approved decision
 * and the text after that longer form (so wording added after it is still checked).
 */
function overlapDecision(
  family: PhraseFamily,
  language: PhraseLanguage,
  reading: string,
  m: { start: number; end: number }
): { decision: "counts" | "human_check"; outerFamily: PhraseFamily; after: string } | null {
  let found: { decision: "counts" | "human_check"; outerFamily: PhraseFamily; after: string } | null = null;
  for (const overlap of PHRASE_OVERLAPS.filter((o) => o.inner === family.id)) {
    const outer = PHRASE_FAMILIES.find((f) => f.id === overlap.outer)!;
    for (const form of outer[language]) {
      const cover = wordSequenceMatches(reading, form.replace(VALUE, "").trim()).find(
        (o) => o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start
      );
      if (!cover) continue;
      if (!found || overlap.decision === "human_check") found = { decision: overlap.decision, outerFamily: outer, after: cover.after };
    }
  }
  return found;
}

/** Where a date / price shown at the very start of `text` ends — or null when the text doesn't begin with it. */
function valueAtStart(text: string, slot: "date" | "price"): { date?: DateValue[]; price?: Price; end: number } | null {
  const trimmed = text.replace(/^\s+/, "");
  const lead = text.length - trimmed.length;
  if (slot === "price") {
    const [price] = findPrices(trimmed);
    return price && trimmed.startsWith(price.text) ? { price, end: lead + price.text.length } : null;
  }
  const [date] = findDates(trimmed, { withoutYear: true });
  if (!date) return null;
  const same = (m: DateValue[]) => JSON.stringify(m.map(({ day, month, year }) => [day, month, year])) === JSON.stringify(date.map(({ day, month, year }) => [day, month, year]));
  // The shortest start of the text that already gives this date — and it must need the first word.
  const ends = [...trimmed.matchAll(/\S+/g)].map((w) => w.index + w[0].length);
  const end = ends.find((e) => findDates(trimmed.slice(0, e), { withoutYear: true }).some(same));
  if (end === undefined) return null;
  const firstWord = trimmed.match(/^\S+\s*/)?.[0].length ?? 0;
  if (findDates(trimmed.slice(firstWord, end), { withoutYear: true }).some(same)) return null;
  return { date, end: lead + end };
}

/** A value anywhere on the phrase's own line (as before): the first date / price after the phrase, and where it ends. */
function valueOnLine(line: string, slot: "date" | "price"): { date?: DateValue[]; price?: Price; end: number } | null {
  if (slot === "price") {
    const [price] = findPrices(line);
    return price ? { price, end: line.indexOf(price.text) + price.text.length } : null;
  }
  const words = [...line.matchAll(/\S+/g)];
  for (let i = 0; i < words.length; i++) {
    const found = valueAtStart(line.slice(words[i].index), "date");
    if (found) return { ...found, end: words[i].index + found.end };
  }
  return null;
}

/**
 * When the required wording is an approved phrase and the content shows one of its approved forms in the
 * OTHER language (complete words, not negated): present; value_differs when the date / price after it isn't
 * the required one; needs_check when it's part of a longer phrase adding a condition, or legal wording with
 * more words after it. Null otherwise (not in the list, same language only, or not shown). Callers consult
 * this only when the same-language check found nothing at all (no match and no near-match).
 */
export function matchEquivalent(required: string, readings: readonly string[]): EquivalentMatch | null {
  const found = identifyPhrases(required).map((identified) => matchFamily(identified, readings)).filter((m): m is EquivalentMatch => m !== null);
  return found.find((m) => m.kind === "present") ?? found.find((m) => m.kind === "value_differs") ?? found[0] ?? null;
}

function matchFamily(identified: Identified, readings: readonly string[]): EquivalentMatch | null {
  const { family, language } = identified;
  const other: PhraseLanguage = language === "en" ? "ar" : "en";
  const candidates: EquivalentMatch[] = [];
  for (const reading of readings) {
    for (const form of family[other]) {
      const phrase = family.slot ? form.replace(VALUE, "").trim() : form;
      for (const m of wordSequenceMatches(reading, phrase)) {
        if (m.previousWord !== null && NEGATIONS.has(m.previousWord) && !m.separatedFromPrevious) continue;
        const base = { family, requiredLanguage: language, shownLanguage: other };

        if (!family.slot || !identified.value) {
          const overlap = overlapDecision(family, other, reading, m);
          if (overlap?.decision === "human_check") {
            candidates.push({ kind: "needs_check", reason: "overlap", ...base, shown: m.text });
            continue;
          }
          // Legal wording: more words after it (or after the longer approved phrase that counts for it) may add
          // a condition.
          const extra = family.kind === "legal" ? (overlap ? extraWords(overlap.outerFamily, overlap.after) : extraWords(family, m.after)) : "";
          if (extra) candidates.push({ kind: "needs_check", reason: "extension", ...base, shown: `${m.text} ${extra}` });
          else candidates.push({ kind: "present", ...base, shown: m.text });
          continue;
        }

        // A date / price: on the phrase's own line, else (review fix) only at the very start of the NEXT line in
        // this reading — A4's reading order, or the listed order when positions are missing.
        const lines = m.after.split(/\r?\n/);
        const line = lines[0].slice(0, 80);
        let value = valueOnLine(line, family.slot);
        let shown = `${m.text}${line.slice(0, value?.end ?? line.length)}`.trim();
        let rest = value ? line.slice(value.end) : "";
        if (!value && lines.length > 1) {
          const next = lines[1].slice(0, 80);
          value = valueAtStart(next, family.slot);
          if (value) {
            shown = `${m.text}${line} ${next.slice(0, value.end).trim()}`.replace(/\s+/g, " ").trim();
            rest = next.slice(value.end);
          }
        }
        if (!value) continue;
        const same =
          "date" in identified.value
            ? value.date !== undefined && datesMatch(identified.value.date, value.date)
            : value.price !== undefined && pricesMatch(identified.value.price, value.price) === "match";
        if (!same) {
          candidates.push({ kind: "value_differs", ...base, shown });
          continue;
        }
        const extra = extraWords(family, rest);
        if (extra) candidates.push({ kind: "needs_check", reason: "extension", ...base, shown: `${shown} ${extra}` });
        else candidates.push({ kind: "present", ...base, shown });
      }
    }
  }
  return candidates.find((c) => c.kind === "present") ?? candidates.find((c) => c.kind === "value_differs") ?? candidates[0] ?? null;
}

export type EquivalentDecision = "pass" | "pass_reference" | "human_check";

/**
 * What a cross-language match means for the check:
 *   - shown as part of a longer phrase that adds a condition, or legal wording with more words → human check;
 *   - a call to action, or optional legal wording → pass (shown as "present, in Arabic…");
 *   - MANDATORY legal wording (decision 5) → a person must confirm the translation ("Needs a human check"),
 *     unless the brief / company already gives an approved version in the language shown — then that
 *     approved version is the reference (it is checked as its own requirement) → pass_reference.
 * `approvedWordings`: every requirement and Golden Rule wording for this check.
 */
export function equivalentDecision(match: EquivalentMatch, mandatory: boolean, approvedWordings: readonly string[]): EquivalentDecision {
  if (match.kind === "needs_check") return "human_check";
  if (match.family.kind === "cta" || !mandatory) return "pass";
  const reference = approvedWordings.some((w) => identifyPhrases(w).some((id) => id.family.id === match.family.id && id.language === match.shownLanguage));
  return reference ? "pass_reference" : "human_check";
}

/** Why a person must check a cross-language match (for the finding's explanation). */
export function humanCheckReason(match: EquivalentMatch, mandatory: boolean): string {
  const shownIn = languageName(match.shownLanguage);
  if (match.kind === "needs_check" && match.reason === "overlap") {
    return `it is shown in ${shownIn} as part of a longer phrase ("${match.shown}") that adds to the requested wording — a person must confirm it.`;
  }
  if (match.kind === "needs_check") {
    return `it is shown in ${shownIn} with more wording after it ("${match.shown}"), which may add a condition — a person must confirm it.`;
  }
  return `it is shown in ${shownIn} ("${match.shown}") — an approved translation of the requested wording, but ${mandatory ? "mandatory " : ""}legal wording must be confirmed by a person.`;
}

/**
 * The note added to a SAME-LANGUAGE failure (a typo, or a wrong date / price) when an approved equivalent is
 * correct in the other language — information only: the failure stands (review fix).
 */
export function equivalentNote(required: string, readings: readonly string[]): string {
  const match = matchEquivalent(required, readings);
  if (match?.kind !== "present") return "";
  return ` An approved ${languageName(match.shownLanguage)} equivalent is also shown correctly ("${match.shown}"), but the ${languageName(match.requiredLanguage)} wording still needs correcting.`;
}

/** Every approved wording for a check: the confirmed brief and the company's active Golden Rules (the A5 reference). */
export function approvedWordingsOf(context: Pick<QcContext, "requirements" | "company">): string[] {
  return [
    ...context.requirements.map((r) => r.expectedValue),
    ...context.company.goldenRules.filter((g) => g.active && g.approved_value).map((g) => g.approved_value!),
  ];
}

const LANGUAGE_NAME: Record<PhraseLanguage, string> = { en: "English", ar: "Arabic" };
export const languageName = (l: PhraseLanguage) => LANGUAGE_NAME[l];
