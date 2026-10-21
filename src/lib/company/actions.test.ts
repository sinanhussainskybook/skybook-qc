import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";

/**
 * The server actions and page access checks, run against a real (in-memory)
 * PostgreSQL. Only sign-in and Next.js navigation are stand-ins.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as Database,
  user: null as User | null,
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/current-user", () => ({
  requireUser: async () => {
    if (!state.user) throw new Error("NEXT_REDIRECT /login");
    return state.user;
  },
}));

const actions = await import("@/lib/company/actions");
const { requireCompanyAccess, getCompaniesForCurrentUser } = await import("@/lib/company/access");
const { insertCompany } = await import("@/lib/db/companies");
const { listItems, insertItem } = await import("@/lib/db/company-lists");

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("company actions and access", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let ada: User;
  let acme: string; // Dee's company
  let globex: string; // Sam's company

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee Designer", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(test.db, { name: "Sam Designer", email: "sam@skybook.com", role: "designer" });
    ada = await insertTestUser(test.db, { name: "Ada Admin", email: "ada@skybook.com", role: "admin" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    globex = (await insertCompany(test.db, { name: "Globex", createdBy: sam.id })).id;
  });
  afterAll(() => close());
  beforeEach(() => {
    state.user = dee;
  });

  const companyName = async (id: string) =>
    (await state.db.query<{ name: string }>("select name from companies where id = $1", [id]))[0]?.name;

  describe("pages: requireCompanyAccess", () => {
    it("lets a member open their company", async () => {
      await expect(requireCompanyAccess(acme)).resolves.toMatchObject({ company: { name: "Acme" } });
    });

    it("shows 'not found' for another designer's company, a made-up ID or junk", async () => {
      for (const id of [globex, "00000000-0000-4000-8000-000000000000", "1", "../admin", undefined]) {
        await expect(requireCompanyAccess(id), String(id)).rejects.toThrow("NEXT_NOT_FOUND");
      }
    });

    it("lets an admin open any company", async () => {
      state.user = ada;
      await expect(requireCompanyAccess(globex)).resolves.toMatchObject({ company: { name: "Globex" } });
    });

    it("sends a signed-out visitor to sign in", async () => {
      state.user = null;
      await expect(requireCompanyAccess(acme)).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(getCompaniesForCurrentUser()).rejects.toThrow("NEXT_REDIRECT /login");
    });

    it("lists the user's own companies for the dashboard", async () => {
      expect((await getCompaniesForCurrentUser()).companies.map((c) => c.name)).toEqual(["Acme"]);
    });
  });

  describe("add company", () => {
    it("creates the company and opens it", async () => {
      await expect(
        actions.createCompanyAction({}, form({ name: "  New  Client " }))
      ).rejects.toThrow(/NEXT_REDIRECT \/companies\/[0-9a-f-]{36}$/);
      const [row] = await state.db.query<{ id: string; created_by: string }>(
        "select id, created_by from companies where name = 'New Client'"
      );
      expect(row.created_by).toBe(dee.id);
      await expect(requireCompanyAccess(row.id)).resolves.toBeTruthy();
    });

    it("refuses an empty or invalid name and saves nothing", async () => {
      const before = await state.db.query("select id from companies");
      expect(await actions.createCompanyAction({}, form({ name: "   " }))).toMatchObject({
        error: expect.stringMatching(/company name/),
      });
      expect(await actions.createCompanyAction({}, form({ name: "x".repeat(121) }))).toMatchObject({
        error: expect.any(String),
      });
      expect(await state.db.query("select id from companies")).toHaveLength(before.length);
    });

    it("requires sign-in", async () => {
      state.user = null;
      await expect(actions.createCompanyAction({}, form({ name: "Sneaky" }))).rejects.toThrow(
        "NEXT_REDIRECT /login"
      );
      expect(await state.db.query("select id from companies where name = 'Sneaky'")).toEqual([]);
    });
  });

  describe("edit one field", () => {
    const save = (companyId: string, section: string, field: string, value: string) =>
      actions.saveCompanyFieldAction({}, form({ companyId, section, field, value }));

    it("saves valid information and contact details", async () => {
      expect(await save(acme, "info", "country", " United Arab Emirates ")).toEqual({ ok: true });
      expect(await save(acme, "contact", "email", "hello@acme.com")).toEqual({ ok: true });
      expect(await save(acme, "contact", "website", "acme.com")).toEqual({ ok: true });
      const [contact] = await state.db.query(
        "select email, website from company_contacts where company_id = $1",
        [acme]
      );
      expect(contact).toEqual({ email: "hello@acme.com", website: "https://acme.com" });
    });

    it("shows the check's message for invalid values and saves nothing", async () => {
      expect(await save(acme, "contact", "email", "not-an-email")).toMatchObject({ error: /valid email/ });
      expect(await save(acme, "contact", "whatsapp", "050 123 4567")).toMatchObject({ error: /country code/ });
      expect(await save(acme, "contact", "phone", "call me")).toMatchObject({ error: expect.any(String) });
      expect(await save(acme, "contact", "additional_phone", "call me")).toMatchObject({ error: expect.any(String) });
      expect(await save(acme, "contact", "additional_phone", "12")).toMatchObject({ error: expect.any(String) });
      expect(await save(acme, "contact", "website", "javascript:alert(1)")).toMatchObject({ error: expect.any(String) });
      expect(await save(acme, "info", "name", "   ")).toMatchObject({ error: /company name/ });
      expect(await companyName(acme)).toBe("Acme");
    });

    it("refuses fields that aren't editable (e.g. forging 'active')", async () => {
      expect(await save(acme, "info", "active", "false")).toEqual({ error: "This field can't be edited." });
      expect(await save(acme, "info", "created_by", sam.id)).toEqual({ error: "This field can't be edited." });
    });

    it("can't change another company by putting its ID in the form", async () => {
      expect(await save(globex, "info", "name", "Hijacked")).toMatchObject({ error: /isn't available/ });
      expect(await save("not-a-uuid", "info", "name", "Hijacked")).toMatchObject({ error: /isn't available/ });
      expect(await companyName(globex)).toBe("Globex");
    });

    it("requires sign-in", async () => {
      state.user = null;
      await expect(save(acme, "info", "name", "Signed out")).rejects.toThrow("NEXT_REDIRECT /login");
      expect(await companyName(acme)).toBe("Acme");
    });
  });

  describe("brand guideline and Golden Rule lists", () => {
    const saveItem = (values: Record<string, string>) => actions.saveListItemAction({}, form(values));

    it("adds and edits a brand colour", async () => {
      expect(await saveItem({ companyId: acme, list: "brand_colors", name: "Sky", hex: "1a64b4" })).toEqual({ ok: true });
      const [color] = await listItems(state.db, "brand_colors", acme);
      expect(color).toMatchObject({ name: "Sky", hex: "#1A64B4" });

      expect(
        await saveItem({ companyId: acme, list: "brand_colors", itemId: color.id, name: "Sky Blue", hex: "#1A64B4", cmyk: "85 45 0 29" })
      ).toEqual({ ok: true });
      expect(await listItems(state.db, "brand_colors", acme)).toMatchObject([{ name: "Sky Blue", cmyk: "85, 45, 0, 29" }]);
    });

    it("saves a brand term — its 'kind' field doesn't clash with the list name (regression)", async () => {
      expect(
        await saveItem({ companyId: acme, list: "brand_terms", term: "Acme Props", kind: "banned", note: "" })
      ).toEqual({ ok: true });
      expect(await listItems(state.db, "brand_terms", acme)).toMatchObject([
        { term: "Acme Props", kind: "banned", note: null },
      ]);
    });

    it("returns a message per invalid field", async () => {
      expect(await saveItem({ companyId: acme, list: "brand_colors", name: "", hex: "blue" })).toEqual({
        errors: { name: expect.any(String), hex: expect.any(String) },
      });
      expect(await saveItem({ companyId: acme, list: "app_users", name: "x" })).toEqual({
        error: "This list can't be edited.",
      });
    });

    it("adds, edits, switches off/on and removes a Golden Rule", async () => {
      expect(
        await saveItem({ companyId: acme, list: "golden_rules", rule: "Use the approved CTA", category: "approved_cta", approved_value: "Book a viewing", mandatory: "on" })
      ).toEqual({ ok: true });
      let [rule] = await listItems(state.db, "golden_rules", acme);
      expect(rule).toMatchObject({ category: "approved_cta", mandatory: true, active: true });

      expect(
        await saveItem({ companyId: acme, list: "golden_rules", itemId: rule.id, rule: "Use the approved CTA only", category: "approved_cta", approved_value: "Book a viewing" })
      ).toEqual({ ok: true });
      [rule] = await listItems(state.db, "golden_rules", acme);
      expect(rule).toMatchObject({ rule: "Use the approved CTA only", mandatory: false, active: true });

      expect(await actions.setGoldenRuleActiveAction({}, form({ companyId: acme, itemId: rule.id, active: "false" }))).toEqual({ ok: true });
      expect((await listItems(state.db, "golden_rules", acme))[0].active).toBe(false);
      expect(await actions.setGoldenRuleActiveAction({}, form({ companyId: acme, itemId: rule.id, active: "true" }))).toEqual({ ok: true });
      expect((await listItems(state.db, "golden_rules", acme))[0].active).toBe(true);

      expect(await actions.deleteListItemAction({}, form({ companyId: acme, list: "golden_rules", itemId: rule.id }))).toEqual({ ok: true });
      expect(await listItems(state.db, "golden_rules", acme)).toEqual([]);
    });

    it("can't touch another company's Golden Rule by changing IDs", async () => {
      const samsRule = await insertItem(state.db, "golden_rules", globex, {
        rule: "Globex rule",
        category: "other",
        approved_value: null,
        mandatory: true,
      });
      const hijack = { rule: "Hijacked", category: "other" };

      // Dee names Sam's company directly: no access.
      expect(await saveItem({ companyId: globex, list: "golden_rules", itemId: samsRule, ...hijack })).toMatchObject({ error: /isn't available/ });
      expect(await saveItem({ companyId: globex, list: "golden_rules", ...hijack })).toMatchObject({ error: /isn't available/ });
      // Dee names her own company but Sam's rule ID: the rule isn't in her company.
      expect(await saveItem({ companyId: acme, list: "golden_rules", itemId: samsRule, ...hijack })).toMatchObject({ error: /isn't available/ });
      expect(await actions.setGoldenRuleActiveAction({}, form({ companyId: acme, itemId: samsRule, active: "false" }))).toMatchObject({ error: /isn't available/ });
      expect(await actions.deleteListItemAction({}, form({ companyId: acme, list: "golden_rules", itemId: samsRule }))).toMatchObject({ error: /isn't available/ });
      expect(await actions.deleteListItemAction({}, form({ companyId: globex, list: "golden_rules", itemId: samsRule }))).toMatchObject({ error: /isn't available/ });

      expect(await listItems(state.db, "golden_rules", globex)).toMatchObject([
        { id: samsRule, rule: "Globex rule", active: true, mandatory: true },
      ]);
      expect(await listItems(state.db, "golden_rules", acme)).toEqual([]);
    });

    it("requires sign-in for every list action", async () => {
      state.user = null;
      await expect(saveItem({ companyId: acme, list: "golden_rules", rule: "x", category: "other" })).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.deleteListItemAction({}, form({ companyId: acme, list: "golden_rules", itemId: "00000000-0000-4000-8000-000000000000" }))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(actions.setGoldenRuleActiveAction({}, form({ companyId: acme, itemId: "00000000-0000-4000-8000-000000000000", active: "true" }))).rejects.toThrow("NEXT_REDIRECT /login");
    });
  });
});
