import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Image as ImageIcon,
  Palette,
  Phone,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { EditableField, EditableFieldList } from "@/components/company/editable-field";
import { ListEditor } from "@/components/company/list-editor";
import { LogoManager } from "@/components/company/logo-manager";
import { SectionCard, SubSection } from "@/components/company/section-card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requireCompanyAccess } from "@/lib/company/access";
import { FIELD_SECTIONS } from "@/lib/company/fields";
import { getDatabase } from "@/lib/db/client";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { logoImageUrl } from "@/lib/company/logo";
import { getLogoStorage } from "@/lib/storage/logo-storage";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Company · Skybook AI QC" };

const NAV = [
  { href: "#information", label: "Information" },
  { href: "#contact", label: "Contact" },
  { href: "#logos", label: "Logo" },
  { href: "#brand", label: "Brand guidelines" },
  { href: "#golden-rules", label: "Golden Rules" },
];

/**
 * One company's saved configuration. Every value has its own Edit, and
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
    <AppShell user={user}>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All companies
      </Link>

      <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">
              {company.name}
            </h1>
            {!company.active && <Badge variant="outline">Inactive</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[company.category, place].filter(Boolean).join(" · ") ||
              "Add the company's details below."}
          </p>
        </div>
        <Link
          href={`/companies/${company.id}/qc/new`}
          className={cn(
            buttonVariants(),
            "h-11 rounded-full bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/85"
          )}
        >
          Start QC
          <ArrowRight aria-hidden />
        </Link>
      </header>

      <nav aria-label="Company sections" className="mt-6 -mx-4 overflow-x-auto px-4">
        <ul className="flex gap-2">
          {NAV.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="block rounded-full bg-card px-3.5 py-1.5 text-sm whitespace-nowrap ring-1 ring-border hover:bg-secondary hover:text-secondary-foreground"
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
          description={`Non-negotiable rules for this company. ${activeRules.length} switched on, ${mandatoryRules.length} of them mandatory. They will be applied automatically to every QC check (from Phase 5).`}
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
    </AppShell>
  );
}
