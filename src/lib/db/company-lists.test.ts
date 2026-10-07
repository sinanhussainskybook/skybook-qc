import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { insertCompany } from "@/lib/db/companies";
import {
  deleteItem,
  insertItem,
  listItems,
  setGoldenRuleActive,
  updateItem,
} from "@/lib/db/company-lists";

describe("brand lists and Golden Rules", () => {
  let db: Database;
  let close: () => Promise<void>;
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
    globex = (await insertCompany(db, { name: "Globex", createdBy: dee.id })).id;
  });
  afterAll(() => close());

  describe("brand guidelines", () => {
    it("saves, edits and reads back colours", async () => {
      const id = await insertItem(db, "brand_colors", acme, {
        name: "Sky Blue",
        hex: "#1A64B4",
        cmyk: "85, 45, 0, 29",
        usage: "Headlines",
      });
      expect(await listItems(db, "brand_colors", acme)).toMatchObject([
        { id, name: "Sky Blue", hex: "#1A64B4", cmyk: "85, 45, 0, 29", usage: "Headlines" },
      ]);

      expect(
        await updateItem(db, "brand_colors", acme, id, { name: "Skybook Blue", hex: "#1A64B4", cmyk: null, usage: null })
      ).toBe(true);
      expect(await listItems(db, "brand_colors", acme)).toMatchObject([
        { id, name: "Skybook Blue", cmyk: null, usage: null },
      ]);
    });

    it("saves and reads fonts and terms", async () => {
      await insertItem(db, "brand_fonts", acme, {
        family: "Montserrat",
        weights: "Regular 400, Bold 700",
        usage: "Headlines",
        size_guidance: "At least 24 px",
      });
      await insertItem(db, "brand_terms", acme, { term: "SkyBook Pro", kind: "approved", note: null });
      await insertItem(db, "brand_terms", acme, { term: "Sky book", kind: "banned", note: "One word" });

      expect(await listItems(db, "brand_fonts", acme)).toMatchObject([{ family: "Montserrat" }]);
      expect((await listItems(db, "brand_terms", acme)).map((t) => [t.term, t.kind])).toEqual([
        ["SkyBook Pro", "approved"],
        ["Sky book", "banned"],
      ]);
    });

    it("keeps each company's guidelines to itself", async () => {
      expect(await listItems(db, "brand_colors", globex)).toEqual([]);
      expect(await listItems(db, "brand_terms", globex)).toEqual([]);
      const [color] = await listItems(db, "brand_colors", acme);
      // Acme's colour, sent with Globex's ID: nothing changes, nothing is removed.
      expect(
        await updateItem(db, "brand_colors", globex, color.id, { name: "Hijacked", hex: "#000000", cmyk: null, usage: null })
      ).toBe(false);
      expect(await deleteItem(db, "brand_colors", globex, color.id)).toBe(false);
      expect(await listItems(db, "brand_colors", acme)).toMatchObject([{ name: "Skybook Blue", hex: "#1A64B4" }]);
    });

    it("the database refuses bad HEX and unknown term kinds", async () => {
      await expect(
        insertItem(db, "brand_colors", acme, { name: "Bad", hex: "blue", cmyk: null, usage: null })
      ).rejects.toThrow();
      await expect(insertItem(db, "brand_terms", acme, { term: "X", kind: "maybe", note: null })).rejects.toThrow();
    });
  });

  describe("Golden Rules", () => {
    let ruleId: string;

    it("adds a rule — active by default, with category and mandatory flag", async () => {
      ruleId = await insertItem(db, "golden_rules", acme, {
        rule: "Always show the licence disclaimer",
        category: "mandatory_disclaimer",
        approved_value: "Licensed by RERA, no. 12345",
        mandatory: true,
      });
      const [rule] = await listItems(db, "golden_rules", acme);
      expect(rule).toMatchObject({
        id: ruleId,
        rule: "Always show the licence disclaimer",
        category: "mandatory_disclaimer",
        approved_value: "Licensed by RERA, no. 12345",
        mandatory: true,
        active: true,
      });
      expect(rule.created_at).toBeInstanceOf(Date);
      expect(rule.updated_at).toBeInstanceOf(Date);
    });

    it("edits a rule, including making it not mandatory", async () => {
      expect(
        await updateItem(db, "golden_rules", acme, ruleId, {
          rule: "Show the licence disclaimer on every post",
          category: "other",
          approved_value: null,
          mandatory: false,
        })
      ).toBe(true);
      expect(await listItems(db, "golden_rules", acme)).toMatchObject([
        { rule: "Show the licence disclaimer on every post", category: "other", approved_value: null, mandatory: false, active: true },
      ]);
    });

    it("switches a rule off and on again", async () => {
      expect(await setGoldenRuleActive(db, acme, ruleId, false)).toBe(true);
      expect((await listItems(db, "golden_rules", acme))[0].active).toBe(false);
      expect(await setGoldenRuleActive(db, acme, ruleId, true)).toBe(true);
      expect((await listItems(db, "golden_rules", acme))[0].active).toBe(true);
    });

    it("can't be edited, switched or removed through another company", async () => {
      const values = { rule: "Hijacked", category: "other", approved_value: null, mandatory: false };
      expect(await updateItem(db, "golden_rules", globex, ruleId, values)).toBe(false);
      expect(await setGoldenRuleActive(db, globex, ruleId, false)).toBe(false);
      expect(await deleteItem(db, "golden_rules", globex, ruleId)).toBe(false);
      expect(await listItems(db, "golden_rules", globex)).toEqual([]);
      expect(await listItems(db, "golden_rules", acme)).toMatchObject([
        { id: ruleId, rule: "Show the licence disclaimer on every post", active: true },
      ]);
    });

    it("the database refuses unknown categories and empty rules", async () => {
      await expect(
        insertItem(db, "golden_rules", acme, { rule: "X", category: "vibes", approved_value: null, mandatory: false })
      ).rejects.toThrow();
      await expect(
        insertItem(db, "golden_rules", acme, { rule: "", category: "other", approved_value: null, mandatory: false })
      ).rejects.toThrow();
    });

    it("removes a rule", async () => {
      expect(await deleteItem(db, "golden_rules", acme, ruleId)).toBe(true);
      expect(await listItems(db, "golden_rules", acme)).toEqual([]);
      expect(await deleteItem(db, "golden_rules", acme, ruleId)).toBe(false);
    });
  });
});
