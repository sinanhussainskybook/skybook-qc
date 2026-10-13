import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";

/**
 * deleteCompanyAction through the REAL server-side checks: the session cookie →
 * getSessionUser → requireRole("admin"), against an in-memory PostgreSQL. Only the
 * cookie jar, Next.js navigation, the cache refresh and Storage are stand-ins.
 */

const state = vi.hoisted(() => ({ db: null as unknown as Database, token: undefined as string | undefined }));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => state.db, isDatabaseConfigured: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (state.token ? { value: state.token } : undefined), set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// No Storage needed: the company below has no logo and no QC sessions.
vi.mock("@/lib/storage/logo-storage", () => ({ getLogoStorage: () => null }));
vi.mock("@/lib/storage/qc-storage", () => ({ getQcStorage: () => null }));

const { deleteCompanyAction } = await import("@/lib/company/delete-actions");
const { createUser } = await import("@/lib/auth/create-user");
const { signIn } = await import("@/lib/auth/sign-in");
const { insertCompany } = await import("@/lib/db/companies");

const PW = "the-original-passphrase";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("deleteCompanyAction — administrators only, checked on the server", () => {
  let close: () => Promise<void>;
  let acme: string;

  beforeAll(async () => {
    ({ db: state.db, close } = await createTestDatabase());
    for (const [name, email, role] of [
      ["Ada Admin", "ada@skybook.com", "admin"],
      ["Dee Designer", "dee@skybook.com", "designer"],
    ] as const) {
      const result = await createUser(state.db, { name, email, role, password: PW, passwordConfirmation: PW }, TEST_COST);
      if (!result.ok) throw new Error("setup");
      if (role === "designer") acme = (await insertCompany(state.db, { name: "Acme Villas", createdBy: result.user.id })).id;
    }
  });
  afterAll(() => close());
  beforeEach(() => {
    state.token = undefined;
  });

  const signInAs = async (email: string) => {
    const result = await signIn(state.db, { email, password: PW });
    if (!result.ok) throw new Error("sign-in");
    state.token = result.token;
  };
  const exists = async () => (await state.db.query("select 1 from companies where id = $1", [acme])).length === 1;

  it("a designer — even a member of the company — gets 'not found'; the company is kept", async () => {
    await signInAs("dee@skybook.com");
    await expect(deleteCompanyAction({}, form({ companyId: acme, confirmName: "Acme Villas" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await exists()).toBe(true);
  });

  it("signed out → sign-in page; the company is kept", async () => {
    await expect(deleteCompanyAction({}, form({ companyId: acme, confirmName: "Acme Villas" }))).rejects.toThrow("NEXT_REDIRECT /login");
    expect(await exists()).toBe(true);
  });

  it("an admin with the wrong name gets a message; with the right name the company goes and they're sent Home", async () => {
    await signInAs("ada@skybook.com");
    expect(await deleteCompanyAction({}, form({ companyId: acme, confirmName: "Acme" }))).toEqual({ error: "Type the company name exactly to confirm." });
    expect(await exists()).toBe(true);
    await expect(deleteCompanyAction({}, form({ companyId: acme, confirmName: "Acme Villas" }))).rejects.toThrow("NEXT_REDIRECT /");
    expect(await exists()).toBe(false);
  });
});
