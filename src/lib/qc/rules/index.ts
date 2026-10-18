import type { ContentDetections } from "@/lib/qc/detections";
import type { Rule } from "@/lib/qc/findings";
import type { QcInput } from "@/lib/qc/qc-input";
import { formatForMime } from "@/lib/qc/qc-file";
import { ACCESSIBILITY_RULES } from "@/lib/qc/rules/accessibility";
import { BRAND_RULES } from "@/lib/qc/rules/brand";
import { BRIEF_RULES } from "@/lib/qc/rules/brief";
import { CONTENT_RULES } from "@/lib/qc/rules/content";
import type { QcContext } from "@/lib/qc/rules/context";
import { GOLDEN_RULES } from "@/lib/qc/rules/golden-rules";
import { IMAGE_RULES } from "@/lib/qc/rules/image-asset";
import { LAYOUT_RULES } from "@/lib/qc/rules/layout";
import { LEGAL_RULES } from "@/lib/qc/rules/legal";
import { platformSizeRule, type PlacedElement, type PlatformContext } from "@/lib/qc/rules/platform-size";

/** Text and logo positions for the safe-zone check; undefined when not analysed. */
function placedElements(d: ContentDetections | null): PlacedElement[] | undefined {
  if (!d?.texts) return undefined;
  const elements: PlacedElement[] = d.texts
    .filter((t) => t.box)
    .map((t) => ({ label: `"${t.text.length > 30 ? `${t.text.slice(0, 30)}…` : t.text}"`, box: t.box!, fileId: t.fileId, confidence: t.confidence }));
  if (d.logo?.present && d.logo.box) elements.push({ label: "Logo", box: d.logo.box, confidence: d.logo.confidence });
  return elements;
}

/**
 * Every QC rule, all nine categories, run by the one engine
 * (`runRules(QC_RULES, contentType, context)`) for all four content types —
 * video checks are rules that apply only to the video types.
 */
export const QC_RULES: readonly Rule<QcContext>[] = [
  ...CONTENT_RULES,
  ...BRAND_RULES,
  ...GOLDEN_RULES,
  ...LAYOUT_RULES,
  ...ACCESSIBILITY_RULES,
  ...IMAGE_RULES,
  ...BRIEF_RULES,
  { ...platformSizeRule, run: (context) => platformSizeRule.run({ ...context.platform, elements: placedElements(context.detections) }) },
  ...LEGAL_RULES,
];

/** The platform part of the context, from the engine input (lib/qc/qc-input.ts). */
export function platformContextFromInput(input: QcInput): PlatformContext {
  return {
    platform: input.session.platform,
    placement: input.session.placement,
    custom: input.session.custom,
    files: input.contentFiles.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      format: formatForMime(f.mimeType),
      size: f.fileSize,
      media: f.media,
    })),
  };
}

/**
 * The engine's context for one session. `detections` is null until Phase 6
 * reads the content; every check that needs it then reports NOT VERIFIED.
 */
export function qcContextOf(input: QcInput, detections: ContentDetections | null): QcContext {
  return {
    contentType: input.session.contentType,
    company: input.company,
    requirements: input.requirements,
    platform: platformContextFromInput(input),
    detections,
  };
}
