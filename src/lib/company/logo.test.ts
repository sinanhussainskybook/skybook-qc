import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeStorage } from "../../../test/fake-storage";
import { PNG, SAFE_SVG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import { insertCompany } from "@/lib/db/companies";
import { getCompanyLogo } from "@/lib/db/company-logos";
import { checkLogoFile, type CheckedLogo } from "@/lib/company/logo-file";
import { logoImageUrl, removeCompanyLogo, saveCompanyLogo } from "@/lib/company/logo";

function checked(name: string, type: string, bytes: Uint8Array): CheckedLogo {
  const result = checkLogoFile({ name, type, size: bytes.length, bytes });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A database whose logo writes fail, to test clean-up. */
function failingLogoWrites(db: Database): Database {
  return {
    exec: db.exec,
    async query(text, params) {
      if (/company_logos/.test(text) && /insert|delete/i.test(text)) throw new Error("fake database failure");
      return db.query(text, params);
    },
  };
}

describe("saving and removing a company logo (Storage faked)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let acme: string;
  let fake: ReturnType<typeof createFakeStorage>;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
  });
  afterAll(() => close());
  beforeEach(async () => {
    fake = createFakeStorage();
    await db.query("delete from company_logos");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("uploads the file under the company's own folder, then saves the metadata", async () => {
    expect(await saveCompanyLogo(db, fake.storage, acme, checked("Acme.png", "image/png", PNG))).toEqual({ ok: true });

    const logo = await getCompanyLogo(db, acme);
    expect(logo?.storage_path).toMatch(new RegExp(`^${acme}/[0-9a-f-]{36}\\.png$`));
    expect(logo).toMatchObject({ file_name: "Acme.png", mime_type: "image/png", file_size: PNG.length });
    expect([...fake.files.keys()]).toEqual([logo!.storage_path]);
    expect(fake.files.get(logo!.storage_path)?.contentType).toBe("image/png");
  });

  it("replacing deletes the old file — only the current logo is kept", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("old.png", "image/png", PNG));
    const oldPath = (await getCompanyLogo(db, acme))!.storage_path;

    expect(await saveCompanyLogo(db, fake.storage, acme, checked("new.svg", "image/svg+xml", SAFE_SVG))).toEqual({ ok: true });
    const current = (await getCompanyLogo(db, acme))!;
    expect(current).toMatchObject({ file_name: "new.svg", mime_type: "image/svg+xml" });
    expect(current.storage_path).not.toBe(oldPath);
    expect([...fake.files.keys()]).toEqual([current.storage_path]);
    expect(fake.calls).toContain(`remove ${oldPath}`);
  });

  it("Storage failure on upload: nothing is saved and the old logo stays", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("old.png", "image/png", PNG));
    const before = await getCompanyLogo(db, acme);
    fake.failing.upload = true;

    expect(await saveCompanyLogo(db, fake.storage, acme, checked("new.png", "image/png", PNG))).toEqual({
      ok: false,
      reason: "storage",
    });
    expect(await getCompanyLogo(db, acme)).toEqual(before);
    expect([...fake.files.keys()]).toEqual([before!.storage_path]);
  });

  it("database failure: the newly uploaded file is deleted again", async () => {
    expect(
      await saveCompanyLogo(failingLogoWrites(db), fake.storage, acme, checked("new.png", "image/png", PNG))
    ).toEqual({ ok: false, reason: "database" });
    expect(fake.files.size).toBe(0);
    expect(fake.calls.filter((c) => c.startsWith("remove"))).toHaveLength(1);
    expect(await getCompanyLogo(db, acme)).toBeNull();
  });

  it("if the old file can't be deleted on replace, the new logo is still saved and the problem is reported", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("old.png", "image/png", PNG));
    const oldPath = (await getCompanyLogo(db, acme))!.storage_path;
    fake.failing.remove = true;

    expect(await saveCompanyLogo(db, fake.storage, acme, checked("new.png", "image/png", PNG))).toEqual({
      ok: true,
      cleanupFailed: true,
    });
    expect((await getCompanyLogo(db, acme))!.file_name).toBe("new.png");
    expect(fake.files.has(oldPath)).toBe(true); // left for manual clean-up, and logged
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(oldPath), expect.anything());
  });

  it("removing deletes the metadata and the file", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("logo.png", "image/png", PNG));
    expect(await removeCompanyLogo(db, fake.storage, acme)).toEqual({ ok: true });
    expect(await getCompanyLogo(db, acme)).toBeNull();
    expect(fake.files.size).toBe(0);
  });

  it("removing when there's no logo says so", async () => {
    expect(await removeCompanyLogo(db, fake.storage, acme)).toEqual({ ok: false, reason: "no-logo" });
  });

  it("if the file can't be deleted on remove, the logo is still gone from the page", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("logo.png", "image/png", PNG));
    fake.failing.remove = true;
    expect(await removeCompanyLogo(db, fake.storage, acme)).toEqual({ ok: true, cleanupFailed: true });
    expect(await getCompanyLogo(db, acme)).toBeNull();
  });

  it("database failure on remove: nothing is deleted", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("logo.png", "image/png", PNG));
    expect(await removeCompanyLogo(failingLogoWrites(db), fake.storage, acme)).toEqual({
      ok: false,
      reason: "database",
    });
    expect(await getCompanyLogo(db, acme)).not.toBeNull();
    expect(fake.files.size).toBe(1);
  });

  it("makes a 1-hour link to show the logo, and copes with Storage being down", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("logo.png", "image/png", PNG));
    const logo = await getCompanyLogo(db, acme);
    expect(await logoImageUrl(fake.storage, logo)).toBe(`https://storage.test/sign/${logo!.storage_path}?expires=3600`);
    expect(await logoImageUrl(fake.storage, null)).toBeNull();
    expect(await logoImageUrl(null, logo)).toBeNull();
    fake.failing.sign = true;
    expect(await logoImageUrl(fake.storage, logo)).toBeNull();
  });
});
