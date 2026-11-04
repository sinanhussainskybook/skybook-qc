"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { CompanySummary } from "@/lib/company/types";
import { CompanyAvatar } from "@/components/company/company-avatar";
import { cn } from "@/lib/utils";

/** Whether a company matches what was typed: its name, type, city or country, ignoring capitals. */
export function companyMatches(company: CompanySummary, term: string): boolean {
  const words = term.trim().toLowerCase();
  if (!words) return true;
  return [company.name, company.category, company.city, company.country].some((text) => text?.toLowerCase().includes(words));
}

export type CompanySort = "name" | "type" | "updated";
export type StatusFilter = "all" | "active" | "inactive";

/** Companies per page of the list. */
export const COMPANIES_PER_PAGE = 10;

/**
 * Sorts companies for the list: by name or type A–Z (companies without a type last), or by last update,
 * newest first. `reverse` turns the order round. Ties keep name order.
 */
export function sortCompanies(companies: CompanySummary[], sort: CompanySort, reverse = false): CompanySummary[] {
  const byName = (a: CompanySummary, b: CompanySummary) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  const compare = (a: CompanySummary, b: CompanySummary): number => {
    if (sort === "type") {
      if (!a.category !== !b.category) return a.category ? -1 : 1;
      return (a.category ?? "").localeCompare(b.category ?? "", "en", { sensitivity: "base" }) || byName(a, b);
    }
    if (sort === "updated") return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() || byName(a, b);
    return byName(a, b);
  };
  return [...companies].sort((a, b) => (reverse ? -compare(a, b) : compare(a, b)));
}

// The day a company was last updated, the same on the server and in the browser (no time-zone shift).
const updatedFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });

// Company · Type · Location · Status · Updated · arrow; on a phone only Company · Status · arrow.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto_1.25rem] items-center gap-3 md:grid-cols-[minmax(0,2.3fr)_minmax(0,1.3fr)_minmax(0,1.4fr)_6rem_7rem_1.25rem] md:gap-4";

// The dark-glass look shared by the search box and the status filter.
const GLASS =
  "theme-control h-10 rounded-full border border-white/30 bg-[#050b1e]/45 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] backdrop-blur-md transition-colors focus-within:border-[#9cc2ff]/80 focus-within:ring-3 focus-within:ring-blue-500/40";

/**
 * Home's company list: one white table card — Company (logo and name), Type, Location, Status, Updated —
 * with a small dark-glass search box and a status filter in its top-right corner. Click Company, Type or
 * Updated to sort (again to reverse); ten companies a page. The rows filter as you type; pressing "/"
 * anywhere on the page jumps to the box. Each row is one link to the company's page.
 */
