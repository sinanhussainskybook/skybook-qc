import Link from "next/link";
import { Plus } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { SearchableCompanyList } from "@/components/company/company-search";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The home page's list of companies the user may open, each with its logo when it has one. */
export function CompanyList({
  companies,
  logoUrls = {},
}: {
  companies: CompanySummary[];
  /** Links to show the logos, by company ID (see companyLogoUrls). */
  logoUrls?: Record<string, string>;
}) {
  if (companies.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border px-6 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">No companies yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Add the first company, then fill in its information, brand guidelines and Golden Rules. They are saved for every future QC check.
        </p>
        <Link href="/companies/new" className={cn(buttonVariants(), "btn-glossy mt-6 h-10 rounded-full px-5")}>
          <Plus aria-hidden />
          Add company
        </Link>
      </div>
    );
  }

  return <SearchableCompanyList companies={companies} logoUrls={logoUrls} />;
}
