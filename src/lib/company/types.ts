import type { CompanyLogo } from "@/lib/db/company-logos";

/**
 * Shapes of a company's saved information, as read from the database.
 * Keys match the column names (see db/migrations/0002_companies.sql).
 */

export type Company = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type CompanySummary = Pick<
  Company,
  "id" | "name" | "category" | "city" | "country" | "active" | "updated_at"
>;

export type CompanyContact = {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  website: string | null;
};

export type BrandProfile = {
  tone: string | null;
  capitalization_rules: string | null;
  naming_conventions: string | null;
  logo_rules: string | null;
  template_notes: string | null;
  other_guidelines: string | null;
};

type Timestamps = { created_at: Date; updated_at: Date };

export type BrandColor = Timestamps & {
  id: string;
  name: string;
  hex: string;
  cmyk: string | null;
  usage: string | null;
};

export type BrandFont = Timestamps & {
  id: string;
  family: string;
  weights: string | null;
  usage: string | null;
  size_guidance: string | null;
};

export type BrandTerm = Timestamps & {
  id: string;
  term: string;
  kind: "approved" | "banned";
  note: string | null;
};

export type GoldenRuleCategory =
  | "mandatory_disclaimer"
  | "approved_product_name"
  | "approved_cta"
  | "logo_rule"
  | "approved_color"
  | "approved_font"
  | "other";

export type GoldenRule = Timestamps & {
  id: string;
  rule: string;
  category: GoldenRuleCategory;
  approved_value: string | null;
  mandatory: boolean;
  active: boolean;
};

export type ListItems = {
  brand_colors: BrandColor[];
  brand_fonts: BrandFont[];
  brand_terms: BrandTerm[];
  golden_rules: GoldenRule[];
};

/** Everything saved about one company — what the QC engine will read (Phase 5). */
export type CompanyConfiguration = {
  company: Company;
  contact: CompanyContact;
  /** Metadata only; the file is in Supabase Storage (D3). */
  logo: CompanyLogo | null;
  brand: BrandProfile & {
    colors: BrandColor[];
    fonts: BrandFont[];
    terms: BrandTerm[];
  };
  goldenRules: GoldenRule[];
};
