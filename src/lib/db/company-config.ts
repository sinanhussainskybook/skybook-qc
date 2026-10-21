import type { Database } from "@/lib/db/database";
import { listItems } from "@/lib/db/company-lists";
import { getCompanyLogo } from "@/lib/db/company-logos";
import type {
  BrandProfile,
  Company,
  CompanyConfiguration,
  CompanyContact,
} from "@/lib/company/types";

/**
 * A company's complete saved configuration: information, contact details,
 * logo metadata, brand guidelines and Golden Rules.
 *
 * The company page reads it, and from Phase 5 the QC engine will too —
 * it is the one place company data is read from. The caller must already
 * have checked the user may open the company (requireCompanyAccess).
 */

const EMPTY_CONTACT: CompanyContact = { phone: null, additional_phone: null, whatsapp: null, email: null, website: null };

const EMPTY_BRAND: BrandProfile = {
  tone: null,
  capitalization_rules: null,
  naming_conventions: null,
  logo_rules: null,
  template_notes: null,
  other_guidelines: null,
};

export async function loadCompanyConfiguration(
  db: Database,
  company: Company
): Promise<CompanyConfiguration> {
  const [contactRows, brandRows, colors, fonts, terms, goldenRules, logo] = await Promise.all([
    db.query<CompanyContact>(
      "select phone, additional_phone, whatsapp, email, website from company_contacts where company_id = $1",
      [company.id]
    ),
    db.query<BrandProfile>(
      `select tone, capitalization_rules, naming_conventions, logo_rules, template_notes, other_guidelines
         from brand_profiles where company_id = $1`,
      [company.id]
    ),
    listItems(db, "brand_colors", company.id),
    listItems(db, "brand_fonts", company.id),
    listItems(db, "brand_terms", company.id),
    listItems(db, "golden_rules", company.id),
    getCompanyLogo(db, company.id),
  ]);

  return {
    company,
    contact: contactRows[0] ?? EMPTY_CONTACT,
    logo,
    brand: { ...(brandRows[0] ?? EMPTY_BRAND), colors, fonts, terms },
    goldenRules,
  };
}
