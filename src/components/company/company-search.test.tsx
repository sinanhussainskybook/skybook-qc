// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { companyMatches, SearchableCompanyList, sortCompanies } from "@/components/company/company-search";

/**
 * Home's company list: white company cards (logo, name, type, place, last update), A–Z, with a glass
 * search box and Add company along the top.
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
  it("shows every company as a card, A–Z, and the total before anything is typed", () => {
    const { container, getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    expect(names(container)).toEqual(["/companies/c3", "/companies/c1", "/companies/c2"]);
    expect(getByRole("heading", { name: /Companies/ }).textContent).toBe("Companies3");
    expect(container.querySelector("button")).toBeNull(); // no order switch: always A–Z
  });

  it("each card is one white link with the logo, name, type, place and last update, and no Active / Inactive label", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const card = container.querySelector('li a[href="/companies/c1"]')!;
    expect(card.className).toContain("bg-card");
    expect(card.textContent).toContain("Mannai Travel");
    expect(card.textContent).toContain("Travel management");
    expect(card.textContent).toContain("Doha, Qatar");
    expect(card.textContent).not.toMatch(/Active|Inactive/);
    expect(card.textContent).toMatch(/Updated \d{1,2} \w{3} \d{4}/);
    expect(container.querySelector('li a[href="/companies/c3"]')!.textContent).toContain("No type yet");
  });

  it("a card's edge turns teal when pointed at or tapped, and its name turns teal", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const card = container.querySelector("li a")!;
    const classes = card.className.split(" ");
    for (const state of ["hover", "active"]) expect(classes).toContain(`${state}:border-[#7cc4d0]`);
    expect(card.querySelector(".truncate")!.className).toContain("group-active:text-[#0e6377]");
  });

  it("has Add company in the list's top row", () => {
    const { getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const add = getByRole("link", { name: "Add company" });
    expect(add.getAttribute("href")).toBe("/companies/new");
    expect(add.className).toContain("btn-glossy");
  });

  it("has no status filter, and doesn't mark inactive companies", () => {
    const { container, queryByLabelText } = render(<SearchableCompanyList companies={[company("c9", "Old Co", { active: false })]} logoUrls={{}} />);
    expect(queryByLabelText("Show companies")).toBeNull();
    expect(container.querySelector("li a")!.textContent).not.toContain("Inactive");
  });

  it("shows every company at once, with no page buttons", () => {
    const many = Array.from({ length: 23 }, (_, i) => company(`m${i}`, `Company ${String(i).padStart(2, "0")}`));
    const { container, queryByRole } = render(<SearchableCompanyList companies={many} logoUrls={{}} />);
    expect(names(container)).toHaveLength(23);
    expect(queryByRole("navigation", { name: "Company pages" })).toBeNull();
  });

  it("filters the cards as you type, and says how many are shown", () => {
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

  it("the search box is glass, not a white box", () => {
    const { getByLabelText } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const box = getByLabelText("Search companies").closest("label")!.className;
    expect(box).toContain("backdrop-blur");
    expect(box).toContain("bg-[#04161b]/45");
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
  it("by name A–Z, ignoring capitals", () => {
    const ids = sortCompanies([company("c", "charlie"), company("b", "Bravo"), company("a", "alpha")]).map((x) => x.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
