import { describe, expect, it } from "vitest";
import { decideRouteAccess, safeRedirectPath } from "@/lib/auth/route-access";

describe("route access (proxy)", () => {
  it("sends signed-out visitors on any page to sign-in", () => {
    for (const path of ["/", "/companies", "/qc/abc", "/anything/else"]) {
      expect(decideRouteAccess(path, false), path).toBe("redirect-to-login");
    }
  });

  it("answers 401 for API routes instead of redirecting", () => {
    expect(decideRouteAccess("/api", false)).toBe("unauthorized");
    expect(decideRouteAccess("/api/companies", false)).toBe("unauthorized");
    expect(decideRouteAccess("/apiary", false)).toBe("redirect-to-login");
  });

  it("always lets anyone open the sign-in page", () => {
    expect(decideRouteAccess("/login", false)).toBe("allow");
  });

  it("lets a request with a sign-in cookie through to the server check", () => {
    expect(decideRouteAccess("/", true)).toBe("allow");
    expect(decideRouteAccess("/api/x", true)).toBe("allow");
  });
});

describe("safeRedirectPath", () => {
  it("keeps paths on this site", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/companies/42?tab=brand")).toBe("/companies/42?tab=brand");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "evil.example",
      "/\u0000x",
      "/\tevil",
    ]) {
      expect(safeRedirectPath(bad), JSON.stringify(bad)).toBe("/");
    }
  });

  it("never loops back to the sign-in page, and ignores junk", () => {
    expect(safeRedirectPath("/login")).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath(42)).toBe("/");
    expect(safeRedirectPath(`/${"a".repeat(600)}`)).toBe("/");
  });
});
