import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { addCompanyMember, insertCompany } from "@/lib/db/companies";
import { upsertCompanyLogo } from "@/lib/db/company-logos";
import { insertItem } from "@/lib/db/company-lists";
import type { LogoStorage } from "@/lib/storage/logo-storage";
import type { QcStorage } from "@/lib/storage/qc-storage";
import { DELETE_COMPANY_MESSAGES as M, deleteCompany } from "@/lib/company/delete-company";

/** Deleting a company against a real (in-memory) PostgreSQL; Storage is a fake that records what was removed. */

function fakeStorage(fail = false, hooks: { onLogoRemove?: () => Promise<void>; failListFor?: string } = {}) {
  const removed: string[] = [];
  const files = new Map<string, string[]>(); // session id → file names
  const logos: LogoStorage = {
    upload: async () => {},
    signedUrl: async () => "",
    remove: async (path) => {
      if (fail) throw new Error("storage down");
      removed.push(path);
      await hooks.onLogoRemove?.(); // something happening in the app while the deletion runs
    },
  };
  const qc = {
    list: async (prefix: string) => {
      if (fail || prefix === hooks.failListFor) throw new Error("storage down");
      return files.get(prefix) ?? [];
    },
    remove: async (paths: string[]) => {
      if (fail) throw new Error("storage down");
      removed.push(...paths);
    },
  } as unknown as QcStorage;
  return { logos, qc, removed, files };
}

