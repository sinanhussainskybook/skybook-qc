import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, insertTestUser } from "../../../test/db";
import { createFakeStorage } from "../../../test/fake-storage";
import { GIF, JPEG, PNG, svg } from "../../../test/logo-files";
import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";
import type { LogoStorage } from "@/lib/storage/logo-storage";

/**
 * The logo server actions, with a real (in-memory) PostgreSQL and a fake
 * Supabase Storage. Only sign-in and Next.js navigation are stand-ins.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as Database,
  user: null as User | null,
  storage: null as LogoStorage | null,
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
vi.mock("@/lib/storage/logo-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/logo-storage")>()),
  getLogoStorage: () => state.storage,
}));

const { uploadLogoAction, removeLogoAction } = await import("@/lib/company/logo-actions");
const { insertCompany } = await import("@/lib/db/companies");
const { getCompanyLogo } = await import("@/lib/db/company-logos");

function uploadForm(companyId: unknown, file?: File) {
  const data = new FormData();
  if (typeof companyId === "string") data.set("companyId", companyId);
  if (file) data.set("logo", file);
  return data;
}
const pngFile = (name = "Acme logo.png", bytes: Uint8Array = PNG, type = "image/png") =>
  new File([bytes as BlobPart], name, { type });

describe("logo actions", () => {
  let close: () => Promise<void>;
  let dee: User;
  let sam: User;
  let ada: User;
  let acme: string; // Dee's
  let globex: string; // Sam's
  let fake: ReturnType<typeof createFakeStorage>;

  beforeAll(async () => {
    const test = await createTestDatabase();
    state.db = test.db;
    close = test.close;
    dee = await insertTestUser(test.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    sam = await insertTestUser(test.db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    ada = await insertTestUser(test.db, { name: "Ada", email: "ada@skybook.com", role: "admin" });
    acme = (await insertCompany(test.db, { name: "Acme", createdBy: dee.id })).id;
    globex = (await insertCompany(test.db, { name: "Globex", createdBy: sam.id })).id;
  });
  afterAll(() => close());
  beforeEach(async () => {
    fake = createFakeStorage();
    state.storage = fake.storage;
    state.user = dee;
    await state.db.query("delete from company_logos");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("uploads a valid logo into the member's company", async () => {
    expect(await uploadLogoAction({}, uploadForm(acme, pngFile()))).toEqual({ ok: true, message: "Logo saved." });
    const logo = await getCompanyLogo(state.db, acme);
    expect(logo).toMatchObject({ file_name: "Acme logo.png", mime_type: "image/png" });
    expect(logo!.storage_path.startsWith(`${acme}/`)).toBe(true);
    expect(fake.files.size).toBe(1);
  });

  it("replaces and removes", async () => {
    await uploadLogoAction({}, uploadForm(acme, pngFile()));
    const first = (await getCompanyLogo(state.db, acme))!.storage_path;
    expect(await uploadLogoAction({}, uploadForm(acme, new File([JPEG as BlobPart], "new.jpg", { type: "image/jpeg" })))).toMatchObject({ ok: true });
    expect(fake.files.has(first)).toBe(false);
    expect(fake.files.size).toBe(1);

    expect(await removeLogoAction({}, uploadForm(acme))).toEqual({ ok: true, message: "Logo removed." });
    expect(await getCompanyLogo(state.db, acme)).toBeNull();
    expect(fake.files.size).toBe(0);
    expect(await removeLogoAction({}, uploadForm(acme))).toEqual({ error: "There's no logo to remove." });
  });

  it("rejects missing, invalid, mismatched and oversized files — Storage never called", async () => {
    const cases: [File | undefined, RegExp][] = [
      [undefined, /Choose a logo/],
      [new File([], "", { type: "application/octet-stream" }), /Choose a logo/],
      [new File([GIF as BlobPart], "logo.gif", { type: "image/gif" }), /PNG, JPG, WEBP or SVG/],
      [pngFile("logo.jpg", PNG, "image/jpeg"), /doesn't match/],
      [new File([svg("<script>alert(1)</script>") as BlobPart], "logo.svg", { type: "image/svg+xml" }), /scripts/],
      [new File([new Uint8Array(2 * 1024 * 1024 + 1) as BlobPart], "big.png", { type: "image/png" }), /too large/],
    ];
    for (const [file, message] of cases) {
      expect(await uploadLogoAction({}, uploadForm(acme, file)), file?.name).toEqual({ error: expect.stringMatching(message) });
    }
    expect(fake.calls).toEqual([]);
    expect(await getCompanyLogo(state.db, acme)).toBeNull();
  });

  describe("authorisation", () => {
    it("signed out: every logo action sends to sign-in and does nothing", async () => {
      state.user = null;
      await expect(uploadLogoAction({}, uploadForm(acme, pngFile()))).rejects.toThrow("NEXT_REDIRECT /login");
      await expect(removeLogoAction({}, uploadForm(acme))).rejects.toThrow("NEXT_REDIRECT /login");
      expect(fake.calls).toEqual([]);
    });

    it("a non-member can't upload, replace or remove another company's logo", async () => {
      state.user = sam;
      await uploadLogoAction({}, uploadForm(globex, pngFile("globex.png"))); // Sam's own company
      const samsLogo = await getCompanyLogo(state.db, globex);
      fake.calls.length = 0;

      state.user = dee;
      const refused = { error: "This company isn't available. Reload the page and try again." };
      expect(await uploadLogoAction({}, uploadForm(globex, pngFile("hijack.png")))).toEqual(refused);
      expect(await removeLogoAction({}, uploadForm(globex))).toEqual(refused);
      expect(fake.calls).toEqual([]); // Storage never touched
      expect(await getCompanyLogo(state.db, globex)).toEqual(samsLogo);
    });

    it("forged or missing company IDs are rejected", async () => {
      const refused = { error: "This company isn't available. Reload the page and try again." };
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", `${acme}/../${globex}`, undefined]) {
        expect(await uploadLogoAction({}, uploadForm(id, pngFile())), String(id)).toEqual(refused);
        expect(await removeLogoAction({}, uploadForm(id)), String(id)).toEqual(refused);
      }
      expect(fake.calls).toEqual([]);
    });

    it("an admin may manage any company's logo (existing access rules)", async () => {
      state.user = ada;
      expect(await uploadLogoAction({}, uploadForm(globex, pngFile()))).toMatchObject({ ok: true });
      expect((await getCompanyLogo(state.db, globex))!.storage_path.startsWith(`${globex}/`)).toBe(true);
    });
  });

  describe("friendly errors", () => {
    it("Storage not set up on this server", async () => {
      state.storage = null;
      expect(await uploadLogoAction({}, uploadForm(acme, pngFile()))).toEqual({
        error: "Logo storage isn't set up on this server yet. Ask your administrator.",
      });
      expect(await removeLogoAction({}, uploadForm(acme))).toMatchObject({ error: /isn't set up/ });
    });

    it("Storage failure shows a plain message, not the raw error", async () => {
      fake.failing.upload = true;
      const result = await uploadLogoAction({}, uploadForm(acme, pngFile()));
      expect(result).toEqual({ error: "The logo couldn't be saved to storage. Please try again in a moment." });
      expect(JSON.stringify(result)).not.toMatch(/fake|HTTP|supabase/i);
    });
  });
});
