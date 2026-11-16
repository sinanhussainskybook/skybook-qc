import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, "http://localhost:3200"), {
    headers: cookie ? { cookie } : {},
  });

describe("proxy", () => {
  it("redirects a signed-out visitor to /login, remembering where they were going", () => {
    const response = proxy(request("/qc/abc?x=1"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/qc/abc?x=1");
  });

  it("redirects the home page without a return path", () => {
    const location = new URL(proxy(request("/")).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.search).toBe("");
  });

  it("answers 401 for API routes", async () => {
    const response = proxy(request("/api/anything"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required." });
  });

  it("lets the sign-in page through", () => {
    expect(proxy(request("/login")).headers.get("x-middleware-next")).toBe("1");
  });

  it("lets a request with the session cookie through to the server check", () => {
    const response = proxy(request("/", "skybook_qc_session=anything"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  describe("Content-Security-Policy on pages", () => {
    afterEach(() => vi.unstubAllEnvs());
    const csp = (path: string, cookie?: string) => proxy(request(path, cookie)).headers.get("content-security-policy");

    it("gives the page a policy with a fresh nonce, and passes the same nonce to the page code", () => {
      const response = proxy(request("/login"));
      const policy = response.headers.get("content-security-policy")!;
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      // NextResponse.next({ request }) forwards changed request headers as x-middleware-request-*.
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    });

    it("uses a different nonce for every request", () => {
      const nonces = new Set(Array.from({ length: 20 }, () => /'nonce-([^']+)'/.exec(csp("/login")!)![1]));
      expect(nonces.size).toBe(20);
    });

    it("covers signed-in pages too", () => {
      expect(csp("/companies/abc", "skybook_qc_session=anything")).toContain("frame-ancestors 'none'");
    });

    it("allows the Supabase project for images and uploads when SUPABASE_URL is set", () => {
      vi.stubEnv("SUPABASE_URL", "https://abc.supabase.co");
      const policy = csp("/login")!;
      expect(policy).toContain("img-src 'self' data: blob: https://abc.supabase.co");
      expect(policy).toContain("connect-src 'self' https://abc.supabase.co");
    });

    it("adds no policy to API routes or redirects", () => {
      expect(csp("/api/anything", "skybook_qc_session=anything")).toBeNull();
      expect(csp("/api", "skybook_qc_session=anything")).toBeNull();
      expect(csp("/qc/abc")).toBeNull();
    });
  });
});
