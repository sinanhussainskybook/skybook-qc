import Link from "next/link";
import { Building2, ChevronRight, Plus } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const addCompanyButtonClass = cn(
  buttonVariants(),
  "h-10 rounded-full bg-foreground px-4 text-background hover:bg-foreground/85"
);

/** The dashboard's list of companies the user may open. */
export function CompanyList({ companies }: { companies: CompanySummary[] }) {
  if (companies.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground">
          <Building2 className="size-5" aria-hidden />
        </span>
        <h2 className="mt-4 text-lg font-semibold">No companies yet</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Add the first company, then fill in its information, brand guidelines and Golden
          Rules. They are saved for every future QC check.
        </p>
        <Link href="/companies/new" className={cn(addCompanyButtonClass, "mt-6")}>
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
              className="group flex h-full items-start gap-3 rounded-2xl bg-card p-5 ring-1 ring-foreground/8 transition-shadow outline-none hover:shadow-[0_12px_32px_-16px_rgb(15_27_45/0.25)] hover:ring-primary/30 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-sm font-semibold text-secondary-foreground uppercase">
                {company.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold">{company.name}</span>
                  {!company.active && <Badge variant="outline">Inactive</Badge>}
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                  {[company.category, place].filter(Boolean).join(" · ") || "No details yet"}
                </span>
              </span>
              <ChevronRight
                className="mt-2.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
