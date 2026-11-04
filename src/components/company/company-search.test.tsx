// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { companyMatches, SearchableCompanyList, sortCompanies } from "@/components/company/company-search";

/**
 * Home's company list: one white table (Company, Type, Location, Status, Updated), with a dark-glass search
 * box and a status filter in the corner, sorting by column and ten companies a page.
 */

afterEach(cleanup);

const company = (id: string, name: string, extra = {}) => ({
  id,
  name,
  category: null,
  city: null,
  country: null,
  active: true,
  updated_at: new Date(),
  ...extra,
});
const companies = [
  company("c1", "Mannai Travel", { category: "Travel management", city: "Doha", country: "Qatar" }),
  company("c2", "Space Cargo", { category: "Cargo and logistics", city: "Doha", country: "Qatar" }),
  company("c3", "BARAKAH", { city: "Muscat", country: "Oman" }),
];
const names = (container: HTMLElement) => [...container.querySelectorAll("li a")].map((a) => a.getAttribute("href"));

describe("companyMatches", () => {
  it("matches the name, type, city or country, ignoring capitals and spaces around", () => {
    expect(companyMatches(companies[0], "  MANNAI ")).toBe(true);
    expect(companyMatches(companies[1], "logistics")).toBe(true);
    expect(companyMatches(companies[2], "muscat")).toBe(true);
    expect(companyMatches(companies[2], "oman")).toBe(true);
    expect(companyMatches(companies[2], "doha")).toBe(false);
    expect(companyMatches(companies[2], "")).toBe(true);
  });
});

