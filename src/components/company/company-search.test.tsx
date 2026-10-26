// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { companyMatches, SearchableCompanyList } from "@/components/company/company-search";

/** Home's company list: a dark-glass search box in the corner that filters the rows as you type. */

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
  it("shows every company and the total before anything is typed", () => {
    const { container, getByRole } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    expect(names(container)).toEqual(["/companies/c1", "/companies/c2", "/companies/c3"]);
    expect(getByRole("heading", { name: /Companies/ }).textContent).toBe("Companies3");
  });

  it("shows two companies per row from tablet width up (one on a phone)", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const list = container.querySelector("ul")!.className.split(" ");
    expect(list).toContain("md:grid-cols-2");
    expect(list.some((c) => /^grid-cols-/.test(c))).toBe(false);
  });

  it("a card turns light blue with a blue ring when pointed at or tapped, and its name turns blue", () => {
    const { container } = render(<SearchableCompanyList companies={companies} logoUrls={{}} />);
    const card = container.querySelector("li a")!;
    const classes = card.className.split(" ");
    for (const state of ["hover", "active"]) {
      expect(classes).toContain(`${state}:bg-[#e3eeff]`);
      expect(classes).toContain(`${state}:border-[#2563eb]`);
      expect(classes).toContain(`${state}:shadow-[0_0_0_3px_rgb(37_99_235/0.25)]`);
    }
    expect(card.querySelector(".truncate")!.className).toContain("group-active:text-[#1d4ed8]");
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
    expect(container.querySelector("ul")).toBeNull();
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
