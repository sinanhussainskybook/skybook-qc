import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  SESSION_DURATION_MS,
} from "@/lib/auth/session-token";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-cookie";

describe("session token", () => {
  it("is 256 random bits, different every time", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(isWellFormedSessionToken(a)).toBe(true);
  });

  it("is stored only as a SHA-256 hash", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
  });

  it("rejects cookie values that can't be a token", () => {
    for (const bad of ["", "abc", "x".repeat(44), `${"a".repeat(42)}=`]) {
      expect(isWellFormedSessionToken(bad), bad).toBe(false);
    }
  });

  it("lasts 12 hours", () => {
    expect(SESSION_DURATION_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe("session cookie", () => {
  const expires = new Date("2026-10-01T12:00:00Z");

  it("is httpOnly, SameSite=Lax, whole-site and expires", () => {
    expect(sessionCookieOptions(expires, false)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      expires,
    });
  });

  it("is Secure and __Host- locked in production", () => {
    expect(sessionCookieOptions(expires, true).secure).toBe(true);
    expect(sessionCookieName(true)).toBe("__Host-skybook_qc_session");
    expect(sessionCookieName(false)).toBe("skybook_qc_session");
  });
});