describe("SearchableCompanyList", () => {
  it("shows every company, A–Z, and the total before anything is typed", () => {
    const { container, getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    expect(names(container)).toEqual(["/companies/c3", "/companies/c1", "/companies/c2"]);
    expect(getByRole("heading", { name: /Companies/ }).textContent).toBe("Companies3");
  });

  it("is one white table card with the column headings, one row per company", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const card = container.querySelector(".bg-card")!;
    expect(card.textContent).toContain("Company");
    for (const heading of ["Type", "Location", "Status", "Updated"]) expect(card.textContent).toContain(heading);
    expect(card.querySelectorAll("li a")).toHaveLength(3);
    const row = card.querySelector('li a[href="/companies/c1"]')!;
    expect(row.textContent).toContain("Mannai Travel");
    expect(row.textContent).toContain("Travel management");
    expect(row.textContent).toContain("Doha, Qatar");
    expect(row.textContent).toContain("Active");
  });

  it("a row turns light blue when pointed at or tapped, and its name turns blue", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const row = container.querySelector("li a")!;
    const classes = row.className.split(" ");
    for (const state of ["hover", "active"]) expect(classes).toContain(`${state}:bg-[#e3eeff]`);
    expect(row.querySelector(".truncate")!.className).toContain("group-active:text-[#1d4ed8]");
  });

  it("marks an inactive company", () => {
    const { container } = render(<SearchableCompanyList companies={[company("c9", "Old Co", { active: false })]} logoUrls={{}} />);
    expect(container.querySelector("li a")!.textContent).toContain("Inactive");
  });

  it("sorts by Company, Type or Updated; clicking again reverses", () => {
    const { container, getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    expect(names(container)).toEqual(["/companies/c3", "/companies/c1", "/companies/c2"]); // A–Z, ignoring capitals
    fireEvent.click(getByRole("button", { name: /Company, sorted A to Z/ }));
    expect(names(container)).toEqual(["/companies/c2", "/companies/c1", "/companies/c3"]);
    fireEvent.click(getByRole("button", { name: "Sort by Type" }));
    expect(names(container)).toEqual(["/companies/c2", "/companies/c1", "/companies/c3"]); // no type last
  });

  it("filters by status", () => {
    const list = [...companies, company("c4", "Dormant", { active: false })];
    const { container, getByLabelText, getByRole } = render(<SearchableCompanyList companies={list} logoUrls={{}} />);
    fireEvent.change(getByLabelText("Show companies"), { target: { value: "inactive" } });
    expect(names(container)).toEqual(["/companies/c4"]);
    expect(getByRole("heading", { name: /Companies/ }).textContent).toContain("1 of 4 shown");
    fireEvent.change(getByLabelText("Show companies"), { target: { value: "active" } });
    expect(names(container)).toHaveLength(3);
  });

  it("shows ten companies a page, with page buttons only when there are more", () => {
    const many = Array.from({ length: 23 }, (_, i) => company(`m${i}`, `Company ${String(i).padStart(2, "0")}`));
    const { container, getByRole, getByText } = render(<SearchableCompanyList companies={many} logoUrls={{}} />);
    expect(names(container)).toHaveLength(10);
    expect(getByText("Showing 1–10 of 23")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Page 3" }));
    expect(names(container)).toEqual(["/companies/m20", "/companies/m21", "/companies/m22"]);
    expect(getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    fireEvent.click(getByRole("button", { name: "Previous page" }));
    expect(getByText("Showing 11–20 of 23")).toBeTruthy();
    // Typing goes back to the first page.
    fireEvent.change(document.querySelector('input[type="search"]')!, { target: { value: "Company" } });
    expect(getByText("Showing 1–10 of 23")).toBeTruthy();
    cleanup();
    const few = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    expect(few.queryByRole("navigation", { name: "Company pages" })).toBeNull();
  });

  it("filters the rows as you type, and says how many are shown", () => {
    const { container, getByLabelText, getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    fireEvent.change(getByLabelText("Search companies"), { target: { value: "doha" } });
    expect(names(container)).toEqual(["/companies/c1", "/companies/c2"]);
    expect(getByRole("heading", { name: /Companies/ }).textContent).toContain("2 of 3 shown");
  });

  it("says when nothing matches", () => {
    const { container, getByLabelText } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    fireEvent.change(getByLabelText("Search companies"), { target: { value: "zzz" } });
    expect(container.querySelector("li")).toBeNull();
    expect(container.textContent).toContain("No company matches “zzz”.");
  });

  it("is dark glass, not a white box", () => {
    const { getByLabelText } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const box = getByLabelText("Search companies").closest("label")!.className;
    expect(box).toContain("backdrop-blur");
    expect(box).toContain("bg-[#050b1e]/45");
    expect(box).not.toMatch(/\bbg-white\b/);
  });

  it("pressing / jumps to the search box, but not while typing elsewhere", () => {
    const { getByLabelText } = render(
      <>
        <input aria-label="Other" />
        <SearchableCompanyList companies={companies} logoUrls={{}} />
      </>
    );
    const search = getByLabelText("Search companies");
    fireEvent.keyDown(getByLabelText("Other"), { key: "/" });
    expect(document.activeElement).not.toBe(search);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);
  });
});

describe("sortCompanies", () => {
  const a = company("a", "alpha", { category: "Retail", updated_at: new Date("2026-10-01") });
  const b = company("b", "Bravo", { category: null, updated_at: new Date("2026-11-01") });
  const c = company("c", "charlie", { category: "Hotels", updated_at: new Date("2026-10-15") });
  const ids = (list: { id: string }[]) => list.map((x) => x.id);

  it("by name A–Z ignoring capitals, or Z–A", () => {
    expect(ids(sortCompanies([c, b, a], "name"))).toEqual(["a", "b", "c"]);
    expect(ids(sortCompanies([c, b, a], "name", true))).toEqual(["c", "b", "a"]);
  });

  it("by type A–Z, companies without a type last", () => {
    expect(ids(sortCompanies([a, b, c], "type"))).toEqual(["c", "a", "b"]);
  });

  it("by last update, newest first", () => {
    expect(ids(sortCompanies([a, b, c], "updated"))).toEqual(["b", "c", "a"]);
    expect(ids(sortCompanies([a, b, c], "updated", true))).toEqual(["a", "c", "b"]);
  });
});
