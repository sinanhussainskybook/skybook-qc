import { describe, expect, it } from "vitest";
import { hasRole, isRole, ROLES } from "@/lib/auth/roles";

describe("roles", () => {
  it("has exactly admin and designer", () => {
    expect([...ROLES]).toEqual(["admin", "designer"]);
    expect(isRole("admin")).toBe(true);
    expect(isRole("Admin")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it("lets an admin do designer work", () => {
    expect(hasRole({ role: "admin" }, "designer")).toBe(true);
    expect(hasRole({ role: "admin" }, "admin")).toBe(true);
  });

  it("never gives a designer admin permissions", () => {
    expect(hasRole({ role: "designer" }, "designer")).toBe(true);
    expect(hasRole({ role: "designer" }, "admin")).toBe(false);
  });
});
