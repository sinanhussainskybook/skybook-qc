import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn() }));
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

  it("links Users for an admin only (the page checks the role again on the server)", () => {
    expect(html).toContain('href="/admin/users"');
    const designer = renderToStaticMarkup(
      <AppShell user={{ name: "Dee Designer", role: "designer" }}>
        <p>Page</p>
      </AppShell>
    );
    expect(designer).not.toContain('href="/admin/users"');
    expect(designer).toContain('href="/account/password"');
  });
});
