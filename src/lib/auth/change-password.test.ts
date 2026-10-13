import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { findUserForSignIn, type User } from "@/lib/db/users";
import { createUser } from "@/lib/auth/create-user";
import { verifyPassword } from "@/lib/auth/password";
import { getSessionUser, signIn } from "@/lib/auth/sign-in";
import { hashSessionToken } from "@/lib/auth/session-token";
import { changeOwnPassword } from "@/lib/auth/change-password";

describe("changeOwnPassword", () => {
  let db: Database;
  let close: () => Promise<void>;
  let eve: User;
  const TEMP = "a-temporary-passphrase";
  const OWN = "eves-own-passphrase";

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const result = await createUser(db, { name: "Eve", email: "eve@skybook.com", role: "designer", password: TEMP, passwordConfirmation: TEMP, mustChangePassword: true }, TEST_COST);
    if (!result.ok) throw new Error("setup");
    eve = result.user;
  });
  afterAll(() => close());

  const token = async (password: string) => {
    const result = await signIn(db, { email: eve.email, password });
    if (!result.ok) throw new Error("sign-in");
    return result.token;
  };

  it("checks the new password with the usual rules", async () => {
    const tryWith = (password: string, confirmation = password) =>
      changeOwnPassword(db, eve, { currentPassword: TEMP, password, passwordConfirmation: confirmation }, { cost: TEST_COST });
    expect(await tryWith("short")).toMatchObject({ ok: false, errors: { password: expect.any(String) } });
    expect(await tryWith(OWN, "different-passphrase")).toMatchObject({ ok: false, errors: { password: /match/ } });
    expect(await tryWith(eve.email)).toMatchObject({ ok: false, errors: { password: /email/ } });
  });

  it("saves it, clears the temporary flag, keeps this session and signs out the others", async () => {
    const here = await token(TEMP);
    const elsewhere = await token(TEMP);
    expect(await getSessionUser(db, here)).toMatchObject({ mustChangePassword: true });

    expect(await changeOwnPassword(db, eve, { currentPassword: TEMP, password: OWN, passwordConfirmation: OWN }, { keepTokenHash: hashSessionToken(here), cost: TEST_COST })).toEqual({ ok: true });
    expect(await getSessionUser(db, here)).toMatchObject({ id: eve.id, mustChangePassword: false });
    expect(await getSessionUser(db, elsewhere)).toBeNull();
    const account = (await findUserForSignIn(db, eve.email))!;
    expect(await verifyPassword(OWN, account.passwordHash)).toBe(true);
    expect(await verifyPassword(TEMP, account.passwordHash)).toBe(false);
  });

  it("limits wrong current-password guesses like sign-in", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      expect(await changeOwnPassword(db, eve, { currentPassword: "a-wrong-guess-123", password: "x-new-passphrase", passwordConfirmation: "x-new-passphrase" }, { cost: TEST_COST, now })).toMatchObject({ ok: false, errors: { currentPassword: expect.any(String) } });
    }
    expect(await changeOwnPassword(db, eve, { currentPassword: OWN, password: "x-new-passphrase", passwordConfirmation: "x-new-passphrase" }, { cost: TEST_COST, now })).toMatchObject({ ok: false, errors: { form: /Too many/ } });
  });
});
