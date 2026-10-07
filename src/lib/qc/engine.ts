import { sortFindings, type Finding, type Rule } from "@/lib/qc/findings";
import type { ContentType } from "@/lib/qc/content-types";

/**
 * The QC engine (plan 5.x): runs every registered rule that applies to the
 * content type and collects their findings. Rules are data (lib/qc/rules/),
 * so adding or changing one never touches the screens.
 *
 * This round registers the platform / size rules (5.11). Content, brand,
 * Golden Rules, layout, accessibility, image, brief and legal rules follow.
 */
export function runRules<Context>(
  rules: readonly Rule<Context>[],
  contentType: ContentType,
  context: Context
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes(contentType)) continue;
    findings.push(...rule.run(context));
  }
  return sortFindings(findings);
}
