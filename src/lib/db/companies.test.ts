import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import {
  addCompanyMember,
  findAccessibleCompany,
  insertCompany,
  listCompaniesForUser,
} from "@/lib/db/companies";
import { saveCompanyField } from "@/lib/db/company-fields";
import { insertItem } from "@/lib/db/company-lists";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { grantCompanyAccess } from "@/lib/company/grant";

type TestUser = Awaited<ReturnType<typeof insertTestUser>>;

describe("companies and access (D13)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let dee: TestUser; // designer
  let sam: TestUser; // another designer
  let ada: TestUser; // admin
  let acme: { id: string; name: string };
  let globex: { id: string; name: string };

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    dee = await insertTestUser(db, { name: "Dee Designer", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(db, { name: "Sam Designer", email: "sam@skybook.com", role: "designer" });
    ada = await insertTestUser(db, { name: "Ada Admin", email: "ada@skybook.com", role: "admin" });
    acme = await insertCompany(db, { name: "Acme Properties", createdBy: dee.id });
    globex = await insertCompany(db, { name: "Globex", createdBy: sam.id });
  });
  afterAll(() => close());

  it("creates a company, active, with its creator as a member", async () => {
    const company = await findAccessibleCompany(db, dee, acme.id);
    expect(company).toMatchObject({ name: "Acme Properties", active: true, description: null });
    const members = await db.query("select user_id from company_members where company_id = $1", [acme.id]);
    expect(members).toEqual([{ user_id: dee.id }]);
  });

  it("the database refuses empty or untrimmed names too", async () => {
    await expect(insertCompany(db, { name: "", createdBy: dee.id })).rejects.toThrow();
    await expect(insertCompany(db, { name: " Acme ", createdBy: dee.id })).rejects.toThrow();
  });

  it("lists only the companies a designer is a member of", async () => {
    expect((await listCompaniesForUser(db, dee)).map((c) => c.name)).toEqual(["Acme Properties"]);
    expect((await listCompaniesForUser(db, sam)).map((c) => c.name)).toEqual(["Globex"]);
  });

  it("lists every company for an admin, by name", async () => {
    expect((await listCompaniesForUser(db, ada)).map((c) => c.name)).toEqual([
      "Acme Properties",
      "Globex",
    ]);
  });

  it("opens (selects) a company only for members and admins", async () => {
    expect(await findAccessibleCompany(db, dee, acme.id)).not.toBeNull();
    expect(await findAccessibleCompany(db, ada, acme.id)).not.toBeNull();
    expect(await findAccessibleCompany(db, sam, acme.id)).toBeNull(); // changing the ID doesn't help
    expect(await findAccessibleCompany(db, dee, globex.id)).toBeNull();
    expect(
      await findAccessibleCompany(db, dee, "00000000-0000-4000-8000-000000000000")
    ).toBeNull();
  });

  it("company:grant gives another designer access", async () => {
    const company = await insertCompany(db, { name: "Initech", createdBy: dee.id });
    expect(await findAccessibleCompany(db, sam, company.id)).toBeNull();

    expect(await grantCompanyAccess(db, { company: "initech", email: "SAM@skybook.com" })).toEqual({
      ok: true,
      companyName: "Initech",
      userName: "Sam Designer",
      alreadyMember: false,
    });
    expect(await findAccessibleCompany(db, sam, company.id)).not.toBeNull();
    expect(await grantCompanyAccess(db, { company: company.id, email: "sam@skybook.com" })).toMatchObject({
      ok: true,
      alreadyMember: true,
    });
  });

  it("company:grant explains what's wrong instead of guessing", async () => {
    expect(await grantCompanyAccess(db, { company: "Nope Ltd", email: "sam@skybook.com" })).toMatchObject({
      ok: false,
      error: /No company/,
    });
    expect(await grantCompanyAccess(db, { company: "Globex", email: "nobody@skybook.com" })).toMatchObject({
      ok: false,
      error: /No user/,
    });
    await insertCompany(db, { name: "Twin", createdBy: dee.id });
    await insertCompany(db, { name: "twin", createdBy: sam.id });
    expect(await grantCompanyAccess(db, { company: "Twin", email: "ada@skybook.com" })).toMatchObject({
      ok: false,
      error: /More than one company/,
    });
    expect(await addCompanyMember(db, acme.id, dee.id)).toBe(false);
  });

  describe("saving information, contact and brand text", () => {
    it("edits company information and it persists", async () => {
      await saveCompanyField(db, "info", acme.id, "description", "Luxury apartments in Dubai.");
      await saveCompanyField(db, "info", acme.id, "city", "Dubai");
      await saveCompanyField(db, "info", acme.id, "name", "Acme Properties LLC");
      const company = await findAccessibleCompany(db, dee, acme.id);
      expect(company).toMatchObject({
        name: "Acme Properties LLC",
        description: "Luxury apartments in Dubai.",
        city: "Dubai",
      });
    });

    it("saves contact details one at a time, creating the row on first save", async () => {
      await saveCompanyField(db, "contact", acme.id, "phone", "+971 4 123 4567");
      await saveCompanyField(db, "contact", acme.id, "website", "https://acme.com");
      const [row] = await db.query("select phone, whatsapp, email, website from company_contacts where company_id = $1", [acme.id]);
      expect(row).toEqual({ phone: "+971 4 123 4567", whatsapp: null, email: null, website: "https://acme.com" });

      await saveCompanyField(db, "contact", acme.id, "phone", null); // cleared
      const [after] = await db.query<{ phone: string | null }>("select phone from company_contacts where company_id = $1", [acme.id]);
      expect(after.phone).toBeNull();
    });

    it("refuses a column that isn't an editable field", async () => {
      await expect(saveCompanyField(db, "info", acme.id, "active", "false")).rejects.toThrow(/Unknown field/);
      await expect(saveCompanyField(db, "info", acme.id, "created_by", ada.id)).rejects.toThrow(/Unknown field/);
    });

    it("the database refuses a website that isn't http(s)", async () => {
      await expect(saveCompanyField(db, "contact", acme.id, "website", "javascript:alert(1)")).rejects.toThrow();
    });

    it("saves brand text for one company only", async () => {
      await saveCompanyField(db, "brand", acme.id, "tone", "Warm and confident.");
      await saveCompanyField(db, "brand", globex.id, "tone", "Playful.");
      const acmeConfig = await loadCompanyConfiguration(db, (await findAccessibleCompany(db, ada, acme.id))!);
      const globexConfig = await loadCompanyConfiguration(db, (await findAccessibleCompany(db, ada, globex.id))!);
      expect(acmeConfig.brand.tone).toBe("Warm and confident.");
      expect(globexConfig.brand.tone).toBe("Playful.");
    });
  });

  describe("loadCompanyConfiguration (what the QC engine will read)", () => {
    it("returns empty contact and brand for a new company", async () => {
      const company = await insertCompany(db, { name: "Fresh Co", createdBy: dee.id });
      const config = await loadCompanyConfiguration(db, (await findAccessibleCompany(db, dee, company.id))!);
      expect(config.contact).toEqual({ phone: null, whatsapp: null, email: null, website: null });
      expect(config.brand).toMatchObject({ tone: null, colors: [], fonts: [], terms: [] });
      expect(config.goldenRules).toEqual([]);
    });

    it("returns everything saved for the company, and nothing from others", async () => {
      await insertItem(db, "golden_rules", acme.id, {
        rule: "Show the licence number",
        category: "mandatory_disclaimer",
        approved_value: "RERA 12345",
        mandatory: true,
      });
      await insertItem(db, "golden_rules", globex.id, {
        rule: "Globex rule",
        category: "other",
        approved_value: null,
        mandatory: false,
      });
      const config = await loadCompanyConfiguration(db, (await findAccessibleCompany(db, dee, acme.id))!);
      expect(config.goldenRules.map((r) => r.rule)).toEqual(["Show the licence number"]);
      expect(config.contact.website).toBe("https://acme.com");
    });
  });

  it("removing a company removes everything it owns", async () => {
    const company = await insertCompany(db, { name: "Short Lived", createdBy: dee.id });
    await saveCompanyField(db, "contact", company.id, "email", "a@b.co");
    await insertItem(db, "brand_colors", company.id, { name: "Red", hex: "#FF0000", cmyk: null, usage: null });
    await db.query("delete from companies where id = $1", [company.id]);
    for (const table of ["company_members", "company_contacts", "brand_colors"]) {
      expect(await db.query(`select 1 from ${table} where company_id = $1`, [company.id]), table).toEqual([]);
    }
  });
});
