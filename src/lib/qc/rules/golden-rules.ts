import type { GoldenRule } from "@/lib/company/types";
import { colorDifference, containsText, ctaMatches, findName, sameFontFamily } from "@/lib/qc/compare";
import { allText, roleBasedConfidence, textReadings, type ContentDetections } from "@/lib/qc/detections";
import { HUMAN_CHECK, HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import { approvedWordingsOf, equivalentDecision, equivalentNote, humanCheckReason, languageName, matchEquivalent, textLanguage } from "@/lib/qc/phrase-equivalents";
import type { Finding, Rule } from "@/lib/qc/findings";
import { BRAND_COLOR_TOLERANCE } from "@/lib/qc/rules/brand";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, severityFor, type QcContext } from "@/lib/qc/rules/context";

/**
 * Golden Rules (plan 5.6): every ACTIVE rule the company saved (3.7) is
 * applied automatically in every QC session. A broken mandatory rule is
 * CRITICAL; an optional one MAJOR. Rules written only in words ("logo rule",
 * "other") are listed as not verified for a person to check.
 */

const CATEGORY = "golden_rules" as const;
const RULE_ID = "golden_rules.rule";

function checkOne(rule: GoldenRule, d: ContentDetections | null, approvedWordings: readonly string[] = []): Finding {
  const title = `Golden Rule: ${rule.rule}`;
  const severity = severityFor(rule.mandatory);
  const make = findingFor(`${RULE_ID}.${rule.category}`, CATEGORY, title);
  const value = rule.approved_value?.trim() || null;
  const unverified = (why: string) => notVerified(`${RULE_ID}.${rule.category}`, CATEGORY, title, severity, why, value ?? rule.rule);
  const failed = (detected: string, explanation: string, fix: string, confidence?: number) =>
    make({ severity, status: "failed", expected: value ?? rule.rule, detected, explanation: `${explanation}${rule.mandatory ? " This Golden Rule is mandatory." : ""}`, suggestedFix: fix, confidence });
  const passed = (detected: string, explanation: string, confidence?: number) =>
    make({ severity, status: "passed", expected: value ?? rule.rule, detected, explanation, confidence });

  if (rule.category === "logo_rule" || rule.category === "other") {
    return unverified("This rule is written in words, so it isn't checked automatically — review it by eye.");
  }
  if (!value) return unverified("No approved value is saved for this rule, so there's nothing to compare with. Add one on the company page.");

  switch (rule.category) {
    case "mandatory_disclaimer": {
      const text = allText(d, false);
      if (text === null) return unverified(NEEDS_ANALYSIS);
      // In any reading of the text (A4: hyphenated line breaks, text blocks out of reading order).
      const readings = textReadings(d, false);
      if (readings.some((reading) => containsText(reading, value))) return passed("Present", "The required disclaimer appears in full.");
      // A same-language near-match (a typo, or another date / number) is reported as before — an approved
      // equivalent in the other language never hides it, it is only mentioned (review fix).
      const fix = `Add the disclaimer exactly as approved: "${value}".`;
      const close = findName(text, value);
      const note = close.status === "different" || close.status === "misspelt" ? equivalentNote(value, readings) : "";
      if (close.status === "different") return failed(close.found, `The required disclaimer appears with different numbers or details — it must appear word for word.${note}`, fix);
      if (close.status === "misspelt") return failed(close.found, `The required disclaimer appears, but not word for word.${note}`, fix);
      // A5, only when nothing in the approved language was found: an approved English <-> Arabic equivalent
      // (reviewed phrase list). Mandatory legal wording translated needs a person, unless an approved version
      // in the language shown is saved too.
      const cross = matchEquivalent(value, readings);
      if (cross?.kind === "value_differs") {
        return failed(cross.shown, `The disclaimer is shown in ${languageName(cross.shownLanguage)}, but with a different date or amount — it must appear word for word.`, `Add the disclaimer exactly as approved: "${value}".`);
      }
      if (cross) {
        const shownIn = languageName(cross.shownLanguage);
        const decision = equivalentDecision(cross, rule.mandatory, approvedWordings);
        if (decision === "human_check") {
          return make({
            severity,
            status: "unverified",
            expected: value,
            detected: cross.shown,
            explanation: `${severity === "critical" ? HUMAN_CHECK_CRITICAL : HUMAN_CHECK}: ${humanCheckReason(cross, rule.mandatory)}`,
          });
        }
        return passed(
          cross.shown,
          decision === "pass_reference"
            ? `Present in ${shownIn} ("${cross.shown}"). The approved ${shownIn} version is checked as its own rule or requirement.`
            : `Present in ${shownIn} ("${cross.shown}") — an approved equivalent of the approved wording.`
        );
      }
      return failed("Not found", "The required disclaimer doesn't appear.", fix);
    }
    case "approved_product_name": {
      const text = allText(d);
      if (text === null) return unverified(NEEDS_ANALYSIS);
      const check = findName(text, value);
      if (check.status === "exact") return passed(value, "The product name is written as approved.");
      if (check.status === "absent") return notApplicable(`${RULE_ID}.${rule.category}`, CATEGORY, title, "The product isn't mentioned in the content.");
      if (check.status === "different") return failed(check.found, "A different product (another model or number) is named, not the approved one.", `Use "${value}".`);
      return failed(check.found, "The product name isn't written as approved.", `Write it exactly as "${value}".`);
    }
    case "approved_cta": {
      if (!d?.texts) return unverified(NEEDS_ANALYSIS);
      const ctas = d.texts.filter((t) => t.role === "cta");
      if (ctas.some((t) => ctaMatches(value, t.text)) || (ctas.length === 0 && textReadings(d).some((reading) => containsText(reading, value)))) {
        return passed(value, "The call to action is the approved one.");
      }
      // Another CTA in the approved wording's language: not the approved one, as before — an approved equivalent
      // in the other language never hides it, it is only mentioned (review fix).
      const ownLanguage = ctas.filter((t) => textLanguage(t.text) === textLanguage(value));
      if (ownLanguage.length) {
        const all = textReadings(d);
        return failed(ownLanguage.map((t) => t.text).join(", "), `The call to action isn't the approved wording.${equivalentNote(value, all)}`, `Use "${value}".`, roleBasedConfidence(ownLanguage));
      }
      // A5, only when no CTA in that language: the approved CTA's approved Arabic / English equivalent.
      const cross = matchEquivalent(value, ctas.length ? ctas.map((t) => t.text) : textReadings(d));
      if (cross?.kind === "present") {
        return passed(cross.shown, `Present in ${languageName(cross.shownLanguage)} ("${cross.shown}") — an approved equivalent of the approved call to action.`);
      }
      if (cross?.kind === "needs_check") {
        return make({
          severity,
          status: "unverified",
          expected: value,
          detected: cross.shown,
          explanation: `${severity === "critical" ? HUMAN_CHECK_CRITICAL : HUMAN_CHECK}: ${humanCheckReason(cross, rule.mandatory)}`,
        });
      }
      if (ctas.length === 0) return notApplicable(`${RULE_ID}.${rule.category}`, CATEGORY, title, "No call to action was found in the content.");
      return failed(ctas.map((t) => t.text).join(", "), "The call to action isn't the approved wording.", `Use "${value}".`, roleBasedConfidence(ctas));
    }
    case "approved_color": {
      // A company setting to fix, not a design issue: worded like a missing value (golden-rules-view.ts missingCompanySetting).
      if (colorDifference(value, value) === null) {
        return unverified(`The colour saved for this rule ("${value}") isn't a colour code (#RRGGBB), so it can't be compared. Fix it on the company page.`);
      }
      if (!d?.colors) return unverified(NEEDS_ANALYSIS);
      const hit = d.colors.find((c) => (colorDifference(c.hex, value) ?? Infinity) <= BRAND_COLOR_TOLERANCE);
      return hit
        ? passed(hit.hex, "The approved colour is used.")
        : failed(d.colors.map((c) => c.hex).join(", ") || "No colours", "The approved colour isn't used in the content.", `Use ${value}.`);
    }
    case "approved_font": {
      if (!d?.fonts) return unverified(NEEDS_ANALYSIS);
      const approved = value.split(/,|\bor\b|\//i).map((s) => s.trim()).filter(Boolean);
      const wrong = d.fonts.filter((f) => !approved.some((a) => sameFontFamily(a, f.family)));
      return wrong.length === 0
        ? passed(d.fonts.map((f) => f.family).join(", ") || "No text", "Only the approved font is used.")
        : failed(wrong.map((f) => f.family).join(", "), "A font other than the approved one is used.", `Use ${approved.join(" or ")} only.`, Math.min(...wrong.map((f) => f.confidence)));
    }
  }
  return unverified("This kind of rule isn't checked automatically.");
}

const goldenRule: Rule<QcContext> = {
  id: RULE_ID,
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["the company's Golden Rules (3.7)", "what was detected in the content"],
  defaultSeverity: "critical",
  mandatory: true,
  run(context) {
    const active = context.company.goldenRules.filter((r) => r.active);
    if (active.length === 0) return [notApplicable(RULE_ID, CATEGORY, "Golden Rules", "This company has no active Golden Rules.")];
    const approved = approvedWordingsOf(context);
    return active.map((rule) => ({ ...checkOne(rule, context.detections, approved), mandatory: rule.mandatory }));
  },
};

export const GOLDEN_RULES: readonly Rule<QcContext>[] = [goldenRule];
