import type { GoldenRule } from "@/lib/company/types";
import { colorDifference, containsText, ctaMatches, findName, sameFontFamily } from "@/lib/qc/compare";
import { allText, type ContentDetections } from "@/lib/qc/detections";
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

function checkOne(rule: GoldenRule, d: ContentDetections | null): Finding {
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
      return containsText(text, value)
        ? passed("Present", "The required disclaimer appears in full.")
        : failed("Missing or worded differently", "The required disclaimer doesn't appear word for word.", `Add the disclaimer exactly as approved: "${value}".`);
    }
    case "approved_product_name": {
      const text = allText(d);
      if (text === null) return unverified(NEEDS_ANALYSIS);
      const check = findName(text, value);
      if (check.status === "exact") return passed(value, "The product name is written as approved.");
      if (check.status === "absent") return notApplicable(`${RULE_ID}.${rule.category}`, CATEGORY, title, "The product isn't mentioned in the content.");
      return failed(check.found, "The product name isn't written as approved.", `Write it exactly as "${value}".`);
    }
    case "approved_cta": {
      if (!d?.texts) return unverified(NEEDS_ANALYSIS);
      const ctas = d.texts.filter((t) => t.role === "cta");
      if (ctas.some((t) => ctaMatches(value, t.text)) || (ctas.length === 0 && containsText(allText(d) ?? "", value))) {
        return passed(value, "The call to action is the approved one.");
      }
      if (ctas.length === 0) return notApplicable(`${RULE_ID}.${rule.category}`, CATEGORY, title, "No call to action was found in the content.");
      return failed(ctas.map((t) => t.text).join(", "), "The call to action isn't the approved wording.", `Use "${value}".`, Math.min(...ctas.map((t) => t.confidence)));
    }
    case "approved_color": {
      if (colorDifference(value, value) === null) return unverified(`"${value}" isn't a colour code (#RRGGBB), so it can't be compared.`);
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
    return active.map((rule) => ({ ...checkOne(rule, context.detections), mandatory: rule.mandatory }));
  },
};

export const GOLDEN_RULES: readonly Rule<QcContext>[] = [goldenRule];
