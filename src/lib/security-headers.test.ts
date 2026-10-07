import { describe, expect, it } from "vitest";
import { getSecurityHeaders } from "@/lib/security-headers";

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
