import { chroma, colorDifference, containsText, findName, isNeutral, NEUTRAL_CHROMA, sameFontFamily } from "@/lib/qc/compare";
import { allText } from "@/lib/qc/detections";
import type { Finding, Rule } from "@/lib/qc/findings";
import { ALL_TYPES, findingFor, NEEDS_ANALYSIS, notVerified, type QcContext } from "@/lib/qc/rules/context";

/**
 * Brand QC (plan 5.5): the content against the company's saved brand
 * guidelines (3.6) — colours, fonts, terminology, logo. Written guidelines
 * (tone, capitalisation, naming, logo rules, template notes) are free text:
 * they are listed as not verified for a person to check, never guessed.
 */

const CATEGORY = "brand" as const;

/** Colours within this ΔE of a brand colour count as that colour (app setting). */
export const BRAND_COLOR_TOLERANCE = 10;
/**
 * A text colour estimated from approximate text positions (Gemini) counts as off-brand only when it is
 * clearly so: more than this many times the tolerance from every brand colour and from grey (approved: 2×).
 */
export const TEXT_COLOR_CLEAR_CUT = 2;
/** A colour must cover at least this share of the frame to count as "used". */
export const MIN_COLOR_SHARE = 0.02;

const near = (hex: string, palette: string[]) =>
  palette.some((p) => (colorDifference(hex, p) ?? Infinity) <= BRAND_COLOR_TOLERANCE);

