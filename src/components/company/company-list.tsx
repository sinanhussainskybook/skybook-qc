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

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {companies.map((company) => {
        const place = [company.city, company.country].filter(Boolean).join(", ");
        return (
          <li key={company.id}>
            <Link
              href={`/companies/${company.id}`}
              className="group flex h-full items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-[0_8px_24px_-18px_rgb(15_27_45/0.35)] transition-all outline-none hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_16px_40px_-24px_rgb(15_27_45/0.35)] focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <CompanyAvatar name={company.name} logoUrl={logoUrls[company.id]} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold">{company.name}</span>
                  {!company.active && <Badge variant="outline">Inactive</Badge>}
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                  {[company.category, place].filter(Boolean).join(" · ") || "No details yet"}
                </span>
              </span>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
