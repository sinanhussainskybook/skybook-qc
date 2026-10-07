import { describe, expect, it } from "vitest";
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
});
