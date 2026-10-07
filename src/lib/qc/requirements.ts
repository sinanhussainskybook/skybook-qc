import { checkText } from "@/lib/company/validation";

/**
 * Requirement types — what the client asked for. This list is code, not a
 * database enum: the database accepts any key shaped like `lower_snake`,
 * so a new type is one line here and needs no migration.
 */

export const REQUIREMENT_TYPES = [
  { value: "headline", label: "Headline" },
  { value: "required_text", label: "Required text" },
  { value: "offer", label: "Offer" },
  { value: "price", label: "Price" },
  { value: "percentage", label: "Percentage" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "phone", label: "Phone number" },
  { value: "whatsapp", label: "WhatsApp number" },
  { value: "email", label: "Email" },
  { value: "website", label: "Website" },
  { value: "cta", label: "CTA (call to action)" },
  { value: "product_name", label: "Product name" },
  { value: "service_name", label: "Service name" },
  { value: "location", label: "Location" },
  { value: "disclaimer", label: "Disclaimer" },
  { value: "campaign_name", label: "Campaign name" },
  { value: "platform", label: "Platform" },
  { value: "dimensions", label: "Dimensions" },
  { value: "target_audience", label: "Target audience" },
  { value: "special_instruction", label: "Special instruction" },
  { value: "other", label: "Other" },
] as const;

export type RequirementTypeKey = string;

export function requirementTypeLabel(value: string): string {
  return REQUIREMENT_TYPES.find((type) => type.value === value)?.label ?? value.replace(/_/g, " ");
}

/** Where a requirement came from. `extracted` items (future AI / OCR) always start unconfirmed. */
export const REQUIREMENT_SOURCES = ["manual", "extracted"] as const;
export type RequirementSource = (typeof REQUIREMENT_SOURCES)[number];

export type RequirementInput = {
  type: string;
  label: string | null;
  expected_value: string;
  notes: string | null;
  mandatory: boolean;
  confirmed: boolean;
};

const MESSAGES = {
  type: "Choose what kind of requirement this is.",
};

/** Check a requirement typed by the designer. Only the listed fields are read. */
export function checkRequirement(
  read: (field: string) => string
): { ok: true; value: RequirementInput } | { ok: false; errors: Record<string, string> } {
  const type = read("type").trim();
  const typeOk = REQUIREMENT_TYPES.some((t) => t.value === type);
  const label = checkText(read("label"), { max: 120 });
  const expected = checkText(read("expected_value"), {
    max: 2000,
    multiline: true,
    required: true,
    label: "what the client asked for",
  });
  const notes = checkText(read("notes"), { max: 1000, multiline: true });

  if (!typeOk || !label.ok || !expected.ok || !notes.ok) {
    const errors: Record<string, string> = {};
    if (!typeOk) errors.type = MESSAGES.type;
    if (!label.ok) errors.label = label.error;
    if (!expected.ok) errors.expected_value = expected.error;
    if (!notes.ok) errors.notes = notes.error;
    return { ok: false, errors };
  }

  const flag = (name: string) => read(name) === "on" || read(name) === "true";
  return {
    ok: true,
    value: {
      type,
      label: label.value,
      expected_value: expected.value!,
      notes: notes.value,
      mandatory: flag("mandatory"),
      confirmed: flag("confirmed"),
    },
  };
}
