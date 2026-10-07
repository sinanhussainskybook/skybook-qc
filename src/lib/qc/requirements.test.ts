import { describe, expect, it } from "vitest";
import { checkRequirement, REQUIREMENT_TYPES, requirementTypeLabel } from "@/lib/qc/requirements";

const form = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("requirements", () => {
  it("offers the common types, including Other", () => {
    const keys = REQUIREMENT_TYPES.map((t) => t.value);
    for (const key of ["headline", "offer", "price", "percentage", "date", "time", "phone", "whatsapp", "email", "website", "cta", "disclaimer", "dimensions", "target_audience", "special_instruction", "other"]) {
      expect(keys, key).toContain(key);
    }
    expect(new Set(keys).size).toBe(keys.length);
    // A type added to the database later still gets a readable name.
    expect(requirementTypeLabel("launch_venue")).toBe("launch venue");
  });

  it("accepts a requirement, tidies it, and reads the two flags", () => {
    expect(
      checkRequirement(form({ type: "offer", label: "  Summer ", expected_value: " 20% discount ", notes: "", mandatory: "on", confirmed: "on" }))
    ).toEqual({
      ok: true,
      value: { type: "offer", label: "Summer", expected_value: "20% discount", notes: null, mandatory: true, confirmed: true },
    });
  });

  it("an unticked box means not mandatory / not confirmed", () => {
    expect(checkRequirement(form({ type: "cta", expected_value: "Book now" }))).toMatchObject({
      ok: true,
      value: { mandatory: false, confirmed: false, label: null },
    });
  });

  it("needs a known type and an expected value", () => {
    const result = checkRequirement(form({ type: "vibes", expected_value: "   " }));
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(["expected_value", "type"]);
  });

  it("limits lengths", () => {
    expect(checkRequirement(form({ type: "headline", expected_value: "x".repeat(2001) })).ok).toBe(false);
    expect(checkRequirement(form({ type: "headline", expected_value: "ok", notes: "x".repeat(1001) })).ok).toBe(false);
    expect(checkRequirement(form({ type: "headline", expected_value: "ok", label: "x".repeat(121) })).ok).toBe(false);
  });
});
