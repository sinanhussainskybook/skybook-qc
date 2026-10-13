import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";

/**
 * The User Management and Change password server actions, through the REAL
 * server-side checks: the session cookie → getSessionUser → requireUser /
 * requireRole("admin"), against an in-memory PostgreSQL. Only the cookie jar,
 * Next.js navigation and the cache refresh are stand-ins.
 */

const state = vi.hoisted(() => ({ db: null as unknown as Database, token: undefined as string | undefined }));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => state.db, isDatabaseConfigured: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { value: state.token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The real hashing cost would make every test slow; the hash format is the same.
vi.mock("@/lib/auth/password", async (original) => {
  const real = await original<typeof import("@/lib/auth/password")>();
  return { ...real, DEFAULT_COST: { logN: 10, r: 8, p: 1 } };
});

const actions = await import("@/lib/auth/user-admin-actions");
const { changePasswordAction } = await import("@/lib/auth/actions");
const { createUser } = await import("@/lib/auth/create-user");
const { signIn } = await import("@/lib/auth/sign-in");
const { requireRole, requireUser } = await import("@/lib/auth/current-user");

const PW = "the-original-passphrase";
const TEMP = "a-temporary-passphrase";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("User Management server actions — permissions on the server", () => {
  let close: () => Promise<void>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ db: state.db, close } = await createTestDatabase());
    for (const [name, email, role] of [
      ["Ada Admin", "ada@skybook.com", "admin"],
      ["Dee Designer", "dee@skybook.com", "designer"],
      ["Sam Designer", "sam@skybook.com", "designer"],
    ] as const) {
      const result = await createUser(state.db, { name, email, role, password: PW, passwordConfirmation: PW }, TEST_COST);
      if (!result.ok) throw new Error("setup");
      ids[email] = result.user.id;
    }
  });
  afterAll(() => close());
  beforeEach(() => {
    state.token = undefined;
  });

  const signInAs = async (email: string, password = PW) => {
    const result = await signIn(state.db, { email, password });
    if (!result.ok) throw new Error(`sign-in failed for ${email}`);
    state.token = result.token;
  };
  const snapshot = () => state.db.query("select id, name, email, role, active, must_change_password, password_hash from app_users order by email");

  it("a designer gets 'not found' from the page check and from every action; nothing changes", async () => {
    await signInAs("dee@skybook.com");
    await expect(requireRole("admin")).rejects.toThrow("NEXT_NOT_FOUND");
    const before = await snapshot();
    const target = ids["sam@skybook.com"];
    await expect(actions.createUserAction({}, form({ name: "Eve", email: "eve@skybook.com", role: "admin", password: TEMP, passwordConfirmation: TEMP }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.setUserActiveAction({}, form({ userId: target, active: "false" }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.resetPasswordAction({}, form({ userId: target, password: TEMP, passwordConfirmation: TEMP }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(actions.deleteUserAction({}, form({ userId: target, confirmEmail: "sam@skybook.com" }))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await snapshot()).toEqual(before);
  });

  it("a signed-out visitor is sent to sign in; a made-up cookie is no better", async () => {
    await expect(actions.setUserActiveAction({}, form({ userId: ids["sam@skybook.com"], active: "false" }))).rejects.toThrow("NEXT_REDIRECT /login");
    state.token = "A".repeat(43);
    await expect(actions.deleteUserAction({}, form({ userId: ids["sam@skybook.com"], confirmEmail: "sam@skybook.com" }))).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("an admin can add a user, who must then change the temporary password before anything else", async () => {
    await signInAs("ada@skybook.com");
    const created = await actions.createUserAction({}, form({ name: "Eve New", email: "eve@skybook.com", role: "designer", password: TEMP, passwordConfirmation: TEMP }));
    expect(created).toMatchObject({ ok: true, message: expect.stringContaining("Eve New") });

    await signInAs("eve@skybook.com", TEMP);
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT /account/password");

    // Wrong current password, then the same password again — refused.
    expect(await changePasswordAction({}, form({ currentPassword: "not-the-password", password: "eves-own-passphrase", passwordConfirmation: "eves-own-passphrase" }))).toEqual({
      errors: { currentPassword: "Your current password is incorrect." },
    });
    expect(await changePasswordAction({}, form({ currentPassword: TEMP, password: TEMP, passwordConfirmation: TEMP }))).toEqual({
      errors: { password: "Choose a password different from the current one." },
    });
    await expect(changePasswordAction({}, form({ currentPassword: TEMP, password: "eves-own-passphrase", passwordConfirmation: "eves-own-passphrase" }))).rejects.toThrow("NEXT_REDIRECT /");
    // This browser stays signed in and can now use the app.
    await expect(requireUser()).resolves.toMatchObject({ email: "eve@skybook.com", mustChangePassword: false });
  });

  it("an admin's reset signs the user out; switch off / delete report refusals as messages", async () => {
    await signInAs("sam@skybook.com");
    const samToken = state.token;
    await signInAs("ada@skybook.com");
    const sam = ids["sam@skybook.com"];

    expect(await actions.resetPasswordAction({}, form({ userId: sam, password: TEMP, passwordConfirmation: TEMP }))).toMatchObject({ ok: true });
    state.token = samToken;
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT /login");

    await signInAs("ada@skybook.com");
    expect(await actions.setUserActiveAction({}, form({ userId: ids["ada@skybook.com"], active: "false" }))).toEqual({ error: "You can't do this to your own account." });
    expect(await actions.deleteUserAction({}, form({ userId: sam, confirmEmail: "wrong" }))).toEqual({ error: "Type the user's email address exactly to confirm." });
    expect(await actions.setUserActiveAction({}, form({ userId: sam, active: "false" }))).toMatchObject({ ok: true });
    expect(await actions.deleteUserAction({}, form({ userId: sam, confirmEmail: "sam@skybook.com" }))).toMatchObject({ ok: true });
    expect(await state.db.query("select 1 from app_users where id = $1", [sam])).toEqual([]);
  });
});
