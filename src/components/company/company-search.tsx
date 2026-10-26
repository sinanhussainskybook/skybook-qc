"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { CompanyAvatar } from "@/components/company/company-avatar";
import { Badge } from "@/components/ui/badge";

/** Whether a company matches what was typed: its name, type, city or country, ignoring capitals. */
export function companyMatches(company: CompanySummary, term: string): boolean {
  const words = term.trim().toLowerCase();
  if (!words) return true;
  return [company.name, company.category, company.city, company.country].some((text) => text?.toLowerCase().includes(words));
}

/**
 * Home's company list with a small dark-glass search box in its top-right corner. The rows filter as you
 * type; pressing "/" anywhere on the page jumps to the box.
 */
export function SearchableCompanyList({ companies, logoUrls }: { companies: CompanySummary[]; logoUrls: Record<string, string> }) {
  const [term, setTerm] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const shown = companies.filter((company) => companyMatches(company, term));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']");
      if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold">
          Companies
          <span className="ml-2 text-sm font-medium text-muted-foreground" aria-live="polite">
            {term.trim() ? `${shown.length} of ${companies.length} shown` : companies.length}
          </span>
        </h2>
        <label className="flex h-10 w-full items-center gap-2 rounded-full border border-white/30 bg-[#050b1e]/45 px-3.5 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] backdrop-blur-md transition-colors focus-within:border-[#9cc2ff]/80 focus-within:ring-3 focus-within:ring-blue-500/40 sm:w-72">
          <Search className="size-4 shrink-0 text-white/80" aria-hidden />
          <input
            ref={input}
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search companies"
            aria-label="Search companies"
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/65"
          />
          <kbd className="rounded-md border border-white/25 bg-white/10 px-1.5 font-mono text-[11px] text-white" aria-hidden>
            /
          </kbd>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No company matches &ldquo;{term.trim()}&rdquo;.</p>
      ) : (
        // Two companies per row (one on a phone), each card one link to its page: a large logo, the name with
        // its full type and place, and an arrow. Pointed at or tapped, the card turns light blue with a blue ring.
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((company) => {
            const place = [company.city, company.country].filter(Boolean).join(", ");
            return (
              <li key={company.id}>
                <Link
                  href={`/companies/${company.id}`}
                  className="group flex h-full items-center gap-4 rounded-2xl border border-border bg-card p-3 shadow-[0_8px_24px_-18px_rgb(15_27_45/0.35)] transition-all outline-none hover:border-[#2563eb] hover:bg-[#e3eeff] hover:shadow-[0_0_0_3px_rgb(37_99_235/0.25)] active:scale-[0.985] active:border-[#2563eb] active:bg-[#e3eeff] active:shadow-[0_0_0_3px_rgb(37_99_235/0.25)] focus-visible:ring-3 focus-visible:ring-ring/50 sm:gap-5 sm:p-4 md:gap-4"
                >
                  <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-xl bg-muted/60 p-2 sm:h-[76px] sm:w-36 md:h-16 md:w-28">
                    <CompanyAvatar name={company.name} logoUrl={logoUrls[company.id]} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-base font-semibold group-hover:text-[#1d4ed8] group-active:text-[#1d4ed8]">{company.name}</span>
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
                    className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#1d4ed8] group-active:text-[#1d4ed8]"
                    aria-hidden
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
