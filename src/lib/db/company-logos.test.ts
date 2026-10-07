import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { insertCompany } from "@/lib/db/companies";
import { deleteCompanyLogo, getCompanyLogo, upsertCompanyLogo } from "@/lib/db/company-logos";
import { loadCompanyConfiguration } from "@/lib/db/company-config";
import { findAccessibleCompany } from "@/lib/db/companies";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("company_logos (metadata)", () => {
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

  const logo = (companyId: string, file = UUID_A, ext = "png", mime = "image/png") => ({
    fileName: `Acme logo.${ext}`,
    storagePath: `${companyId}/${file}.${ext}`,
    mimeType: mime,
    fileSize: 34_567,
  });

  it("creates a logo record for the company with its metadata", async () => {
    expect(await upsertCompanyLogo(db, acme, logo(acme))).toEqual({ previousPath: null });
    const saved = await getCompanyLogo(db, acme);
    expect(saved).toMatchObject({
      file_name: "Acme logo.png",
      storage_path: `${acme}/${UUID_A}.png`,
      mime_type: "image/png",
      file_size: 34_567,
    });
    expect(saved?.created_at).toBeInstanceOf(Date);
    expect(await getCompanyLogo(db, globex)).toBeNull();
  });

  it("keeps only one current logo per company — replacing returns the old path", async () => {
    const replaced = await upsertCompanyLogo(db, acme, logo(acme, UUID_B, "svg", "image/svg+xml"));
    expect(replaced).toEqual({ previousPath: `${acme}/${UUID_A}.png` });
    const rows = await db.query("select storage_path, mime_type from company_logos where company_id = $1", [acme]);
    expect(rows).toEqual([{ storage_path: `${acme}/${UUID_B}.svg`, mime_type: "image/svg+xml" }]);
  });

  it("the database itself refuses a second logo row for a company", async () => {
    await expect(
      db.query(
        `insert into company_logos (company_id, file_name, storage_path, mime_type, file_size)
         values ($1, 'x.png', $2, 'image/png', 1)`,
        [acme, `${acme}/${UUID_A}.png`]
      )
    ).rejects.toThrow();
  });

  it("refuses a storage path that belongs to another company (forged relationship)", async () => {
    await expect(upsertCompanyLogo(db, globex, logo(acme))).rejects.toThrow();
    await expect(upsertCompanyLogo(db, globex, { ...logo(globex), storagePath: "../other/logo.png" })).rejects.toThrow();
    await expect(upsertCompanyLogo(db, globex, { ...logo(globex), storagePath: `${globex}/logo` })).rejects.toThrow();
    expect(await getCompanyLogo(db, globex)).toBeNull();
  });

  it("refuses types and sizes outside the logo rules", async () => {
    await expect(upsertCompanyLogo(db, globex, { ...logo(globex), mimeType: "text/html" })).rejects.toThrow();
    await expect(upsertCompanyLogo(db, globex, { ...logo(globex), fileSize: 0 })).rejects.toThrow();
    await expect(upsertCompanyLogo(db, globex, { ...logo(globex), fileSize: 2 * 1024 * 1024 + 1 })).rejects.toThrow();
  });

  it("is part of the company configuration the QC engine will read", async () => {
    const config = await loadCompanyConfiguration(
      db,
      (await findAccessibleCompany(db, { id: "00000000-0000-4000-8000-000000000000", role: "admin" }, acme))!
    );
    expect(config.logo).toMatchObject({ mime_type: "image/svg+xml" });
  });

  it("deletes the record and returns the file path to remove", async () => {
    expect(await deleteCompanyLogo(db, acme)).toBe(`${acme}/${UUID_B}.svg`);
    expect(await getCompanyLogo(db, acme)).toBeNull();
    expect(await deleteCompanyLogo(db, acme)).toBeNull();
  });

  it("leaves no logo metadata behind when a company is deleted", async () => {
    await upsertCompanyLogo(db, globex, logo(globex));
    await db.query("delete from companies where id = $1", [globex]);
    expect(await db.query("select 1 from company_logos where company_id = $1", [globex])).toEqual([]);
  });
});
