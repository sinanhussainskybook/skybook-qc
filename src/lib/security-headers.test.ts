import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, createNonce, getSecurityHeaders, supabaseOriginFromEnv } from "@/lib/security-headers";

const valueOf = (isProduction: boolean, key: string) =>
  getSecurityHeaders(isProduction).find((header) => header.key === key)?.value;

describe("getSecurityHeaders", () => {
  it.each([true, false])("blocks sniffing and framing (production: %s)", (isProduction) => {
    expect(valueOf(isProduction, "X-Content-Type-Options")).toBe("nosniff");
    expect(valueOf(isProduction, "X-Frame-Options")).toBe("DENY");
  });

  it("turns off the camera and microphone", () => {
    const policy = valueOf(true, "Permissions-Policy");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
  });

  it("adds HSTS in production only", () => {
    expect(valueOf(true, "Strict-Transport-Security")).toBeDefined();
    expect(valueOf(false, "Strict-Transport-Security")).toBeUndefined();
  });

  it("returns a fresh list each time, so callers can't change the shared one", () => {
    getSecurityHeaders(false).push({ key: "X-Test", value: "1" });
    expect(valueOf(false, "X-Test")).toBeUndefined();
  });
});

describe("contentSecurityPolicy", () => {
  const directives = (policy: string) =>
    Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
  const production = directives(contentSecurityPolicy({ nonce: "abc123", isProduction: true, supabaseOrigin: "https://ref.supabase.co" }));
  const development = directives(contentSecurityPolicy({ nonce: "abc123", isProduction: false, supabaseOrigin: null }));

  it("runs only scripts with this request's nonce (and what they load) — no inline or outside scripts", () => {
    expect(production["script-src"]).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production["script-src"]).not.toContain("unsafe-inline");
    expect(production["script-src"]).not.toContain("unsafe-eval");
  });

  it("lets images and uploads reach the Supabase project only", () => {
    expect(production["img-src"]).toBe("'self' data: blob: https://ref.supabase.co");
    expect(production["connect-src"]).toBe("'self' https://ref.supabase.co");
    expect(development["img-src"]).toBe("'self' data: blob:");
    expect(development["connect-src"]).toBe("'self'");
  });

  it("blocks framing, plugins, <base> changes and forms to other sites", () => {
    expect(production["frame-ancestors"]).toBe("'none'");
    expect(production["object-src"]).toBe("'none'");
    expect(production["base-uri"]).toBe("'self'");
    expect(production["form-action"]).toBe("'self'");
    expect(production["default-src"]).toBe("'self'");
    expect(production["font-src"]).toBe("'self'");
  });

  it("allows inline style attributes (React uses them) but no outside stylesheets", () => {
    expect(production["style-src"]).toBe("'self' 'unsafe-inline'");
  });

  it("upgrades http in production; development adds 'unsafe-eval' for Next.js's dev tools", () => {
    expect(production).toHaveProperty("upgrade-insecure-requests");
    expect(development).not.toHaveProperty("upgrade-insecure-requests");
    expect(development["script-src"]).toContain("'unsafe-eval'");
  });
});

describe("createNonce", () => {
  it("is 128 random bits in base64, different every time", () => {
    const nonces = Array.from({ length: 50 }, createNonce);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(new Set(nonces).size).toBe(50);
  });
});

describe("supabaseOriginFromEnv", () => {
  it("takes only the origin of a proper https SUPABASE_URL", () => {
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "https://ref.supabase.co" })).toBe("https://ref.supabase.co");
    expect(supabaseOriginFromEnv({ SUPABASE_URL: " https://ref.supabase.co/ " })).toBe("https://ref.supabase.co");
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "https://ref.supabase.co/rest/v1" })).toBe("https://ref.supabase.co");
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "http://localhost:54321" })).toBe("http://localhost:54321");
  });

  it("gives null when it's missing, not a URL, or plain http on a real host", () => {
    expect(supabaseOriginFromEnv({})).toBeNull();
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "" })).toBeNull();
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "not a url" })).toBeNull();
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "http://ref.supabase.co" })).toBeNull();
    expect(supabaseOriginFromEnv({ SUPABASE_URL: "javascript:alert(1)" })).toBeNull();
  });
});
