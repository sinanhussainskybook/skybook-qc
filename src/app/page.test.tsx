import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getCompaniesForCurrentUser = vi.fn();
vi.mock("@/lib/company/access", () => ({ getCompaniesForCurrentUser }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));

const { default: DashboardPage } = await import("@/app/page");

const dee = { id: "u1", name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: true };
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

describe("dashboard", () => {
  beforeEach(() => {
    getCompaniesForCurrentUser.mockReset();
    getCompaniesForCurrentUser.mockResolvedValue({ user: dee, companies: [] });
  });

  it("checks sign-in (and company access) on the server before rendering", async () => {
    await DashboardPage();
    expect(getCompaniesForCurrentUser).toHaveBeenCalledOnce();
  });

  it("does not render when the sign-in check stops it", async () => {
    getCompaniesForCurrentUser.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
    await expect(DashboardPage()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("greets the user, with one heading, inside the app shell", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Hi Dee");
    expect(html).toContain("Which company is the design for?");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Sign out");
  });

  it("invites the user to add the first company", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("No companies yet");
    expect(html).toContain('href="/companies/new"');
  });

  it("lists the companies the user may open, each linking to its page", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({
      user: dee,
      companies: [
        company("c1", "Acme", { category: "Real estate", city: "Dubai", country: "UAE" }),
        company("c2", "Globex", { active: false }),
      ],
    });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain('href="/companies/c1"');
    expect(html).toContain('href="/companies/c2"');
    expect(html).toContain("Real estate · Dubai, UAE");
    expect(html).toContain("Inactive");
  });

  it("keeps the page to one question and one list — no role explanations", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({ user: { ...dee, role: "admin" }, companies: [] });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Choose a company to check a design against its brief and brand rules.");
    expect(html).not.toContain("As an admin");
  });
});
