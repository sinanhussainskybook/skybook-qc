import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeStorage } from "../../../test/fake-storage";
import { PNG, SAFE_SVG } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import { insertCompany } from "@/lib/db/companies";
import { getCompanyLogo } from "@/lib/db/company-logos";
import { checkLogoFile, type CheckedLogo } from "@/lib/company/logo-file";
import { CARD_LOGOS_TIMEOUT_MS, companyLogoUrls, logoImageUrl, removeCompanyLogo, saveCompanyLogo } from "@/lib/company/logo";
import type { LogoStorage } from "@/lib/storage/logo-storage";

function checked(name: string, type: string, bytes: Uint8Array): CheckedLogo {
  const result = checkLogoFile({ name, type, size: bytes.length, bytes });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** A database whose logo writes fail, to test clean-up. */
function failingLogoWrites(db: Database): Database {
  const failing: Database = {
    exec: db.exec,
    transaction: (fn) => fn(failing),
    async query(text, params) {
      if (/company_logos/.test(text) && /insert|delete/i.test(text)) throw new Error("fake database failure");
      return db.query(text, params);
    },
  };
  return failing;
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

  it("makes a link for each company card's own logo, leaving out companies without one", async () => {
    const dee = await insertTestUser(db, { name: "Card", email: "card@skybook.com", role: "designer" });
    const globex = (await insertCompany(db, { name: "Globex", createdBy: dee.id })).id;
    const initech = (await insertCompany(db, { name: "Initech", createdBy: dee.id })).id;
    await saveCompanyLogo(db, fake.storage, acme, checked("acme.png", "image/png", PNG));
    await saveCompanyLogo(db, fake.storage, globex, checked("globex.svg", "image/svg+xml", SAFE_SVG));
    const acmePath = (await getCompanyLogo(db, acme))!.storage_path;
    const globexPath = (await getCompanyLogo(db, globex))!.storage_path;

    expect(await companyLogoUrls(db, fake.storage, [acme, globex, initech])).toEqual({
      [acme]: `https://storage.test/sign/${acmePath}?expires=3600`,
      [globex]: `https://storage.test/sign/${globexPath}?expires=3600`,
    });
    expect(await companyLogoUrls(db, fake.storage, [])).toEqual({});
  });

  it("card logos: no Storage, Storage down or the database failing → no links (cards show the initial)", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("acme.png", "image/png", PNG));
    expect(await companyLogoUrls(db, null, [acme])).toEqual({});
    const failingReads: Database = { exec: db.exec, query: async () => { throw new Error("fake database failure"); }, transaction: (fn) => fn(failingReads) };
    expect(await companyLogoUrls(failingReads, fake.storage, [acme])).toEqual({});
    fake.failing.sign = true;
    expect(await companyLogoUrls(db, fake.storage, [acme])).toEqual({});
  });

  it("card logos have their own short deadline: a slow Storage link is left out, the fast ones are kept", async () => {
    const dee = await insertTestUser(db, { name: "Slow", email: "slow@skybook.com", role: "designer" });
    const globex = (await insertCompany(db, { name: "Globex", createdBy: dee.id })).id;
    await saveCompanyLogo(db, fake.storage, acme, checked("acme.png", "image/png", PNG));
    await saveCompanyLogo(db, fake.storage, globex, checked("globex.png", "image/png", PNG));
    const globexPath = (await getCompanyLogo(db, globex))!.storage_path;

    // Globex's link hangs until released — far longer than the deadline.
    let release = () => {};
    const slow: LogoStorage = {
      ...fake.storage,
      signedUrl: (path, seconds) =>
        path === globexPath
          ? new Promise((resolve) => (release = () => resolve(`https://storage.test/late/${path}`)))
          : fake.storage.signedUrl(path, seconds),
    };

    const started = Date.now();
    const urls = await companyLogoUrls(db, slow, [acme, globex], 100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(Object.keys(urls)).toEqual([acme]); // Globex's card shows its initial
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("took longer than 100 ms"));

    // The late link doesn't change what the page already got.
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Object.keys(urls)).toEqual([acme]);
  });

  it("card logos: a hanging database lookup also gives up at the deadline (all cards show initials)", async () => {
    await saveCompanyLogo(db, fake.storage, acme, checked("acme.png", "image/png", PNG));
    const hanging: Database = { exec: db.exec, query: () => new Promise(() => {}), transaction: (fn) => fn(hanging) };
    const started = Date.now();
    expect(await companyLogoUrls(hanging, fake.storage, [acme], 100)).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the card deadline is short and separate from Storage's 20-second request timeout", () => {
    expect(CARD_LOGOS_TIMEOUT_MS).toBe(2_000);
  });
});