export function SearchableCompanyList({ companies, logoUrls }: { companies: CompanySummary[]; logoUrls: Record<string, string> }) {
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<CompanySort>("name");
  const [reverse, setReverse] = useState(false);
  const [page, setPage] = useState(1);
  const input = useRef<HTMLInputElement>(null);

  const matching = companies.filter(
    (company) => companyMatches(company, term) && (status === "all" || company.active === (status === "active"))
  );
  const sorted = sortCompanies(matching, sort, reverse);
  const pages = Math.max(1, Math.ceil(sorted.length / COMPANIES_PER_PAGE));
  const current = Math.min(page, pages);
  const first = (current - 1) * COMPANIES_PER_PAGE;
  const shown = sorted.slice(first, first + COMPANIES_PER_PAGE);
  const filtered = Boolean(term.trim()) || status !== "all";

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

  const sortBy = (column: CompanySort) => {
    setReverse(column === sort ? !reverse : false);
    setSort(column);
    setPage(1);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold">
          Companies
          <span className="ml-2 text-sm font-medium text-muted-foreground" aria-live="polite">
            {filtered ? `${matching.length} of ${companies.length} shown` : companies.length}
          </span>
        </h2>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <label className={cn(GLASS, "flex min-w-0 flex-1 items-center gap-2 px-3.5 sm:w-72 sm:flex-none")}>
            <Search className="size-4 shrink-0 text-white/80" aria-hidden />
            <input
              ref={input}
              type="search"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setPage(1);
              }}
              placeholder="Search companies"
              aria-label="Search companies"
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/65"
            />
            <kbd className="rounded-md border border-white/25 bg-white/10 px-1.5 font-mono text-[11px] text-white" aria-hidden>
              /
            </kbd>
          </label>
          <span className={cn(GLASS, "relative flex items-center")}>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as StatusFilter);
                setPage(1);
              }}
              aria-label="Show companies"
              className="h-full cursor-pointer appearance-none rounded-full bg-transparent pr-9 pl-3.5 text-sm text-white outline-none [&>option]:text-[#0a1328]"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 size-4 text-white/80" aria-hidden />
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_24px_-18px_rgb(15_27_45/0.35)]">
        <div className={cn(COLUMNS, "border-b border-border bg-[#f3f6fb] px-4 py-2.5 text-xs font-semibold text-muted-foreground")}>
          <SortButton label="Company" column="name" sort={sort} reverse={reverse} onSort={sortBy} />
          <SortButton label="Type" column="type" sort={sort} reverse={reverse} onSort={sortBy} className="hidden md:flex" />
          <span className="hidden md:block">Location</span>
          <span>Status</span>
          <SortButton label="Updated" column="updated" sort={sort} reverse={reverse} onSort={sortBy} className="hidden md:flex" />
          <span aria-hidden />
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {term.trim() ? <>No company matches &ldquo;{term.trim()}&rdquo;.</> : "No companies with this status."}
          </p>
        ) : (
          // One row per company, each row one link to its page. Pointed at or tapped, it turns light blue
          // and the name blue.
          <ul>
            {shown.map((company) => {
              const place = [company.city, company.country].filter(Boolean).join(", ");
              return (
                <li key={company.id} className="border-b border-[#edf1f8] last:border-b-0">
                  <Link
                    href={`/companies/${company.id}`}
                    className={cn(
                      COLUMNS,
                      "group px-4 py-2.5 text-sm transition-colors outline-none hover:bg-[#e3eeff] active:bg-[#e3eeff] focus-visible:bg-[#e3eeff] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3.5">
                      <span className="flex h-11 w-16 shrink-0 items-center justify-center rounded-lg bg-muted/60 p-1.5">
                        <CompanyAvatar name={company.name} logoUrl={logoUrls[company.id]} small />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold group-hover:text-[#1d4ed8] group-active:text-[#1d4ed8]">{company.name}</span>
                        {place && <span className="block truncate text-xs text-muted-foreground md:hidden">{place}</span>}
                      </span>
                    </span>
                    <span className="hidden truncate text-muted-foreground md:block">{company.category || "—"}</span>
                    <span className="hidden min-w-0 md:block">
                      {place ? (
                        <span className="inline-flex max-w-full truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                          {place}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                    <span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium before:size-1.5 before:rounded-full before:bg-current",
                          company.active ? "bg-[#dcfce7] text-[#166534]" : "bg-muted text-muted-foreground"
                        )}
                      >
                        {company.active ? "Active" : "Inactive"}
                      </span>
                    </span>
                    <span className="hidden whitespace-nowrap text-muted-foreground md:block">{updatedFormat.format(new Date(company.updated_at))}</span>
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

      {sorted.length > COMPANIES_PER_PAGE && (
        <nav aria-label="Company pages" className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            Showing {first + 1}–{first + shown.length} of {sorted.length}
          </span>
          <span className="flex gap-1">
            <PageButton label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)}>
              <ChevronLeft className="size-4" aria-hidden />
            </PageButton>
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <PageButton key={n} label={`Page ${n}`} current={n === current} onClick={() => setPage(n)}>
                {n}
              </PageButton>
            ))}
            <PageButton label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)}>
              <ChevronRight className="size-4" aria-hidden />
            </PageButton>
          </span>
        </nav>
      )}
    </div>
  );
}

/** A column heading that sorts the list: an arrow shows the current order. */
function SortButton({
  label,
  column,
  sort,
  reverse,
  onSort,
  className,
}: {
  label: string;
  column: CompanySort;
  sort: CompanySort;
  reverse: boolean;
  onSort: (column: CompanySort) => void;
  className?: string;
}) {
  const active = sort === column;
  const Arrow = !active ? ArrowUpDown : reverse ? ArrowUp : ArrowDown;
  // Name and type read A–Z going down; Updated, newest first going down.
  const order = column === "updated" ? (reverse ? "oldest first" : "newest first") : reverse ? "Z to A" : "A to Z";
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      aria-label={active ? `${label}, sorted ${order}` : `Sort by ${label}`}
      className={cn("flex w-fit items-center gap-1 rounded-md outline-none hover:text-[#1d4ed8] focus-visible:ring-3 focus-visible:ring-ring/50", active && "text-[#1d4ed8]", className)}
    >
      {label}
      <Arrow className={cn("size-3.5", !active && "opacity-50")} aria-hidden />
    </button>
  );
}

/** One page button under the list: glass, or glossy blue for the page shown. */
function PageButton({
  label,
  current = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-9 min-w-9 items-center justify-center rounded-full border px-2 text-sm text-white transition-colors outline-none focus-visible:ring-3 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-35",
        current ? "btn-glossy border-transparent" : "theme-control border-white/25 bg-white/[0.08] hover:enabled:bg-white/[0.18]"
      )}
    >
      {children}
    </button>
  );
}
