import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getCompaniesForCurrentUser = vi.fn();
vi.mock("@/lib/company/access", () => ({ getCompaniesForCurrentUser }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
const companyLogoUrls = vi.fn();
vi.mock("@/lib/company/logo", () => ({ companyLogoUrls }));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/lib/storage/logo-storage", () => ({ getLogoStorage: () => null }));

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
    companyLogoUrls.mockReset();
    companyLogoUrls.mockResolvedValue({});
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
    expect(html).toContain("Which company&#x27;s design are we checking?");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Sign out");
  });

  it("says in one line how a QC check works, with what it checks one click away", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    const steps = html.slice(html.indexOf('<ol aria-label="How a QC check works"'), html.indexOf("</ol>"));
    expect(steps.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toMatch(/1 Upload the brief .*2 Upload the design .*3 Check Design .*✓ Result \+ PDF report/);
    expect(html).toContain("What does QC check?");
    expect(html).not.toMatch(/<details[^>]* open/); // folded by default
    expect(html).toContain("Use sample designs only while Gemini is on the free tier.");
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
    // The type, and the place as its own chip.
    expect(html).toContain(">Real estate</span>");
    expect(html).toMatch(/rounded-full[^"]*">Dubai, UAE<\/span>/);
    expect(html).not.toContain("Inactive"); // no Active / Inactive label on Home
    // One white (bg-card) card per company, each card one link.
    const cards = html.match(/<a class="[^"]*bg-card[^"]*" href="\/companies\/c\d"/g) ?? [];
    expect(cards).toHaveLength(2);
  });

  it("has a search box above the companies (none when there are no companies yet)", async () => {
    expect(renderToStaticMarkup(await DashboardPage())).not.toContain('aria-label="Search companies"');
    getCompaniesForCurrentUser.mockResolvedValue({ user: dee, companies: [company("c1", "Acme")] });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain('aria-label="Search companies"');
    expect(html.indexOf('aria-label="Search companies"')).toBeLessThan(html.indexOf('href="/companies/c1"'));
  });

  it("Home's panel is see-through frosted glass and wide (the companies sit on white cards)", async () => {
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toMatch(/class="content-panel [^"]*content-panel--glass"/);
    expect(html).toMatch(/max-w-7xl[^"]*"><div class="content-panel/); // every page is this wide
  });

  it("puts Add company in the list's top row, not under the heading", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({ user: dee, companies: [company("c1", "Acme")] });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html.match(/href="\/companies\/new"/g)).toHaveLength(1);
    const hero = html.slice(html.indexOf('<section class="app-hero"'), html.indexOf("</section>"));
    expect(hero).not.toContain("/companies/new");
    expect(html.indexOf('href="/companies/new"')).toBeGreaterThan(html.indexOf("content-panel"));
  });

  it("each card ends in a simple arrow — no separate Start QC button", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({ user: dee, companies: [company("c1", "Acme"), company("c2", "Globex")] });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).not.toContain("/qc/new");
    expect(html).not.toContain("Start QC for");
    const rows = html.split(/href="\/companies\/c\d"/).slice(1);
    for (const row of rows) expect(row.slice(0, row.indexOf("</a>"))).toContain("lucide-arrow-up-right");
  });

  it("shows each company's own saved logo on its card, and the initial letter for one without", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({
      user: dee,
      companies: [company("c1", "Acme"), company("c2", "Globex"), company("c3", "Initech")],
    });
    companyLogoUrls.mockResolvedValue({ c1: "https://storage.test/sign/c1/a.png", c2: "https://storage.test/sign/c2/b.svg" });
    const html = renderToStaticMarkup(await DashboardPage());
    // Only the companies the user may open are asked about.
    expect(companyLogoUrls).toHaveBeenCalledWith(expect.anything(), null, ["c1", "c2", "c3"]);
    const cards = html.split(/href="\/companies\/c\d"/).slice(1); // one piece per card, in order
    expect(cards[0]).toContain('src="https://storage.test/sign/c1/a.png"');
    expect(cards[1]).toContain('src="https://storage.test/sign/c2/b.svg"');
    expect(cards[2]).not.toContain("<img");
    expect(cards[2]).toMatch(/uppercase[^"]*">I<\/span>/);
  });

  it("keeps the page to one question and one list — no role explanations", async () => {
    getCompaniesForCurrentUser.mockResolvedValue({ user: { ...dee, role: "admin" }, companies: [] });
    const html = renderToStaticMarkup(await DashboardPage());
    expect(html).toContain("Choose a company, then upload the brief and the design. QC checks it against the brief and the brand rules.");
    expect(html).not.toContain("As an admin");
  });
});