const colorsRule: Rule<QcContext> = {
  id: "brand.colors",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["brand colours (3.6)", "colours detected in the content"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    const palette = context.company.brand.colors.map((c) => c.hex);
    const names = context.company.brand.colors.map((c) => `${c.name} ${c.hex}`).join(", ");
    if (palette.length === 0) return [notVerified(this.id, CATEGORY, "Brand colours", "minor", "No brand colours are saved for this company. Add them on the company page.")];
    const d = context.detections;
    if (!d?.colors) return [notVerified(this.id, CATEGORY, "Brand colours", "minor", NEEDS_ANALYSIS, names)];
    const findings: Finding[] = [];

    const used = d.colors.filter((c) => c.share >= MIN_COLOR_SHARE && near(c.hex, palette));
    findings.push(
      findingFor(`${this.id}.present`, CATEGORY, "Brand colours used")({
        severity: "minor",
        status: used.length ? "passed" : "failed",
        expected: `At least one of: ${names}`,
        detected: d.colors.map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`).join(", ") || "No colours",
        explanation: used.length ? "The content uses the brand's colours." : "None of the brand colours appear in the content.",
        suggestedFix: "Use the brand colours for key elements such as headlines, buttons or backgrounds.",
      })
    );

    const offBrand = (d.texts ?? []).filter((t) => t.color && !isNeutral(t.color) && !near(t.color, palette));
    if (d.texts) {
      findings.push(
        ...(offBrand.length
          ? offBrand.map((t) =>
              findingFor(`${this.id}.text`, CATEGORY, "Text colour")({
                severity: "minor",
                status: "failed",
                expected: `A brand colour (${names}), black, white or grey`,
                detected: `${t.color} — "${t.text}"`,
                explanation: "This text uses a colour that isn't in the brand palette.",
                suggestedFix: "Change the text to a brand colour or a neutral.",
                confidence: t.confidence,
                fileId: t.fileId,
              })
            ).map((finding, i) => {
              // Measured from the colours inside the text's box: say how clear the failure is (policy.ts decides).
              const hex = offBrand[i].color!;
              const fromBrand = Math.min(...palette.map((p) => colorDifference(hex, p) ?? Infinity));
              const fromGrey = chroma(hex) ?? Infinity;
              const clearCut = fromBrand > TEXT_COLOR_CLEAR_CUT * BRAND_COLOR_TOLERANCE && fromGrey > TEXT_COLOR_CLEAR_CUT * NEUTRAL_CHROMA;
              return { ...finding, estimate: { value: Math.round(fromBrand * 10) / 10, limit: BRAND_COLOR_TOLERANCE, clearCut } };
            })
          : [
              findingFor(`${this.id}.text`, CATEGORY, "Text colour")({
                severity: "minor",
                status: "passed",
                detected: "Brand or neutral colours",
                explanation: "All text uses brand or neutral colours.",
              }),
            ])
      );
    }
    return findings;
  },
};

const fontsRule: Rule<QcContext> = {
  id: "brand.fonts",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["brand fonts (3.6)", "fonts detected in the content"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const approved = context.company.brand.fonts.map((f) => f.family);
    if (approved.length === 0) return [notVerified(this.id, CATEGORY, "Brand fonts", "major", "No brand fonts are saved for this company. Add them on the company page.")];
    const fonts = context.detections?.fonts;
    if (!fonts) return [notVerified(this.id, CATEGORY, "Brand fonts", "major", NEEDS_ANALYSIS, approved.join(", "))];
    const make = findingFor(this.id, CATEGORY, "Brand fonts");
    const wrong = fonts.filter((f) => !approved.some((a) => sameFontFamily(a, f.family)));
    if (wrong.length === 0) {
      return [make({ severity: "major", status: "passed", expected: approved.join(", "), detected: fonts.map((f) => f.family).join(", ") || "No text", explanation: "Only brand fonts are used." })];
    }
    return wrong.map((f) =>
      make({
        severity: "major",
        status: "failed",
        expected: approved.join(", "),
        detected: f.family,
        explanation: "This font isn't one of the brand fonts.",
        suggestedFix: `Use ${approved.join(" or ")}.`,
        confidence: f.confidence,
      })
    );
  },
};

const termsRule: Rule<QcContext> = {
  id: "brand.terms",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["approved / banned terms (3.6)", "text read from the content"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    const terms = context.company.brand.terms;
    if (terms.length === 0) return [notVerified(this.id, CATEGORY, "Terminology", "major", "No approved or banned terms are saved for this company.")];
    const text = allText(context.detections);
    if (text === null) return [notVerified(this.id, CATEGORY, "Terminology", "major", NEEDS_ANALYSIS)];
    const make = findingFor(this.id, CATEGORY, "Terminology");
    const findings: Finding[] = [];
    for (const term of terms) {
      if (term.kind === "banned" && containsText(text, term.term)) {
        findings.push(
          make({
            severity: "major",
            status: "failed",
            expected: `Not used: "${term.term}"`,
            detected: term.term,
            explanation: `"${term.term}" is a banned term for this brand.${term.note ? ` ${term.note}` : ""}`,
            suggestedFix: "Remove or reword it.",
          })
        );
      }
      if (term.kind === "approved") {
        const check = findName(text, term.term);
        if (check.status === "misspelt") {
          findings.push(
            make({
              severity: "major",
              status: "failed",
              expected: term.term,
              detected: check.found,
              explanation: "An approved brand term is written differently.",
              suggestedFix: `Write it exactly as "${term.term}".`,
            })
          );
        }
      }
    }
    return findings.length
      ? findings
      : [make({ severity: "major", status: "passed", detected: "No banned or misspelt terms", explanation: "Brand terminology is used correctly." })];
  },
};

const logoRule: Rule<QcContext> = {
  id: "brand.logo",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["company logo (3.5)", "logo detected in the content"],
  defaultSeverity: "major",
  mandatory: false,
  run(context) {
    if (!context.company.logo) return [notVerified(this.id, CATEGORY, "Logo", "major", "No logo is saved for this company, so there's nothing to compare with.")];
    const logo = context.detections?.logo;
    if (!logo) return [notVerified(this.id, CATEGORY, "Logo", "major", NEEDS_ANALYSIS, "The company's logo")];
    const make = findingFor(this.id, CATEGORY, "Logo");
    if (!logo.present) {
      return [make({ severity: "major", status: "failed", expected: "The company's logo", detected: "No logo", explanation: "The company's logo doesn't appear in the content.", suggestedFix: "Add the company's current logo.", confidence: logo.confidence })];
    }
    if (logo.matchesCompanyLogo === false) {
      return [make({ severity: "critical", status: "failed", expected: "The company's logo", detected: "A different logo", explanation: "The logo shown isn't this company's saved logo.", suggestedFix: "Replace it with the company's current logo from the company page.", confidence: logo.confidence })];
    }
    return [make({ severity: "major", status: "passed", expected: "The company's logo", detected: logo.matchesCompanyLogo ? "The company's logo" : "A logo", explanation: logo.matchesCompanyLogo ? "The company's logo is shown." : "A logo is shown; whether it's the right one wasn't compared.", confidence: logo.confidence })];
  },
};

const GUIDELINE_FIELDS = [
  ["tone", "Tone of voice"],
  ["capitalization_rules", "Capitalisation"],
  ["naming_conventions", "Naming conventions"],
  ["logo_rules", "Logo rules"],
  ["template_notes", "Template notes"],
  ["other_guidelines", "Other guidelines"],
] as const;

const writtenGuidelinesRule: Rule<QcContext> = {
  id: "brand.written_guidelines",
  category: CATEGORY,
  appliesTo: ALL_TYPES,
  needs: ["written brand guidelines (3.6)", "a person's review"],
  defaultSeverity: "minor",
  mandatory: false,
  run(context) {
    return GUIDELINE_FIELDS.filter(([key]) => context.company.brand[key]?.trim()).map(([key, label]) =>
      notVerified(
        `${this.id}.${key}`,
        CATEGORY,
        label,
        "minor",
        "This guideline is written in words, so it isn't checked automatically — review it by eye.",
        context.company.brand[key]!
      )
    );
  },
};

export const BRAND_RULES: readonly Rule<QcContext>[] = [colorsRule, fontsRule, termsRule, logoRule, writtenGuidelinesRule];
