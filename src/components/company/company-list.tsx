import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { CompanyAvatar } from "@/components/company/company-avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const addCompanyButtonClass = cn(buttonVariants({ variant: "outline" }), "h-10 rounded-full px-4");

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

  // One company per row, the whole row one link to its page: a large logo, the name with its full type and
  // place, and an arrow.
  return (
    <ul className="grid gap-3">
      {companies.map((company) => {
        const place = [company.city, company.country].filter(Boolean).join(", ");
        return (
          <li key={company.id}>
            <Link
              href={`/companies/${company.id}`}
              className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-3 shadow-[0_8px_24px_-18px_rgb(15_27_45/0.35)] transition-all outline-none hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_16px_40px_-24px_rgb(15_27_45/0.35)] focus-visible:ring-3 focus-visible:ring-ring/50 sm:gap-5 sm:p-4"
            >
              <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-xl bg-muted/60 p-2 sm:h-[76px] sm:w-36">
                <CompanyAvatar name={company.name} logoUrl={logoUrls[company.id]} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-base font-semibold group-hover:text-primary">{company.name}</span>
                  {!company.active && <Badge variant="outline">Inactive</Badge>}
                </span>
                <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{company.category || (place ? "" : "No details yet")}</span>
                {place && (
                  <span className="mt-1.5 block">
                    <span className="inline-flex rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">{place}</span>
                  </span>
                )}
              </span>
              <ArrowUpRight
                className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary"
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
