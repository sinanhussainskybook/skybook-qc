import {
  checkChoice,
  checkCmyk,
  checkCompanyName,
  checkContactEmail,
  checkHex,
  checkPhone,
  checkText,
  checkWebsite,
  checkWhatsApp,
  type Checked,
} from "@/lib/company/validation";

/**
 * Every field a person can edit on the company page, in one place.
 *
 * The server only accepts fields listed here (so a forged form can't write
 * to any other column), checks each with its `check`, and the page uses the
 * labels and hints. Field keys are the database column names.
 */

export type FieldKind = "text" | "textarea" | "email" | "tel" | "url" | "select" | "checkbox";

export type Choice = { value: string; label: string };

export type FieldSpec = {
  label: string;
  kind: FieldKind;
  maxLength?: number;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  choices?: readonly Choice[];
  check: (raw: string) => Checked<string | boolean | null>;
};

const text = (label: string, max: number, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  label,
  kind: "text",
  maxLength: max,
  check: (raw) => checkText(raw, { max, required: extra.required, label: label.toLowerCase() }),
  ...extra,
});

const textarea = (label: string, max: number, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  label,
  kind: "textarea",
  maxLength: max,
  check: (raw) =>
    checkText(raw, { max, multiline: true, required: extra.required, label: label.toLowerCase() }),
  ...extra,
});

// ---------------------------------------------------------------------------
// Single fields, edited one at a time
// ---------------------------------------------------------------------------

export const FIELD_SECTIONS = {
  /** Table `companies`. */
  info: {
    name: {
      label: "Company name",
      kind: "text",
      maxLength: 120,
      required: true,
      check: checkCompanyName,
    },
    description: textarea("Description", 2000, {
      hint: "What the company does, in a sentence or two.",
    }),
    category: text("Company type / category", 100, {
      placeholder: "e.g. Real estate, Restaurant, Clinic",
    }),
    country: text("Country", 100),
    city: text("City", 100),
    address: textarea("Address", 500),
  },

  /** Table `company_contacts`. */
  contact: {
    phone: {
      label: "Phone",
      kind: "tel",
      maxLength: 40,
      placeholder: "+971 4 123 4567",
      hint: "Saved exactly as you type it.",
      check: checkPhone,
    },
    additional_phone: {
      label: "Additional phone",
      kind: "tel",
      maxLength: 40,
      placeholder: "+971 4 765 4321",
      hint: "Optional. A second number; saved exactly as you type it.",
      check: checkPhone,
    },
    whatsapp: {
      label: "WhatsApp",
      kind: "tel",
      maxLength: 40,
      placeholder: "+971 50 123 4567",
      hint: "Start with + and the country code.",
      check: checkWhatsApp,
    },
    email: {
      label: "Email",
      kind: "email",
      maxLength: 254,
      placeholder: "hello@company.com",
      check: checkContactEmail,
    },
    website: {
      label: "Website",
      kind: "url",
      maxLength: 2048,
      placeholder: "company.com",
      hint: "Saved as a full https:// address. The site is not visited.",
      check: checkWebsite,
    },
  },

  /** Table `brand_profiles`. */
  brand: {
    tone: textarea("Brand tone / voice", 2000, {
      hint: "How the brand should sound, e.g. warm, confident, never slangy.",
    }),
    capitalization_rules: textarea("Capitalisation rules", 2000, {
      hint: "e.g. Headlines in sentence case. Product names always capitalised.",
    }),
    naming_conventions: textarea("Naming conventions", 2000, {
      hint: "How the company and its products must be written.",
    }),
    logo_rules: textarea("Logo rules", 2000, {
      hint: "Minimum size, clear space, placement. (The logo file itself is under Logo.)",
    }),
    template_notes: textarea("Template notes", 2000),
    other_guidelines: textarea("Other guidelines", 5000, {
      hint: "Anything else designers must follow.",
    }),
  },
} as const satisfies Record<string, Record<string, FieldSpec>>;

export type FieldSection = keyof typeof FIELD_SECTIONS;

export function findFieldSpec(section: string, field: string): FieldSpec | null {
  if (!Object.hasOwn(FIELD_SECTIONS, section)) return null;
  const fields: Record<string, FieldSpec> = FIELD_SECTIONS[section as FieldSection];
  return Object.hasOwn(fields, field) ? fields[field] : null;
}