describe("deleteCompany", () => {
  let db: Database;
  let close: () => Promise<void>;
  let admin: { id: string; role: string; active: boolean };
  let dee: { id: string; role: string; active: boolean };
  let acme: string;
  let globex: string;
  let session: string;

  beforeAll(async () => ({ db, close } = await createTestDatabase()));
  afterAll(() => close());
  beforeEach(async () => {
    await db.query("truncate app_users, companies cascade");
    admin = await insertTestUser(db, { name: "Ada Admin", email: "ada@skybook.com", role: "admin" });
    dee = await insertTestUser(db, { name: "Dee Designer", email: "dee@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme Villas", createdBy: dee.id })).id;
    globex = (await insertCompany(db, { name: "Globex", createdBy: dee.id })).id;
    await addCompanyMember(db, acme, dee.id); // already a member as creator → false, fine
    await insertItem(db, "brand_colors", acme, { name: "Sky blue", hex: "#1E6FD9" });
    await upsertCompanyLogo(db, acme, { fileName: "logo.png", storagePath: `${acme}/00000000-0000-4000-8000-000000000001.png`, mimeType: "image/png", fileSize: 10 });
    [{ id: session }] = await db.query<{ id: string }>("insert into qc_sessions (company_id, user_id, content_type) values ($1, $2, 'design_poster') returning id", [acme, dee.id]);
  });

  const exists = async (id: string) => (await db.query("select 1 from companies where id = $1", [id])).length === 1;
  const count = async (table: string, companyId: string) =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table} where company_id = $1`, [companyId]))[0].n);

  it("only an active administrator can delete; nothing changes otherwise", async () => {
    const storage = fakeStorage();
    for (const actor of [dee, null, { ...admin, active: false }]) {
      expect(await deleteCompany(db, actor, { companyId: acme, confirmName: "Acme Villas" }, storage)).toEqual({ ok: false, error: M.notAllowed });
    }
    expect(await exists(acme)).toBe(true);
    expect(storage.removed).toEqual([]);
  });

  it("needs the exact company name typed; junk or unknown ids are 'not found'", async () => {
    const storage = fakeStorage();
    for (const confirmName of ["", "acme villas", "Globex"]) {
      expect(await deleteCompany(db, admin, { companyId: acme, confirmName }, storage)).toEqual({ ok: false, error: M.confirm });
    }
    expect(await deleteCompany(db, admin, { companyId: "1", confirmName: "x" }, storage)).toEqual({ ok: false, error: M.notFound });
    expect(await deleteCompany(db, admin, { companyId: "00000000-0000-4000-8000-000000000000", confirmName: "x" }, storage)).toEqual({ ok: false, error: M.notFound });
    expect(await exists(acme)).toBe(true);
    expect(storage.removed).toEqual([]);
  });

  it("removes QC files and the logo file first, then the company and everything saved for it; others untouched", async () => {
    const storage = fakeStorage();
    storage.files.set(session, ["a.png", "b.pdf"]);
    const result = await deleteCompany(db, admin, { companyId: acme, confirmName: " Acme Villas " }, storage);
    expect(result).toEqual({ ok: true, name: "Acme Villas" });

    expect(storage.removed).toEqual([`${session}/a.png`, `${session}/b.pdf`, `${acme}/00000000-0000-4000-8000-000000000001.png`]);
    expect(await exists(acme)).toBe(false);
    for (const table of ["company_members", "company_logos", "brand_colors", "qc_sessions"]) expect(await count(table, acme)).toBe(0);
    // Users and the other company are kept.
    expect(await exists(globex)).toBe(true);
    expect((await db.query("select 1 from app_users")).length).toBe(2);
  });

  it("if Storage can't remove the files, the company is kept", async () => {
    const result = await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, fakeStorage(true));
    expect(result).toEqual({ ok: false, error: M.storage });
    expect(await exists(acme)).toBe(true);
    expect(await count("company_logos", acme)).toBe(1);
  });

  it("a logo but no Storage configured → kept", async () => {
    await db.query("delete from qc_sessions where company_id = $1", [acme]);
    expect(await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, { logos: null, qc: null })).toEqual({ ok: false, error: M.storage });
    expect(await exists(acme)).toBe(true);
  });

  it("refused while a design for the company is being analysed", async () => {
    await db.query(
      "insert into qc_analysis_runs (session_id, requested_by, kind, provider, status, files_fingerprint) values ($1, $2, 'content', 'mock', 'processing', 'f1')",
      [session, dee.id]
    );
    const storage = fakeStorage();
    expect(await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, storage)).toEqual({ ok: false, error: M.busy });
    expect(await exists(acme)).toBe(true);
    expect(storage.removed).toEqual([]);
  });

  describe("failures and races — the company is kept and no file is left without its record", () => {
    const LOGO = () => `${acme}/00000000-0000-4000-8000-000000000001.png`;
    const logoRow = async () => (await db.query<{ storage_path: string }>("select storage_path from company_logos where company_id = $1", [acme]))[0]?.storage_path ?? null;

    it("one of several QC sessions can't be cleaned up → stops there; the company and its logo are untouched", async () => {
      const [{ id: second }] = await db.query<{ id: string }>("insert into qc_sessions (company_id, user_id, content_type) values ($1, $2, 'design_poster') returning id", [acme, admin.id]);
      const storage = fakeStorage(false, { failListFor: second });
      expect(await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, storage)).toEqual({ ok: false, error: M.storage });
      expect(await exists(acme)).toBe(true);
      expect(await logoRow()).toBe(LOGO());
      expect(storage.removed).not.toContain(LOGO());
      // The session whose files couldn't be removed is still there, so a later clean-up can retry it.
      expect((await db.query("select 1 from qc_sessions where id = $1", [second])).length).toBe(1);
    });

    it("a QC session started during the deletion → company kept (its session and files are not cascaded away)", async () => {
      const storage = fakeStorage(false, {
        onLogoRemove: async () => {
          await db.query("insert into qc_sessions (company_id, user_id, content_type) values ($1, $2, 'social_post')", [acme, admin.id]);
        },
      });
      expect(await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, storage)).toEqual({ ok: false, error: M.changed });
      expect(await exists(acme)).toBe(true);
      expect(await count("qc_sessions", acme)).toBe(1);
      // Its old logo file was already removed, so its record goes too: "no logo", not a broken image.
      expect(await logoRow()).toBeNull();
    });

    it("the logo replaced during the deletion → company kept with its NEW logo", async () => {
      const NEW = `${acme}/00000000-0000-4000-8000-000000000002.png`;
      const storage = fakeStorage(false, {
        onLogoRemove: async () => {
          await upsertCompanyLogo(db, acme, { fileName: "new.png", storagePath: NEW, mimeType: "image/png", fileSize: 10 });
        },
      });
      expect(await deleteCompany(db, admin, { companyId: acme, confirmName: "Acme Villas" }, storage)).toEqual({ ok: false, error: M.changed });
      expect(await exists(acme)).toBe(true);
      expect(await logoRow()).toBe(NEW);
      expect(storage.removed).not.toContain(NEW);
    });

    it("a database error at the last step → the error reaches the action (shown as 'couldn't be deleted'); company kept", async () => {
      const failing: Database = {
        query: (text, params) => (/^\s*delete from companies/.test(text) ? Promise.reject(new Error("db down")) : db.query(text, params)),
        exec: (script) => db.exec(script),
        transaction: (fn) => fn(failing),
      } as Database;
      await expect(deleteCompany(failing, admin, { companyId: acme, confirmName: "Acme Villas" }, fakeStorage())).rejects.toThrow("db down");
      expect(await exists(acme)).toBe(true);
    });
  });
});
