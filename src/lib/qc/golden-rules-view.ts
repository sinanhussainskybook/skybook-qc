import { HUMAN_CHECK, isHumanCheck } from "@/lib/analysis/policy";
import { normalizeWords } from "@/lib/qc/compare";
import type { Finding, Severity } from "@/lib/qc/findings";

/**
 * Findings in the results (the website and the PDF): the same issue is never
 * shown or counted twice, and only what a person genuinely has to look at is
 * marked "Please verify".
 *
 * The rules themselves are unchanged (lib/qc/rules/): every check — every
 * active Golden Rule included — runs in every QC session. This file only
 * (1) merges findings of different checks that are the SAME issue (a Golden
 * Rule and the brief, the brief and the company's contact details, the
 * company's name and its approved terms, a Golden Rule font / colour and the
 * brand's, the safe zone and text near the edge, two brief requirements for
 * the same value), (2) says which findings need verifying by eye, and (3)
 * splits what couldn't be checked. Repeated occurrences of one issue are
 * grouped after this (lib/qc/consolidate.ts).
 */

export const GOLDEN = "golden_rules";

export const isGoldenRule = (f: Finding) => f.category === GOLDEN;

/**
 * Which other checks can be the same issue as a Golden Rule: the same kind of
 * thing (a disclaimer, a call to action, a product name). Colour and font
 * rules have no brief / legal counterpart, so they are never merged.
 */
const COUNTERPART: Record<string, (ruleId: string) => boolean> = {
  "golden_rules.rule.mandatory_disclaimer": (id) => id === "legal.disclaimer",
  "golden_rules.rule.approved_cta": (id) => id === "brief.requirement.cta",
  "golden_rules.rule.approved_product_name": (id) => id === "brief.requirement.product_name",
};

/** A brief contact requirement and the contact-details check for the same kind of detail. */
const CONTACT_CHECK: Record<string, string> = {
  "brief.requirement.phone": "content.contact_details.phone",
  "brief.requirement.whatsapp": "content.contact_details.phone",
  "brief.requirement.email": "content.contact_details.email",
  "brief.requirement.website": "content.contact_details.website",
};

const ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, suggestion: 3 };
const same = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const sameFile = (a: Finding, b: Finding) => (a.fileId ?? null) === (b.fileId ?? null);
/** Both confirmed mistakes, or both for a person to verify — never one of each. */
const sameKind = (a: Finding, b: Finding) => (a.status === "failed" && b.status === "failed") || (needsVerifying(a) && needsVerifying(b));

/** The quoted texts in a finding's detected value ('"Swipe up" touches the edge'), and whether each was cut off ("…"). */
const quotedTexts = (value: string | undefined) =>
  [...(value ?? "").matchAll(/"([^"]+)"/g)]
    .map((m) => ({ text: m[1].replace(/…$/, "").trim().toLowerCase(), cut: m[1].endsWith("…") }))
    .filter((q) => q.text.length > 0);
/**
 * Two quotes of the same text: equal — or, when one was cut off at a length limit, the other starts with
 * it. A different text that merely starts the same ("Sale" and "Sale ends Sunday") is not the same text.
 */
const sameText = (a: { text: string; cut: boolean }, b: { text: string; cut: boolean }) =>
  a.text === b.text || (a.cut && b.text.startsWith(a.text)) || (b.cut && a.text.startsWith(b.text));
