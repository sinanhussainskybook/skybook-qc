import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  Image as ImageIcon,
  Palette,
  Phone,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { EditableField, EditableFieldList } from "@/components/company/editable-field";
import { ListEditor } from "@/components/company/list-editor";
import { LogoManager } from "@/components/company/logo-manager";
import { DeleteCompany } from "@/components/company/delete-company";
import { SectionCard, SubSection } from "@/components/company/section-card";
import { Badge } from "@/components/ui/badge";
import { StartQcButton } from "@/components/qc/start-qc-button";
import { requireCompanyAccess } from "@/lib/company/access";
import { FIELD_SECTIONS } from "@/lib/company/fields";
import { getDatabase } from "@/lib/db/client";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { logoImageUrl } from "@/lib/company/logo";
import { getLogoStorage } from "@/lib/storage/logo-storage";

export const metadata: Metadata = { title: "Company · Skybook AI QC" };

const NAV = [
  { href: "#information", label: "Information" },
  { href: "#contact", label: "Contact" },
  { href: "#logos", label: "Logo" },
  { href: "#brand", label: "Brand guidelines" },
  { href: "#golden-rules", label: "Golden Rules" },
];

/**
 * One company: the main action first — Start a QC check — and its saved
 * configuration (information, contact, logo, brand guidelines, Golden Rules)
 * folded away under "Company settings". Every value has its own Edit, and
 * every save is checked on the server for this company (D13).
 */
export default async function CompanyPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const { user, company } = await requireCompanyAccess(companyId);
  const config = await loadCompanyConfiguration(getDatabase(), company);
  const { contact, brand, goldenRules, logo } = config;
  const storage = getLogoStorage();
  const logoUrl = await logoImageUrl(storage, logo);
  const place = [company.city, company.country].filter(Boolean).join(", ");
  const activeRules = goldenRules.filter((rule) => rule.active);
  const mandatoryRules = activeRules.filter((rule) => rule.mandatory);

  const fields = (
    section: "info" | "contact" | "brand",
    values: object,
    only?: string[]
  ) =>
    (only ?? Object.keys(FIELD_SECTIONS[section])).map((field) => {
      const value = (values as Record<string, unknown>)[field];
      return (
        <EditableField
          key={field}
          companyId={company.id}
          section={section}
          field={field}
          value={typeof value === "string" ? value : null}
        />
      );
    });

  return (
    <AppShell
      user={user}
      hero={
        <>
          <Link href="/" className="hero-glass text-sm">
            <ArrowLeft className="size-4" aria-hidden />
            All companies
          </Link>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <h1 className="display max-w-full text-4xl break-words sm:text-6xl">{company.name}</h1>
            {!company.active && <Badge variant="outline" className="hero-glass">Inactive</Badge>}
          </div>
          <p className="mt-4 max-w-xl text-muted-foreground sm:text-lg">
            Upload the client&apos;s brief and the design — the design is checked against the brief and this company&apos;s brand rules.
          </p>
          <div className="mt-8">
            <StartQcButton companyId={company.id} className="btn-glossy" />
          </div>
        </>
      }
    >
      <details id="settings" className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-semibold tracking-tight">Company settings</span>
            <span className="block text-sm text-muted-foreground">
              {[company.category, place].filter(Boolean).join(" · ") || "Information"} · contact · logo · brand guidelines · Golden Rules — used in every check
            </span>
          </span>
          <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>

      <nav aria-label="Company sections" className="mt-6 -mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2">
          {NAV.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="block rounded-full border border-border px-3.5 py-1.5 text-sm whitespace-nowrap hover:border-primary/40 hover:text-primary"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-6 space-y-6">
        <SectionCard
          id="information"
          title="Company information"
          description="Who the company is. Saved permanently and used in every QC check."
          icon={Building2}
        >
          <EditableFieldList>{fields("info", company)}</EditableFieldList>
        </SectionCard>

        <SectionCard
          id="contact"
          title="Contact information"
          description="QC will compare these with what appears in the design."
          icon={Phone}
        >
          <EditableFieldList>{fields("contact", contact)}</EditableFieldList>
        </SectionCard>

        <SectionCard
          id="logos"
          title="Logo"
          description="The company's current logo. Only one is kept — replacing it deletes the old file."
          icon={ImageIcon}
        >
          <LogoManager
            companyId={company.id}
            logo={
              logo
                ? { file_name: logo.file_name, mime_type: logo.mime_type, file_size: logo.file_size }
                : null
            }
            imageUrl={logoUrl}
            storageReady={storage !== null}
          />
        </SectionCard>

        <SectionCard
          id="brand"
          title="Brand guidelines"
          description="The rules this company's content must follow."
          icon={Palette}
        >
          <div className="space-y-6">
            <SubSection title="Colours" description="Approved brand colours.">
              <ListEditor
                kind="brand_colors"
                companyId={company.id}
                items={brand.colors}
                emptyText="No colours yet."
              />
            </SubSection>
            <SubSection title="Typography" description="Approved fonts, weights and sizes.">
              <ListEditor
                kind="brand_fonts"
                companyId={company.id}
                items={brand.fonts}
                emptyText="No fonts yet."
              />
            </SubSection>
            <SubSection
              title="Terminology"
              description="Words and names to use — and ones never to use."
            >
              <ListEditor
                kind="brand_terms"
                companyId={company.id}
                items={brand.terms}
                emptyText="No terms yet."
              />
              <div className="mt-3">
                <EditableFieldList>
                  {fields("brand", brand, ["capitalization_rules", "naming_conventions"])}
                </EditableFieldList>
              </div>
            </SubSection>
            <SubSection title="Tone and other guidelines">
              <EditableFieldList>
                {fields("brand", brand, ["tone", "logo_rules", "template_notes", "other_guidelines"])}
              </EditableFieldList>
            </SubSection>
          </div>
        </SectionCard>

        <SectionCard
          id="golden-rules"
          title="Golden Rules"
          description={`Non-negotiable rules for this company. ${activeRules.length} switched on, ${mandatoryRules.length} of them mandatory. Applied automatically to every QC check.`}
          icon={ShieldCheck}
        >
          <ListEditor
            kind="golden_rules"
            companyId={company.id}
            items={goldenRules}
            emptyText="No Golden Rules yet. Add the rules this company never compromises on."
          />
        </SectionCard>
      </div>
      </details>

      {user.role === "admin" && (
        <section aria-labelledby="delete-company-title" className="mt-12 border-t border-border pt-6">
          <h2 id="delete-company-title" className="text-lg font-semibold tracking-tight">Delete company</h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">Administrators only. Removes the company and everything saved for it.</p>
          <DeleteCompany company={{ id: company.id, name: company.name }} />
        </section>
      )}
    </AppShell>
  );
}
