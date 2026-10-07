/**
 * Fixture inputs for the QC rules (plan Phase 5: "the detections come from
 * test fixtures; Phase 6 supplies real ones").
 */
import type { CompanyConfiguration, GoldenRule } from "@/lib/company/types";
import type { ContentType } from "@/lib/qc/content-types";
import type { ContentDetections, DetectedText } from "@/lib/qc/detections";
import { runRules } from "@/lib/qc/engine";
import type { Finding } from "@/lib/qc/findings";
import type { QcInputRequirement } from "@/lib/qc/qc-input";
import type { QcContext } from "@/lib/qc/rules/context";
import { QC_RULES } from "@/lib/qc/rules";

const now = new Date("2026-10-01T10:00:00Z");
const stamps = { created_at: now, updated_at: now };
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export function company(over: Partial<CompanyConfiguration> = {}): CompanyConfiguration {
  return {
    company: { id: "c0000000-0000-4000-8000-000000000001", name: "Skybook Villas", description: null, category: null, country: null, city: null, address: null, active: true, ...stamps },
    contact: { phone: "+971 4 123 4567", whatsapp: "+971 50 765 4321", email: "sales@skybookvillas.com", website: "https://skybookvillas.com" },
    logo: { id: id(), file_name: "logo.png", storage_path: "x/logo.png", mime_type: "image/png", file_size: 100, ...stamps },
    brand: {
      tone: null,
      capitalization_rules: null,
      naming_conventions: null,
      logo_rules: null,
      template_notes: null,
      other_guidelines: null,
      colors: [
        { id: id(), name: "Skybook Blue", hex: "#1A64B4", cmyk: null, usage: null, ...stamps },
        { id: id(), name: "Sun", hex: "#F4B400", cmyk: null, usage: null, ...stamps },
      ],
      fonts: [{ id: id(), family: "Montserrat", weights: null, usage: null, size_guidance: null, ...stamps }],
      terms: [
        { id: id(), term: "Skybook Villas", kind: "approved", note: null, ...stamps },
        { id: id(), term: "cheap", kind: "banned", note: "Say 'great value'.", ...stamps },
      ],
    },
    goldenRules: [],
    ...over,
  } as CompanyConfiguration;
}

export function golden(over: Partial<GoldenRule> & Pick<GoldenRule, "category">): GoldenRule {
  return { id: id(), rule: `Rule ${over.category}`, approved_value: null, mandatory: true, active: true, ...stamps, ...over };
}

export function requirement(type: string, expectedValue: string, over: Partial<QcInputRequirement> = {}): QcInputRequirement {
  return { type, label: null, expectedValue, notes: null, mandatory: true, source: "manual", ...over };
}

export const text = (value: string, over: Partial<DetectedText> = {}): DetectedText => ({ text: value, confidence: 0.95, ...over });

export function detections(over: Partial<ContentDetections> = {}): ContentDetections {
  return { source: "fixture", frame: { width: 1080, height: 1350 }, texts: [], ...over };
}

export function context(over: Partial<QcContext> = {}): QcContext {
  return {
    contentType: "social_post",
    company: company(),
    requirements: [],
    platform: { platform: null, placement: null, custom: null, files: [] },
    detections: null,
    ...over,
  };
}

/** Runs every registered rule — the same call the app makes. */
export const run = (over: Partial<QcContext> = {}, contentType: ContentType = over.contentType ?? "social_post") =>
  runRules(QC_RULES, contentType, context({ ...over, contentType }));

export const byRule = (findings: Finding[], prefix: string) => findings.filter((f) => f.ruleId === prefix || f.ruleId.startsWith(`${prefix}.`));
export const only = (findings: Finding[], prefix: string) => {
  const found = byRule(findings, prefix);
  if (found.length !== 1) throw new Error(`${prefix}: expected 1 finding, got ${found.length}: ${JSON.stringify(found.map((f) => [f.ruleId, f.status, f.detected]))}`);
  return found[0];
};
