import { capitalizationDifference, containsText, datesWrittenOneWay, findName } from "@/lib/qc/compare";
import { allText, presenceReadings, textReadings } from "@/lib/qc/detections";
import { HUMAN_CHECK, HUMAN_CHECK_CRITICAL } from "@/lib/analysis/policy";
import { approvedWordingsOf, equivalentDecision, equivalentNote, humanCheckReason, languageName, matchEquivalent } from "@/lib/qc/phrase-equivalents";
import type { Finding, Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notApplicable, notVerified, severityFor, type QcContext } from "@/lib/qc/rules/context";

/**
 * Legal & Compliance QC (plan 5.12) — ONLY rules that are configured;
 * nothing is invented. The configured legal rules today are the
 * disclaimers in the confirmed brief (requirement type "disclaimer"): each
 * must appear on screen word for word. A MANDATORY disclaimer whose words
 * are all there but with different capitals ("T&C Apply" for "T&C apply")
 * is MINOR. (A company's mandatory disclaimer
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
    const readings = textReadings(context.detections, false);
    // Only for "is the disclaimer there?" - A5 equivalents and notes use `readings`.
    const presence = presenceReadings(context.detections, false);
    const approved = approvedWordingsOf(context);
    const checkDisclaimer = (r: (typeof disclaimers)[number]): Finding => {
      const title = r.label ? `Disclaimer: ${r.label}` : "Disclaimer";
      const severity = severityFor(r.mandatory);
      if (text === null) return notVerified(this.id, CATEGORY, title, severity, NEEDS_ANALYSIS, r.expectedValue);
      const make = findingFor(this.id, CATEGORY, title);
      // Dates compared as dates, however written ("31 Dec 2026" = "31/12/2026"); capitals still from the text as shown.
      // In any reading of the text (A4: hyphenated line breaks, text blocks out of reading order); the capitals
      // are checked in the reading where it was found.
      const found = presence.find((reading) => containsText(datesWrittenOneWay(reading), datesWrittenOneWay(r.expectedValue)));
      if (found !== undefined) {
        const capitals = r.mandatory ? capitalizationDifference(found, r.expectedValue) : null;
        if (capitals) {
          return make({
            severity: "minor",
            status: "failed",
            expected: r.expectedValue,
            detected: capitals,
            explanation: "The disclaimer's words are right, but the capitals differ — legal wording must be exact.",
            suggestedFix: `Show the disclaimer exactly as: "${r.expectedValue}".`,
          });
        }
        return make({ severity, status: "passed", expected: r.expectedValue, detected: "Present word for word", explanation: "The disclaimer appears exactly as required." });
      }
      // A same-language near-match (a typo, or another date / number) is reported as before — an approved
      // equivalent in the other language never hides it, it is only mentioned (review fix).
      const close = findName(datesWrittenOneWay(text), datesWrittenOneWay(r.expectedValue));
      const nearMiss = close.status === "misspelt" || close.status === "different";
      // A5, only when nothing in the brief's language was found: an approved English <-> Arabic equivalent
      // (reviewed phrase list). Mandatory legal wording translated from the brief's language needs a person,
      // unless the brief / company gives the approved version shown.
      const cross = nearMiss ? null : matchEquivalent(r.expectedValue, readings);
      if (cross) {
        const shownIn = languageName(cross.shownLanguage);
        if (cross.kind === "value_differs") {
          return make({
            severity,
            status: "failed",
            expected: r.expectedValue,
            detected: cross.shown,
            explanation: `The disclaimer is shown in ${shownIn}, but with a different date or amount — legal wording must be exact.`,
            suggestedFix: `Show the disclaimer exactly as: "${r.expectedValue}".`,
          });
        }
        const decision = equivalentDecision(cross, r.mandatory, approved);
        if (decision === "human_check") {
          return make({
            severity,
            status: "unverified",
            expected: r.expectedValue,
            detected: cross.shown,
            explanation: `${severity === "critical" ? HUMAN_CHECK_CRITICAL : HUMAN_CHECK}: ${humanCheckReason(cross, r.mandatory)}`,
          });
        }
        return make({
          severity,
          status: "passed",
          expected: r.expectedValue,
          detected: cross.shown,
          explanation:
            decision === "pass_reference"
              ? `Present in ${shownIn} ("${cross.shown}"). The approved ${shownIn} version is checked as its own requirement.`
              : `Present in ${shownIn} ("${cross.shown}") — an approved equivalent of the brief's wording.`,
        });
      }
      const note = nearMiss ? equivalentNote(r.expectedValue, readings) : "";
      return make({
        severity,
        status: "failed",
        expected: r.expectedValue,
        detected: nearMiss ? close.found : "Not found",
        explanation:
          (close.status === "different"
            ? "The disclaimer appears with different numbers or details — legal wording must be exact."
            : close.status === "misspelt"
            ? "The disclaimer appears, but not word for word — legal wording must be exact."
            : `The disclaimer required by the brief isn't shown.${r.mandatory ? " The brief marks it as mandatory." : ""}`) + note,
        suggestedFix: `Show the disclaimer exactly as: "${r.expectedValue}".`,
      });
    };
    // Each finding carries its requirement's id, so the report can show that requirement's status.
    return disclaimers.map((r) => ({ ...checkDisclaimer(r), ...(r.id ? { requirementId: r.id } : {}) }));
  },
};

export const LEGAL_RULES: readonly Rule<QcContext>[] = [disclaimerRule];
