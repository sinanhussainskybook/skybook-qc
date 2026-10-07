import {
  emailsMatch,
  findEmails,
  findName,
  findPhones,
  findWebsites,
  phonesMatch,
  websitesMatch,
} from "@/lib/qc/compare";
import { allText } from "@/lib/qc/detections";
import type { Finding, Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, type QcContext } from "@/lib/qc/rules/context";

/**
 * Content QC (plan 5.4): is the text in the content correct in itself?
 *  - contact details shown match the company's saved ones (or the brief),
 *  - the company's name isn't misspelt,
 *  - no placeholder text was left in,
 *  - no accidentally repeated words.
 * Whether the brief's items are present is Brief QC (5.10).
 */

const CATEGORY = "content" as const;

// ---------------------------------------------------------------------------

type ContactKind = { key: "phone" | "email" | "website"; label: string; requirementTypes: string[] };
const CONTACTS: ContactKind[] = [
  { key: "phone", label: "Phone / WhatsApp number", requirementTypes: ["phone", "whatsapp"] },
  { key: "email", label: "Email address", requirementTypes: ["email"] },
  { key: "website", label: "Website", requirementTypes: ["website"] },
];

function approvedContacts(context: QcContext, kind: ContactKind): string[] {
  const { contact } = context.company;
  const saved = kind.key === "phone" ? [contact.phone, contact.whatsapp] : kind.key === "email" ? [contact.email] : [contact.website];
  const fromBrief = context.requirements.filter((r) => kind.requirementTypes.includes(r.type)).map((r) => r.expectedValue);
  return [...saved, ...fromBrief].filter((v): v is string => Boolean(v?.trim()));
}

const contactRule: Rule<QcContext> = {
  id: "content.contact_details",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["company contact details (3.4) or brief", "text read from the content"],
  defaultSeverity: "critical",
  mandatory: true,
  run(context) {
    const text = allText(context.detections);
    if (text === null) return [notVerified(this.id, CATEGORY, "Contact details", "critical", NEEDS_ANALYSIS)];
    const findings: Finding[] = [];
    for (const kind of CONTACTS) {
      const make = findingFor(`${this.id}.${kind.key}`, CATEGORY, kind.label);
      const shown = kind.key === "phone" ? findPhones(text) : kind.key === "email" ? findEmails(text) : findWebsites(text);
      if (shown.length === 0) continue;
      const approved = approvedContacts(context, kind);
      if (approved.length === 0) {
        findings.push(
          notVerified(`${this.id}.${kind.key}`, CATEGORY, kind.label, "critical",
            `The content shows ${shown.join(", ")}, but no ${kind.label.toLowerCase()} is saved for this company or given in the brief to compare it with. Add it on the company page.`)
        );
        continue;
      }
      for (const value of shown) {
        const results = approved.map((a) =>
          kind.key === "phone" ? phonesMatch(a, value) : (kind.key === "email" ? emailsMatch(a, value) : websitesMatch(a, value)) ? "match" : "mismatch"
        );
        const expected = approved.join(" or ");
        if (results.includes("match")) {
          findings.push(make({ severity: "critical", status: "passed", expected, detected: value, explanation: "Matches the approved contact details." }));
        } else if (results.includes("match_without_country_code")) {
          findings.push(
            make({
              severity: "minor",
              status: "failed",
              expected,
              detected: value,
              explanation: "The number is right but shown without its country code, so people outside the country can't call it as written.",
              suggestedFix: `Show the number with its country code: ${approved[0]}.`,
            })
          );
        } else {
          findings.push(
            make({
              severity: "critical",
              status: "failed",
              expected,
              detected: value,
              explanation: `This ${kind.label.toLowerCase()} isn't the company's saved one or the one in the brief — people would be sent to the wrong place.`,
              suggestedFix: `Replace it with ${approved[0]}.`,
            })
          );
        }
      }
    }
    return findings.length ? findings : [notApplicable(this.id, CATEGORY, "Contact details", "No phone number, email or website appears in the content.")];
  },
};