/** How a brief finding says its requirement is Must have (lib/qc/rules/brief.ts); the report reads it. */
const BRIEF_MANDATORY = "The brief marks it as mandatory.";
const MANDATORY_NOTE = /\bThe brief marks it as mandatory\b/;
/** "#1A64B4" colour codes in a value, lower case. */
const colourCodes = (value: string | undefined) => (value ?? "").match(/#[0-9a-f]{6}\b/gi)?.map((c) => c.toLowerCase()) ?? [];
/** A brief requirement checked against the design's words (not its size or platform, which are per file). */
const wordedRequirement = (ruleId: string) => ruleId.startsWith("brief.requirement.") && !/^brief\.requirement\.(?:dimensions|platform)$/.test(ruleId);
/** `inner`'s words appear, in order and whole, inside `outer` ("20%" in "20% off", "AED 1,299" in "From AED 1,299"). */
const wordsWithin = (outer: string | undefined, inner: string | undefined) => {
  const o = normalizeWords(outer ?? "");
  const i = normalizeWords(inner ?? "");
  return i.length > 0 && ` ${o} `.includes(` ${i} `);
};

/**
 * The pairs of checks that can report the SAME underlying issue, and the exact
 * test for it. The first check of a pair is the one shown; the other is noted
 * on it ("also in …") and not counted again.
 */
const PAIRS: {
  shown: (f: Finding) => boolean;
  isTwin: (shown: Finding, other: Finding) => boolean;
  /** The order to try findings as "shown" in, when it matters (default: as they come). */
  first?: (a: Finding, b: Finding) => number;
}[] = [
  // A Golden Rule and the brief / legal check of the same kind, expecting the same value.
  {
    shown: (f) => f.ruleId in COUNTERPART && Boolean(f.expected),
    isTwin: (g, f) => COUNTERPART[g.ruleId](f.ruleId) && same(f.expected) === same(g.expected),
  },
  // A brief contact requirement and the contact-details check: the brief's value is one the check
  // compared with, and both found exactly the same single wrong value.
  {
    shown: (f) => f.ruleId in CONTACT_CHECK && Boolean(f.expected) && Boolean(f.detected),
    isTwin: (b, c) =>
      c.ruleId === CONTACT_CHECK[b.ruleId] &&
      (c.expected ?? "").split(" or ").some((v) => same(v) === same(b.expected)) &&
      same(c.detected) === same(b.detected),
  },
  // The company's name misspelt, and the same name as an approved brand term misspelt the same way.
  {
    shown: (f) => f.ruleId === "content.company_name" && Boolean(f.detected),
    isTwin: (n, t) => t.ruleId === "brand.terms" && same(t.expected) === same(n.expected) && same(t.detected) === same(n.detected),
  },
  // A Golden Rule font and the brand fonts: a font neither allows, found by both.
  {
    shown: (f) => f.ruleId === "golden_rules.rule.approved_font" && Boolean(f.detected),
    isTwin: (g, b) => Boolean(same(b.detected)) && b.ruleId === "brand.fonts" && (g.detected ?? "").split(",").map(same).filter(Boolean).includes(same(b.detected)),
  },
  // A Golden Rule colour and the brand colours: the approved colour is one of the brand colours, and it isn't used.
  {
    shown: (f) => f.ruleId === "golden_rules.rule.approved_color" && Boolean(f.expected),
    isTwin: (g, b) => b.ruleId === "brand.colors.present" && Boolean(same(g.expected)) && colourCodes(b.expected).includes(same(g.expected)),
  },
  // The platform's safe zone and text near the edge: the same text, in the area the platform covers.
  {
    shown: (f) => f.ruleId === "platform.safe_zone" && Boolean(f.detected),
    isTwin: (z, e) => e.ruleId === "layout.edge_margin" && quotedTexts(e.detected).some((t) => quotedTexts(z.detected).some((u) => sameText(t, u))),
  },
  // Two brief requirements for the same value — one's words inside the other's ("20%" and "20% off",
  // "AED 1,299" and "From AED 1,299"): one mistake on the design. The fuller one is shown (fixing it fixes
  // both), at the more serious severity; the other requirement is answered by it (alsoCovers keeps its id).
  {
    shown: (f) => wordedRequirement(f.ruleId) && Boolean(f.expected),
    isTwin: (a, b) => wordedRequirement(b.ruleId) && wordsWithin(a.expected, b.expected),
    // The fullest value first, so it takes in every value inside it ("From AED 1,299 per night" takes
    // "From AED 1,299" and "AED 1,299") whatever order the requirements came in.
    first: (a, b) => normalizeWords(b.expected ?? "").length - normalizeWords(a.expected ?? "").length,
  },
];

/**
 * Two checks that report the SAME issue — the same kind of check, the same
 * value expected, exactly the same thing found, in the same file, and both
 * confirmed mistakes or both to verify — are ONE issue: shown once and counted
 * once, at the more serious of the two severities, with a note of the check it
 * also stands for. Anything else — a different value, a different occurrence,
 * another file, or a mistake on one side and a "Please verify" on the other —
 * stays as it is.
 */
export function mergeDuplicateFindings(findings: Finding[]): Finding[] {
  const dropped = new Set<Finding>();
  const merged = new Map<Finding, Finding>();
  for (const pair of PAIRS) {
    for (const shown of pair.first ? [...findings].sort(pair.first) : findings) {
      if (dropped.has(shown) || !pair.shown(shown) || (shown.status !== "failed" && !needsVerifying(shown))) continue;
      const twins = findings.filter((f) => f !== shown && !dropped.has(f) && !merged.has(f) && sameKind(shown, f) && sameFile(shown, f) && pair.isTwin(shown, f));
      if (!twins.length) continue;
      twins.forEach((t) => dropped.add(t));
      const base = merged.get(shown) ?? shown;
      const worst = [base, ...twins].reduce((a, b) => (ORDER[b.severity] < ORDER[a.severity] ? b : a));
      // A brief requirement standing for a MANDATORY one says so — the report marks it Mandatory from this.
      const mandatoryTwin = wordedRequirement(base.ruleId) && !MANDATORY_NOTE.test(base.explanation) && twins.some((t) => MANDATORY_NOTE.test(t.explanation));
      merged.set(shown, {
        ...base,
        ...(mandatoryTwin ? { explanation: `${base.explanation} ${BRIEF_MANDATORY}` } : {}),
        severity: worst.severity,
        alsoCovers: [
          ...(base.alsoCovers ?? []),
          ...twins.map((t) => ({ ruleId: t.ruleId, category: t.category, title: t.title, ...(t.requirementId ? { requirementId: t.requirementId } : {}) })),
        ],
      });
    }
  }
  return findings.filter((f) => !dropped.has(f)).map((f) => merged.get(f) ?? f);
}

/** A Golden Rule written only in words ("logo rule", "other"): it can only ever be checked by eye. */
const WORDS_ONLY = /^golden_rules\.rule\.(?:logo_rule|other)$/;

/**
 * What a person has to look at: findings the AI wasn't sure about ("Needs a
 * human check"), and Golden Rules written only in words. Never counted — an
 * uncertain finding is not a confirmed mistake. A rule that couldn't be checked
 * for another reason (e.g. no approved value saved) isn't one of them.
 */
export function needsVerifying(f: Finding): boolean {
  return isHumanCheck(f) || (f.status === "unverified" && WORDS_ONLY.test(f.ruleId)) || uncheckedMandatoryRule(f);
}

/**
 * A MANDATORY Golden Rule the analysis couldn't check (e.g. the colours couldn't be measured): it must be
 * followed, so a person checks it by eye — the design is never passed with it unchecked. Missing or
 * invalid company settings are the exception: those are fixed on the company page (missingCompanySetting).
 */
const uncheckedMandatoryRule = (f: Finding) =>
  isGoldenRule(f) && f.mandatory === true && f.status === "unverified" && !missingCompanySetting(f);

/**
 * What the designer should check, and briefly why — e.g. 'Check the design
 * for "AED 1,299" — the AI wasn't sure.' A rule written in words:
 * "Check the design follows this rule — it can't be checked automatically."
 */
export function verifyNote(f: { ruleId?: string; title: string; expected?: string; explanation: string }): string {
  // A rule in words, or a mandatory rule the analysis couldn't check: anything to verify that isn't an AI doubt.
  if (/written in words/i.test(f.explanation) || (f.ruleId && WORDS_ONLY.test(f.ruleId)) || !f.explanation.startsWith(HUMAN_CHECK)) {
    return "Check the design follows this rule — it can't be checked automatically.";
  }
  const expected = f.expected?.trim();
  return expected && expected !== ruleName(f.title) ? `Check the design for "${expected}" — the AI wasn't sure.` : "Check this on the design — the AI wasn't sure.";
}

/**
 * A check that couldn't run because the company hasn't saved something it
 * needs — brand fonts, colours, terms, a logo, a Golden Rule's approved
 * value… ("… saved for this company / rule"). A settings gap, not a design
 * mistake; never counted.
 */
export const missingCompanySetting = (f: { explanation: string }) => /\bsaved for this (?:company|rule)\b/i.test(f.explanation);

/**
 * The checks that couldn't give an answer (and aren't for a person to verify),
 * in two short groups — the same words on the PDF and the website. Neither is a
 * design mistake or affects the result.
 */
export const NOT_CHECKED = {
  settings: { label: "Company settings missing", note: "add them on the company page. They aren't design issues." },
  auto: { label: "Not checked automatically", note: "they don't affect the result." },
} as const;

export function splitNotChecked<T extends { explanation: string }>(items: T[]): { settings: T[]; auto: T[] } {
  return { settings: items.filter(missingCompanySetting), auto: items.filter((it) => !missingCompanySetting(it)) };
}

/** "Golden Rule: Always use Book now" → "Always use Book now" (its row already says it's a Golden Rule). */
export const ruleName = (title: string) => title.replace(/^Golden Rule:\s*/i, "");

/**
 * The one line a merged finding carries, the same on the PDF and the website:
 *   "Brief — CTA (call to action)" → "Also required by the brief — counted once."
 *   "Content — Website"            → "Also flagged by the company's contact details — counted once."
 *   "Brand — Terminology"          → "Also flagged by the brand's approved terms — counted once."
 * An item to verify is never counted, so it ends "— shown once." instead.
 * `also` is alsoCoversText's "Category — Title; …".
 */
export function alsoNote(also: string, toVerify = false): string {
  const entries = also.split("; ").map((x) => {
    const [category, title = ""] = x.split(" — ");
    if (category === "Brief") return { by: "required", what: "the brief" };
    if (category === "Legal & Compliance") return { by: "required", what: "the legal check" };
    if (title === "Terminology") return { by: "flagged", what: "the brand's approved terms" };
    if (title === "Brand fonts") return { by: "flagged", what: "the brand fonts" };
    if (title === "Brand colours used") return { by: "flagged", what: "the brand colours" };
    if (title === "Text near the edge") return { by: "flagged", what: "the text-near-the-edge check" };
    if (category === "Content") return { by: "flagged", what: "the company's contact details" };
    return { by: "flagged", what: x };
  });
  const say = (by: string) => [...new Set(entries.filter((e) => e.by === by).map((e) => e.what))];
  const parts = [say("required").length ? `required by ${say("required").join(" and ")}` : "", say("flagged").length ? `flagged by ${say("flagged").join(" and ")}` : ""].filter(Boolean);
  return `Also ${parts.join(" and ")} — ${toVerify ? "shown once" : "counted once"}.`;
}

/** "Brief — CTA (call to action)" for each check a merged finding also stands for. */
export function alsoCoversText(f: Finding, label: (category: string) => string): string | null {
  return f.alsoCovers?.length ? f.alsoCovers.map((c) => `${label(c.category)} — ${c.title}`).join("; ") : null;
}