// ---------------------------------------------------------------------------
// Lists: many items per company, each added / edited / removed
// ---------------------------------------------------------------------------

export const TERM_KINDS = [
  { value: "approved", label: "Approved — use this" },
  { value: "banned", label: "Banned — never use" },
] as const satisfies readonly Choice[];

export const GOLDEN_RULE_CATEGORIES = [
  { value: "mandatory_disclaimer", label: "Mandatory disclaimer" },
  { value: "approved_product_name", label: "Approved product name" },
  { value: "approved_cta", label: "Approved CTA" },
  { value: "logo_rule", label: "Logo rule" },
  { value: "approved_color", label: "Approved colour" },
  { value: "approved_font", label: "Approved font" },
  { value: "other", label: "Other" },
] as const satisfies readonly Choice[];

const checkbox = (label: string, hint?: string): FieldSpec => ({
  label,
  kind: "checkbox",
  hint,
  check: (raw) => ({ ok: true, value: raw === "on" || raw === "true" }),
});

export const LIST_SPECS = {
  brand_colors: {
    singular: "colour",
    fields: {
      name: text("Colour name", 60, { required: true, placeholder: "e.g. Skybook Blue" }),
      hex: {
        label: "HEX",
        kind: "text",
        maxLength: 7,
        required: true,
        placeholder: "#1A64B4",
        check: checkHex,
      },
      cmyk: {
        label: "CMYK (optional)",
        kind: "text",
        maxLength: 30,
        placeholder: "85, 45, 0, 29",
        hint: "For print. RGB is worked out from the HEX automatically.",
        check: checkCmyk,
      },
      usage: text("Where it is used (optional)", 200, { placeholder: "e.g. Headlines, buttons" }),
    },
  },
  brand_fonts: {
    singular: "font",
    fields: {
      family: text("Font family", 100, { required: true, placeholder: "e.g. Montserrat" }),
      weights: text("Weights / styles", 200, { placeholder: "e.g. Regular 400, Bold 700" }),
      usage: text("Used for", 200, { placeholder: "e.g. Headlines" }),
      size_guidance: text("Size guidance (optional)", 200, {
        placeholder: "e.g. Body text at least 16 px",
      }),
    },
  },
  brand_terms: {
    singular: "term",
    fields: {
      term: text("Term", 200, { required: true, placeholder: "e.g. SkyBook Pro" }),
      kind: {
        label: "Type",
        kind: "select",
        required: true,
        choices: TERM_KINDS,
        check: (raw) => checkChoice(raw, TERM_KINDS, "approved or banned"),
      },
      note: text("Note (optional)", 300, { placeholder: "e.g. Never write “Skybook pro”" }),
    },
  },
  golden_rules: {
    singular: "Golden Rule",
    fields: {
      rule: textarea("Rule", 1000, {
        required: true,
        placeholder: "e.g. Every post must include the licence disclaimer.",
      }),
      category: {
        label: "Category",
        kind: "select",
        required: true,
        choices: GOLDEN_RULE_CATEGORIES,
        check: (raw) => checkChoice(raw, GOLDEN_RULE_CATEGORIES, "a category"),
      },
      approved_value: textarea("Approved value (optional)", 1000, {
        hint: "The exact wording, name, colour or font that must be used, if there is one.",
      }),
      mandatory: checkbox(
        "Mandatory",
        "Breaking a mandatory rule will be a critical issue in QC."
      ),
    },
  },
} as const satisfies Record<string, { singular: string; fields: Record<string, FieldSpec> }>;

export type ListKind = keyof typeof LIST_SPECS;

export const LIST_KINDS = Object.keys(LIST_SPECS) as ListKind[];

export function isListKind(value: unknown): value is ListKind {
  return typeof value === "string" && Object.hasOwn(LIST_SPECS, value);
}

export type ListValues = Record<string, string | boolean | null>;

/** Check every field of a list item. Only the listed fields are read. */
export function checkListItem(
  kind: ListKind,
  read: (field: string) => string
): { ok: true; values: ListValues } | { ok: false; errors: Record<string, string> } {
  const values: ListValues = {};
  const errors: Record<string, string> = {};
  for (const [field, spec] of Object.entries(LIST_SPECS[kind].fields) as [string, FieldSpec][]) {
    const result = spec.check(read(field));
    if (result.ok) values[field] = result.value;
    else errors[field] = result.error;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

export function choiceLabel(choices: readonly Choice[], value: string): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}
