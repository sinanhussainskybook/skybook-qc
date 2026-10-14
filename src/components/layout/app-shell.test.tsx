import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
const { AppShell } = await import("@/components/layout/app-shell");

describe("AppShell", () => {
  const html = renderToStaticMarkup(
    <AppShell user={{ name: "Ada Admin", role: "admin" }}>
      <p>The page itself</p>
    </AppShell>
  );

  it("links the mark home and labels the product", () => {
    expect(html).toContain('href="/"');
    expect(html).toContain("AI QC");
  });

  it("puts the page inside the one <main>, below the header", () => {
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.indexOf("<header")).toBeLessThan(html.indexOf("The page itself"));
    expect(html.indexOf("<main")).toBeLessThan(html.indexOf("The page itself"));
  });

  it("shows who is signed in, their role, and a sign-out button", () => {
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain("Ada Admin");
    expect(header).toContain("Admin");
    expect(header).toContain("<form");
    expect(header).toContain("Sign out");
  });

  const render = (role: "admin" | "designer", path: string) => {
    nav.path = path;
    const out = renderToStaticMarkup(
      <AppShell user={{ name: "Someone", role }}>
        <p>Page</p>
      </AppShell>
    );
    return out.slice(out.indexOf('<nav aria-label="Main"'), out.indexOf("</nav>"));
  };
  const current = (navHtml: string) => navHtml.match(/<a [^>]*aria-current="page"[^>]*aria-label="([^"]+)"/)?.[1];

  it("has the main navigation in the header: Home, Users for admins only, then the user and Sign out", () => {
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain('<nav aria-label="Main"');
    const admin = render("admin", "/");
    expect(admin).toContain('href="/"');
    expect(admin).toContain('href="/admin/users"');
    expect(admin).toContain("Someone");
    expect(admin).toContain("Sign out");
    const designer = render("designer", "/");
    expect(designer).toContain('href="/"');
    expect(designer).not.toContain('href="/admin/users"');
    expect(designer).toContain("Sign out");
    // "Add company" is on the Home page, not in the navigation.
    expect(admin).not.toContain('href="/companies/new"');
    expect(designer).not.toContain('href="/companies/new"');
  });

  it("marks the current page (Home also covers a company's pages)", () => {
    expect(current(render("admin", "/"))).toBe("Home");
    expect(current(render("admin", "/companies/0b6d0f0e-8c1a-4a57-9a4e-2a6f1d6c9e01/qc/new"))).toBe("Home");
    expect(current(render("admin", "/companies/new"))).toBe("Home");
    expect(current(render("admin", "/admin/users"))).toBe("Users");
    expect(current(render("admin", "/account/password"))).toBeUndefined();
  });

  it("draws the travelling lights as decorative layers only: hidden from screen readers, one dot per curved line", () => {
    const withHero = renderToStaticMarkup(
      <AppShell user={{ name: "Ada Admin", role: "admin" }} hero={<h1>Title</h1>}>
        <p>Body</p>
      </AppShell>
    );
    const layers = withHero.match(/<div class="skyqc-orbit-layer[^"]*" aria-hidden="true">/g) ?? [];
    expect(layers).toHaveLength(2); // the page background and the hero
    for (const ring of ["hero-inner", "hero-outer", "sky-inner", "sky-outer"]) {
      expect(withHero.match(new RegExp(`skyqc-orbit-dot--${ring}`, "g"))).toHaveLength(1);
    }
    // Without a hero (no curves there), only the page-background lights.
    expect(html.match(/skyqc-orbit-layer/g)).toHaveLength(2); // the layer and its --sky modifier on one element
    expect(html).not.toContain("skyqc-orbit-dot--hero");
  });

  it("no password link in the header (it's on the Users page)", () => {
    expect(html).not.toContain('href="/account/password"');
    expect(render("designer", "/")).not.toContain('href="/account/password"');
  });
});
