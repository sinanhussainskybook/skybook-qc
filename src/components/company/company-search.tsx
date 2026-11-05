"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { CompanyAvatar } from "@/components/company/company-avatar";
import { cn } from "@/lib/utils";

/** Whether a company matches what was typed: its name, type, city or country, ignoring capitals. */
export function companyMatches(company: CompanySummary, term: string): boolean {
  const words = term.trim().toLowerCase();
  if (!words) return true;
  return [company.name, company.category, company.city, company.country].some((text) => text?.toLowerCase().includes(words));
}

/** Sorts companies by name A–Z, ignoring capitals. */
export function sortCompanies(companies: CompanySummary[]): CompanySummary[] {
  return [...companies].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

// The day a company was last updated, the same on the server and in the browser (no time-zone shift).
const updatedFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });

// The search box's glass look (white in light mode).
const GLASS =
  "theme-control h-10 rounded-full border border-white/30 bg-[#04161b]/45 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] backdrop-blur-md transition-colors focus-within:border-[#7cc4d0]/80 focus-within:ring-3 focus-within:ring-[#1a8ea3]/40";

/**
 * Home's company list: white company cards, A–Z, with a search box and Add company along the top. The cards filter as you type;
 * pressing "/" anywhere on the page jumps to the box. Each card is one link to the company's page.
 */
export function SearchableCompanyList({ companies, logoUrls }: { companies: CompanySummary[]; logoUrls: Record<string, string> }) {
  const [term, setTerm] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const matching = companies.filter((company) => companyMatches(company, term));
  const filtered = Boolean(term.trim());

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
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-base font-bold">
          Companies
          <span className="ml-2 text-sm font-medium text-muted-foreground" aria-live="polite">
            {filtered ? `${matching.length} of ${companies.length} shown` : companies.length}
          </span>
        </h2>
        <label className={cn(GLASS, "flex min-w-0 flex-1 items-center gap-2 px-3.5 sm:w-64 sm:flex-none")}>
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
        <Link
          href="/companies/new"
          className="btn-glossy inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-[#1a8ea3]/40"
        >
          <Plus className="size-4" aria-hidden />
          Add company
        </Link>
      </div>

      {matching.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No company matches &ldquo;{term.trim()}&rdquo;.
        </p>
      ) : (
        <CompanyCards companies={sortCompanies(matching)} logoUrls={logoUrls} />
      )}
    </div>
  );
}

/**
 * White company cards: logo, name and type; the place; the last update. Each card is one link
 * to the company's page; pointed at or tapped, its edge turns teal and it lifts slightly.
 */
function CompanyCards({ companies, logoUrls }: { companies: CompanySummary[]; logoUrls: Record<string, string> }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {companies.map((company) => {
        const place = [company.city, company.country].filter(Boolean).join(", ");
        return (
          <li key={company.id}>
            <Link
              href={`/companies/${company.id}`}
              className="group flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-[0_8px_24px_-18px_rgb(6_28_35/0.45)] transition outline-none hover:-translate-y-0.5 hover:border-[#7cc4d0] hover:shadow-[0_14px_30px_-18px_rgb(14_99_119/0.7)] focus-visible:ring-3 focus-visible:ring-ring/50 active:border-[#7cc4d0]"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-xl bg-muted/70 p-1.5">
                  <CompanyAvatar name={company.name} logoUrl={logoUrls[company.id]} small />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold group-hover:text-[#0e6377] group-active:text-[#0e6377]">{company.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">{company.category || "No type yet"}</span>
                </span>
                <ArrowUpRight
                  className="size-5 shrink-0 self-start text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#0e6377]"
                  aria-hidden
                />
              </span>
              {place && (
                <span className="w-fit max-w-full truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">{place}</span>
              )}
              <span className="mt-auto border-t border-border pt-2.5 text-xs text-muted-foreground">
                Updated {updatedFormat.format(new Date(company.updated_at))}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
