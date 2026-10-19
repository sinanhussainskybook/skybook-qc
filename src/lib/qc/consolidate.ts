import type { Finding, Severity } from "@/lib/qc/findings";
import { mergeDuplicateFindings, needsVerifying } from "@/lib/qc/golden-rules-view";

/**
 * Findings as the results show and count them (website and PDF alike): each underlying issue once.
 *   1. Different checks that found the SAME issue are merged (lib/qc/golden-rules-view.ts).
 *   2. One check that found the same KIND of problem in several places of one design — low contrast
 *      on four labels, three texts at the edge — is one issue to fix, listed with every place it was
 *      found and counted once, at its most serious severity.
 * Only the checks in GROUPED_RULES report per text or font; everything else is one finding per
 * distinct thing already (a requirement, a Golden Rule, a banned term, a wrong phone number…) and is
 * never grouped, so distinct issues are never hidden. Nothing is dropped: every place is listed.
 */
export function consolidateFindings(findings: Finding[]): Finding[] {
  return groupOccurrences(mergeDuplicateFindings(findings));
}

/** Checks that report one finding per text element (or font) — the same problem in several places. */
export const GROUPED_RULES: readonly string[] = [
  "accessibility.contrast",
  "accessibility.text_size",
  "layout.edge_margin",
  "layout.text_overlap",
  "layout.on_screen_time",
  "brand.colors.text",
  "brand.fonts",
];

/** How many places are named in a grouped finding before "and N more". */
export const MAX_LISTED = 5;

const ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, suggestion: 3 };

/** A failed issue, something to verify by eye, a pass… — never grouped with each other. */
const kindOf = (f: Finding) => (f.status === "failed" ? "failed" : needsVerifying(f) ? "verify" : f.status);

/**
 * The findings of a GROUPED_RULES check that are the same problem in the same design: one finding,
 * with every place listed. Grouped by check, title, design (file) and kind; order is kept.
 */
export function groupOccurrences(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const order: (Finding | string)[] = [];
  for (const f of findings) {
    if (!GROUPED_RULES.includes(f.ruleId)) {
      order.push(f);
      continue;
    }
    const key = [f.ruleId, f.title, f.fileId ?? "", f.requirementId ?? "", kindOf(f)].join("\u0000");
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(f);
  }
  return order.map((x) => (typeof x === "string" ? combine(groups.get(x)!) : x));
}

const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v?.trim())))];

function combine(group: Finding[]): Finding {
  if (group.length === 1) return group[0];
  const first = group[0];
  const worst = group.reduce((a, b) => (ORDER[b.severity] < ORDER[a.severity] ? b : a));
  const places = unique(group.map((f) => f.detected));
  const listed = places.slice(0, MAX_LISTED).join("; ");
  const more = places.length > MAX_LISTED ? `; and ${places.length - MAX_LISTED} more` : "";
  // Every place a problem was found is listed; a pass or a "not checked" keeps its own wording.
  const problem = kindOf(first) === "failed" || kindOf(first) === "verify";
  const alsoCovers = group.flatMap((f) => f.alsoCovers ?? []);
  return {
    ...first,
    severity: worst.severity,
    confidence: Math.min(...group.map((f) => f.confidence)),
    expected: unique(group.map((f) => f.expected)).join(" / ") || undefined,
    detected: problem && places.length ? `Found ${group.length} times: ${listed}${more}` : first.detected,
    suggestedFix: unique(group.map((f) => f.suggestedFix)).join(" ") || undefined,
    occurrences: group.length,
    ...(alsoCovers.length ? { alsoCovers } : {}),
  };
}
