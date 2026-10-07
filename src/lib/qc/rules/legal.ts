import { containsText, findName } from "@/lib/qc/compare";
import { allText } from "@/lib/qc/detections";
import type { Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, severityFor, type QcContext } from "@/lib/qc/rules/context";

/**
 * Legal & Compliance QC (plan 5.12) — ONLY rules that are configured;
 * nothing is invented. The configured legal rules today are the
 * disclaimers in the confirmed brief (requirement type "disclaimer"): each
 * must appear on screen word for word. (A company's mandatory disclaimer
 * saved as a Golden Rule is checked under Golden Rules, 5.6.)
 *
 * With no disclaimer in the brief there is nothing to check, and the
 * category says so — it never applies general legal rules of its own.
 */

const CATEGORY = "legal" as const;

const disclaimerRule: Rule<QcContext> = {
  id: "legal.disclaimer",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["disclaimers in the confirmed brief", "text read from the content"],
  defaultSeverity: "critical",
  mandatory: true,
  run(context) {
    const disclaimers = context.requirements.filter((r) => r.type === "disclaimer");
    if (disclaimers.length === 0) {
      return [
        notApplicable(this.id, CATEGORY, "Legal & compliance", "No legal or compliance rules are configured for this check (no disclaimer in the brief). Nothing else is assumed."),
      ];
    }
    // On-screen text only: a disclaimer must be readable, not just spoken.
    const text = allText(context.detections, false);
    return disclaimers.map((r) => {
      const title = r.label ? `Disclaimer: ${r.label}` : "Disclaimer";
      const severity = severityFor(r.mandatory);
      if (text === null) return notVerified(this.id, CATEGORY, title, severity, NEEDS_ANALYSIS, r.expectedValue);
      const make = findingFor(this.id, CATEGORY, title);
      if (containsText(text, r.expectedValue)) {
        return make({ severity, status: "passed", expected: r.expectedValue, detected: "Present word for word", explanation: "The disclaimer appears exactly as required." });
      }
      const close = findName(text, r.expectedValue);
      return make({
        severity,
        status: "failed",
        expected: r.expectedValue,
        detected: close.status === "misspelt" ? close.found : "Not found",
        explanation:
          close.status === "misspelt"
            ? "The disclaimer appears, but not word for word — legal wording must be exact."
            : `The disclaimer required by the brief isn't shown.${r.mandatory ? " The brief marks it as mandatory." : ""}`,
        suggestedFix: `Show the disclaimer exactly as: "${r.expectedValue}".`,
      });
    });
  },
};

export const LEGAL_RULES: readonly Rule<QcContext>[] = [disclaimerRule];
