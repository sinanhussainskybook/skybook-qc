import { describe, expect, it } from "vitest";
import {
  checkListItem,
  findFieldSpec,
  GOLDEN_RULE_CATEGORIES,
  isListKind,
  LIST_KINDS,
} from "@/lib/company/fields";

describe("editable fields", () => {
  it("covers the required information and contact fields", () => {
    for (const field of ["name", "description", "category", "country", "city", "address"]) {
      expect(findFieldSpec("info", field), field).not.toBeNull();
    }
    for (const field of ["phone", "additional_phone", "whatsapp", "email", "website"]) {
      expect(findFieldSpec("contact", field), field).not.toBeNull();
    }
    for (const field of ["tone", "capitalization_rules", "naming_conventions", "other_guidelines"]) {
      expect(findFieldSpec("brand", field), field).not.toBeNull();
    }
  });

  it("refuses any field or section not listed — a forged form can't reach other columns", () => {
    for (const [section, field] of [
      ["info", "active"],
      ["info", "created_by"],
      ["info", "id"],
      ["info", "__proto__"],
      ["info", "toString"],
      ["contact", "company_id"],
      ["users", "role"],
      ["__proto__", "name"],
    ]) {
      expect(findFieldSpec(section, field), `${section}.${field}`).toBeNull();
    }
  });
});

describe("list items", () => {
  it("knows exactly four lists", () => {
    expect(LIST_KINDS).toEqual(["brand_colors", "brand_fonts", "brand_terms", "golden_rules"]);
    expect(isListKind("app_users")).toBe(false);
    expect(isListKind("constructor")).toBe(false);
  });

  it("checks a Golden Rule: rule, category, approved value, mandatory flag", () => {
    const form: Record<string, string> = {
      rule: "  Always include the licence disclaimer ",
      category: "mandatory_disclaimer",
      approved_value: "Licensed by RERA. ",
      mandatory: "on",
      active: "false", // not a form field — ignored
      company_id: "someone-else", // not a form field — ignored
    };
    expect(checkListItem("golden_rules", (name) => form[name] ?? "")).toEqual({
      ok: true,
      values: {
        rule: "Always include the licence disclaimer",
        category: "mandatory_disclaimer",
        approved_value: "Licensed by RERA.",
        mandatory: true,
      },
    });
  });

  it("an unticked Mandatory box means not mandatory", () => {
    const result = checkListItem("golden_rules", (name) =>
      ({ rule: "Use the approved CTA", category: "approved_cta" })[name] ?? ""
    );
    expect(result).toMatchObject({ ok: true, values: { mandatory: false, approved_value: null } });
  });

  it("rejects a missing rule and an unknown category", () => {
    const result = checkListItem("golden_rules", (name) =>
      ({ rule: " ", category: "vibes" })[name] ?? ""
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(["category", "rule"]);
  });

  it("offers the seven Golden Rule categories", () => {
    expect(GOLDEN_RULE_CATEGORIES.map((c) => c.value)).toEqual([
      "mandatory_disclaimer",
      "approved_product_name",
      "approved_cta",
      "logo_rule",
      "approved_color",
      "approved_font",
      "other",
    ]);
  });

  it("checks colours, fonts and terms", () => {
    expect(
      checkListItem("brand_colors", (n) => ({ name: "Sky", hex: "1a64b4" })[n] ?? "")
    ).toEqual({ ok: true, values: { name: "Sky", hex: "#1A64B4", cmyk: null, usage: null } });
    expect(checkListItem("brand_colors", (n) => ({ name: "Sky", hex: "blue" })[n] ?? "")).toMatchObject({
      ok: false,
      errors: { hex: expect.any(String) },
    });
    expect(checkListItem("brand_fonts", () => "").ok).toBe(false);
    expect(
      checkListItem("brand_terms", (n) => ({ term: "SkyBook Pro", kind: "maybe" })[n] ?? "")
    ).toMatchObject({ ok: false, errors: { kind: expect.any(String) } });
  });
});
