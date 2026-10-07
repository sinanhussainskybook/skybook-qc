import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getCurrentUser = vi.fn();
const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT ${path}`);
});
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/actions", () => ({ signInAction: vi.fn() }));

const { default: LoginPage } = await import("@/app/login/page");

const render = async (search: Record<string, string> = {}) =>
  renderToStaticMarkup(
    await LoginPage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) })
  );

describe("sign-in page", () => {
  beforeEach(() => {
    getCurrentUser.mockReset().mockResolvedValue(null);
    redirect.mockClear();
  });

  it("asks for email and password with the right autocomplete hints", async () => {
    // HTML attribute names are case-insensitive (Base UI writes autoComplete).
    const html = (await render()).toLowerCase();
    expect(html).toContain('type="email"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('type="submit"');
    expect(html).toContain(">sign in</button>");
  });

  it("offers no sign-up", async () => {
    const html = (await render()).toLowerCase();
    expect(html).not.toContain("sign up");
    expect(html).not.toContain("register");
    expect(html).not.toContain("create account");
  });

  it("keeps a safe return path and drops an unsafe one", async () => {
    expect(await render({ next: "/qc/abc" })).toContain('value="/qc/abc"');
    const html = await render({ next: "https://evil.example" });
    expect(html).not.toContain("evil.example");
    expect(html).toContain('name="next" value="/"');
  });

  it("sends someone already signed in to the dashboard", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1", name: "Dee", role: "designer" });
    await expect(render()).rejects.toThrow("NEXT_REDIRECT /");
  });
});