// ---------------------------------------------------------------------------

const companyNameRule: Rule<QcContext> = {
  id: "content.company_name",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["company name", "text read from the content"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const make = findingFor(this.id, CATEGORY, "Company name spelling");
    const text = allText(context.detections);
    const name = context.company.company.name;
    if (text === null) return [notVerified(this.id, CATEGORY, "Company name spelling", "major", NEEDS_ANALYSIS, name)];
    const check = findName(text, name);
    if (check.status === "exact") return [make({ severity: "major", status: "passed", expected: name, detected: name, explanation: "The company name is spelt correctly." })];
    if (check.status === "absent") return [notApplicable(this.id, CATEGORY, "Company name spelling", "The company name doesn't appear in the content.")];
    return [
      make({
        severity: "major",
        status: "failed",
        expected: name,
        detected: check.found,
        explanation: "This looks like the company's name, misspelt.",
        suggestedFix: `Spell it exactly as "${name}".`,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------

/** Text that's only ever there by mistake. */
export const PLACEHOLDER_PATTERNS: [RegExp, string][] = [
  [/\blorem ipsum\b/i, "lorem ipsum"],
  [/\bdolor sit amet\b/i, "dolor sit amet"],
  [/\b(your|insert) (text|headline|title|logo|name|price|number|copy) here\b/i, "“… here” placeholder"],
  [/\[(insert|add|tbc|tbd|xx+|placeholder)[^\]]*\]/i, "[…] placeholder"],
  [/\{\{?[^}]*\}\}?/, "{…} template field"],
  [/\b(placeholder|sample text|dummy text)\b/i, "placeholder wording"],
  [/\bx{3,}\b/i, "XXX"],
  [/\b(tbc|tbd)\b/i, "TBC / TBD"],
];

const placeholderRule: Rule<QcContext> = {
  id: "content.placeholder",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text read from the content"],
  defaultSeverity: "critical",
  mandatory: true,
  run(context) {
    const make = findingFor(this.id, CATEGORY, "Placeholder text");
    const text = allText(context.detections);
    if (text === null) return [notVerified(this.id, CATEGORY, "Placeholder text", "critical", NEEDS_ANALYSIS)];
    const hits = PLACEHOLDER_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
    if (hits.length === 0) return [make({ severity: "critical", status: "passed", detected: "None", explanation: "No placeholder text found." })];
    return [
      make({
        severity: "critical",
        status: "failed",
        expected: "No placeholder text",
        detected: hits.join(", "),
        explanation: "Placeholder text was left in the content.",
        suggestedFix: "Replace the placeholder with the final approved text.",
      }),
    ];
  },
};

// ---------------------------------------------------------------------------

const repeatedWordRule: Rule<QcContext> = {
  id: "content.repeated_word",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["text read from the content"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const make = findingFor(this.id, CATEGORY, "Repeated word");
    const texts = context.detections?.texts;
    if (!texts) return [notVerified(this.id, CATEGORY, "Repeated word", "minor", NEEDS_ANALYSIS)];
    const repeats = texts.flatMap((t) =>
      [...t.text.matchAll(/\b([\p{L}]{2,})\s+\1\b/giu)].map((m) => ({ found: m[0], text: t }))
    );
    if (repeats.length === 0) return [make({ severity: "minor", status: "passed", detected: "None", explanation: "No word is accidentally repeated." })];
    return repeats.map(({ found, text }) =>
      make({
        severity: "minor",
        status: "failed",
        expected: found.split(/\s+/)[0],
        detected: found,
        explanation: "The same word appears twice in a row.",
        suggestedFix: "Remove the repeated word.",
        confidence: text.confidence,
        fileId: text.fileId,
      })
    );
  },
};

export const CONTENT_RULES: readonly Rule<QcContext>[] = [contactRule, companyNameRule, placeholderRule, repeatedWordRule];
