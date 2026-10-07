import { describe, expect, it } from "vitest";
import {
  checkEmail,
  checkName,
  checkPassword,
  checkRole,
  normalizeEmail,
} from "@/lib/auth/user-input";

describe("user details", () => {
  it("stores emails trimmed and lower-case", () => {
    expect(normalizeEmail("  Anna.Designer@Skybook.COM ")).toBe("anna.designer@skybook.com");
    expect(checkEmail(" Anna@Skybook.com")).toEqual({ ok: true, value: "anna@skybook.com" });
  });

  it("rejects things that aren't email addresses", () => {
    for (const bad of ["", "anna", "anna@", "@skybook.com", "anna@skybook", "an na@skybook.com"]) {
      expect(checkEmail(bad).ok, bad).toBe(false);
    }
    expect(checkEmail(`${"a".repeat(250)}@x.com`).ok).toBe(false);
  });

  it("tidies names and requires one", () => {
    expect(checkName("  Anna   Lee ")).toEqual({ ok: true, value: "Anna Lee" });
    expect(checkName("   ").ok).toBe(false);
    expect(checkName("x".repeat(101)).ok).toBe(false);
  });

  it("accepts only the two roles", () => {
    expect(checkRole(" Admin ")).toEqual({ ok: true, value: "admin" });
    expect(checkRole("designer")).toEqual({ ok: true, value: "designer" });
    expect(checkRole("owner").ok).toBe(false);
    expect(checkRole("").ok).toBe(false);
  });

  describe("passwords", () => {
    const strong = "a-very-long-passphrase";

    it("accepts a long password typed the same twice", () => {
      expect(checkPassword(strong, strong)).toEqual({ ok: true, value: strong });
    });

    it("keeps the password exactly as typed (no trimming)", () => {
      const withSpaces = "  spaced passphrase  ";
      expect(checkPassword(withSpaces, withSpaces)).toEqual({ ok: true, value: withSpaces });
    });

    it("needs at least 12 and at most 128 characters", () => {
      expect(checkPassword("elevenchars", "elevenchars").ok).toBe(false);
      expect(checkPassword("twelve chars", "twelve chars").ok).toBe(true);
      const long = "x".repeat(129);
      expect(checkPassword(long, long).ok).toBe(false);
    });

    it("rejects mismatches, only-spaces and the email itself", () => {
      expect(checkPassword(strong, `${strong}!`)).toMatchObject({ ok: false, error: /match/ });
      expect(checkPassword(" ".repeat(12), " ".repeat(12)).ok).toBe(false);
      expect(checkPassword("anna@skybook.com", "anna@skybook.com", "Anna@Skybook.com").ok).toBe(
        false
      );
    });
  });
});
