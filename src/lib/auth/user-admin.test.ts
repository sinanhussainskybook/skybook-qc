import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { deleteUserRow, findUserForSignIn, listUsers, setUserActive, type User } from "@/lib/db/users";
import { addCompanyMember, insertCompany } from "@/lib/db/companies";
import { recordAttempt } from "@/lib/db/login-throttle";
import { verifyPassword } from "@/lib/auth/password";
import { getSessionUser, signIn } from "@/lib/auth/sign-in";
import { createUser } from "@/lib/auth/create-user";
import { adminCreateUser, adminDeleteUser, adminResetPassword, adminSetUserActive, MESSAGES } from "@/lib/auth/user-admin";

/** User Management rules against a real (in-memory) PostgreSQL with QC's migrations. */

const PW = "the-original-passphrase";
const TEMP = "a-temporary-passphrase";

describe("User Management (user-admin.ts)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let ada: User; // admin doing the work
  let bo: User; // second admin
  let dee: User; // designer

  beforeAll(async () => ({ db, close } = await createTestDatabase()));
  afterAll(() => close());
  // One database for the file; every test starts from the same three users.
  beforeEach(async () => {
    await db.query("truncate app_users, companies, login_throttle cascade");
    const make = async (name: string, email: string, role: "admin" | "designer") => {
      const result = await createUser(db, { name, email, role, password: PW, passwordConfirmation: PW }, TEST_COST);
      if (!result.ok) throw new Error("setup");
      return result.user;
    };
    ada = await make("Ada Admin", "ada@skybook.com", "admin");
    bo = await make("Bo Admin", "bo@skybook.com", "admin");
    dee = await make("Dee Designer", "dee@skybook.com", "designer");
  });

  const row = async (id: string) =>
    (await db.query<{ active: boolean; must_change_password: boolean; password_hash: string }>(
      "select active, must_change_password, password_hash from app_users where id = $1",
      [id]
    ))[0];
  const sessionsOf = async (id: string) =>
    Number((await db.query<{ n: number }>("select count(*)::int as n from app_sessions where user_id = $1", [id]))[0].n);
  const signInAs = async (email: string, password = PW) => {
    const result = await signIn(db, { email, password });
    if (!result.ok) throw new Error(`sign-in failed for ${email}`);
    return result.token;
  };
  const userCount = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from app_users"))[0].n);

  describe("permissions — enforced in every function, whatever the page showed", () => {
    it("refuses a designer, a signed-out caller and a switched-off admin; nothing changes", async () => {
      const before = await db.query("select * from app_users order by email");
      for (const actor of [dee, null, { ...bo, active: false }]) {
        expect(await adminSetUserActive(db, actor, dee.id, false)).toEqual({ ok: false, error: MESSAGES.notAllowed });
        expect(await adminResetPassword(db, actor, { userId: dee.id, password: TEMP, passwordConfirmation: TEMP }, TEST_COST)).toEqual({ ok: false, error: MESSAGES.notAllowed });
        expect(await adminDeleteUser(db, actor, { userId: dee.id, confirmEmail: dee.email })).toEqual({ ok: false, error: MESSAGES.notAllowed });
        expect(
          await adminCreateUser(db, actor, { name: "Eve", email: "eve@skybook.com", role: "admin", password: TEMP, passwordConfirmation: TEMP }, TEST_COST)
        ).toEqual({ ok: false, errors: { form: MESSAGES.notAllowed } });
      }
      expect(await db.query("select * from app_users order by email")).toEqual(before);
    });

    it("the user list never carries a password hash", async () => {
      const users = await listUsers(db);
      expect(users.map((u) => u.email)).toEqual(["ada@skybook.com", "bo@skybook.com", "dee@skybook.com"]);
      expect(JSON.stringify(users)).not.toMatch(/scrypt|password_?hash/i);
    });
  });

  describe("create", () => {
    it("adds an active user with a hashed TEMPORARY password they must change", async () => {
      const result = await adminCreateUser(db, ada, { name: "Eve New", email: " Eve@Skybook.com", role: "designer", password: TEMP, passwordConfirmation: TEMP }, TEST_COST);
      expect(result).toMatchObject({ ok: true, user: { name: "Eve New", email: "eve@skybook.com", role: "designer", active: true } });
      const eve = (await findUserForSignIn(db, "eve@skybook.com"))!;
      expect(eve.passwordHash).not.toContain(TEMP);
      expect(await verifyPassword(TEMP, eve.passwordHash)).toBe(true);
      expect((await row(eve.id)).must_change_password).toBe(true);
      // They can sign in, and the session says they must choose a password first.
      expect(await getSessionUser(db, await signInAs("eve@skybook.com", TEMP))).toMatchObject({ mustChangePassword: true });
    });

    it("uses the usual checks: duplicate email, bad role, short or mismatched password", async () => {
      const add = (over: Record<string, string>) =>
        adminCreateUser(db, ada, { name: "Eve", email: "eve@skybook.com", role: "designer", password: TEMP, passwordConfirmation: TEMP, ...over }, TEST_COST);
      expect(await add({ email: "DEE@skybook.com" })).toEqual({ ok: false, errors: { email: "A user with this email already exists." } });
      expect(await add({ role: "owner" })).toMatchObject({ ok: false, errors: { role: expect.any(String) } });
      expect(await add({ password: "short", passwordConfirmation: "short" })).toMatchObject({ ok: false, errors: { password: expect.any(String) } });
      expect(await add({ passwordConfirmation: "something-else-entirely" })).toMatchObject({ ok: false, errors: { password: /match/ } });
      expect(await userCount()).toBe(3);
    });
  });

  describe("switch on / off", () => {
    it("switching off signs the user out everywhere and stops sign-in; switching on lets them back", async () => {
      const token = await signInAs(dee.email);
      await signInAs(dee.email);
      expect(await sessionsOf(dee.id)).toBe(2);

      expect(await adminSetUserActive(db, ada, dee.id, false)).toMatchObject({ ok: true });
      expect((await row(dee.id)).active).toBe(false);
      expect(await sessionsOf(dee.id)).toBe(0);
      expect(await getSessionUser(db, token)).toBeNull();
      expect(await signIn(db, { email: dee.email, password: PW })).toEqual({ ok: false, reason: "invalid" });

      expect(await adminSetUserActive(db, ada, dee.id, true)).toMatchObject({ ok: true });
      expect((await row(dee.id)).active).toBe(true);
      expect(await signIn(db, { email: dee.email, password: PW })).toMatchObject({ ok: true });
    });

    it("an admin can't switch themselves off", async () => {
      expect(await adminSetUserActive(db, ada, ada.id, false)).toEqual({ ok: false, error: MESSAGES.notYourself });
      expect((await row(ada.id)).active).toBe(true);
    });

    it("another admin can be switched off while one active admin remains", async () => {
      expect(await adminSetUserActive(db, ada, bo.id, false)).toMatchObject({ ok: true });
      expect((await row(bo.id)).active).toBe(false);
    });

    it("unknown or junk ids change nothing", async () => {
      for (const id of ["00000000-0000-4000-8000-000000000000", "1", "'; drop table app_users; --"]) {
        expect(await adminSetUserActive(db, ada, id, false)).toEqual({ ok: false, error: MESSAGES.noSuchUser });
      }
      expect(await userCount()).toBe(3);
    });
  });

  describe("last active admin — guarded in the same SQL statement as the change", () => {
    it("the database refuses to switch off or delete the last active admin", async () => {
      await setUserActive(db, bo.id, false);
      expect(await setUserActive(db, ada.id, false)).toBe(false);
      expect(await deleteUserRow(db, ada.id)).toBe(false);
      expect((await row(ada.id)).active).toBe(true);
      // An inactive admin, or a designer, is not protected.
      expect(await deleteUserRow(db, bo.id)).toBe(true);
    });

    it("even with a stale admin (switched off since the page loaded), the last active admin stays", async () => {
      await setUserActive(db, ada.id, false); // Ada is switched off elsewhere; her request still arrives
      expect(await adminSetUserActive(db, ada, bo.id, false)).toEqual({ ok: false, error: MESSAGES.lastAdmin });
      expect(await adminDeleteUser(db, ada, { userId: bo.id, confirmEmail: bo.email })).toEqual({ ok: false, error: MESSAGES.lastAdmin });
      expect((await row(bo.id)).active).toBe(true);
    });
  });

  describe("reset password", () => {
    it("sets a temporary password, signs the user out everywhere and clears their sign-in lockout", async () => {
      const token = await signInAs(dee.email);
      for (let i = 0; i < 6; i++) await recordAttempt(db, `email:${dee.email}`, new Date(), 900);
      const oldHash = (await row(dee.id)).password_hash;

      expect(await adminResetPassword(db, ada, { userId: dee.id, password: TEMP, passwordConfirmation: TEMP }, TEST_COST)).toMatchObject({ ok: true });
      const after = await row(dee.id);
      expect(after.password_hash).not.toBe(oldHash);
      expect(after.password_hash).not.toContain(TEMP);
      expect(after.must_change_password).toBe(true);
      expect(after.active).toBe(true);
      expect(await getSessionUser(db, token)).toBeNull();
      expect(await sessionsOf(dee.id)).toBe(0);

      expect(await signIn(db, { email: dee.email, password: PW })).toEqual({ ok: false, reason: "invalid" });
      const session = await getSessionUser(db, await signInAs(dee.email, TEMP));
      expect(session).toMatchObject({ id: dee.id, mustChangePassword: true });
    });

    it("refuses the admin's own account, weak passwords and unknown users", async () => {
      expect(await adminResetPassword(db, ada, { userId: ada.id, password: TEMP, passwordConfirmation: TEMP }, TEST_COST)).toEqual({ ok: false, error: MESSAGES.ownPassword });
      expect(await adminResetPassword(db, ada, { userId: dee.id, password: "short", passwordConfirmation: "short" }, TEST_COST)).toMatchObject({ ok: false });
      expect(await adminResetPassword(db, ada, { userId: dee.id, password: dee.email, passwordConfirmation: dee.email }, TEST_COST)).toMatchObject({ ok: false });
      expect(await adminResetPassword(db, ada, { userId: "00000000-0000-4000-8000-000000000000", password: TEMP, passwordConfirmation: TEMP }, TEST_COST)).toEqual({ ok: false, error: MESSAGES.noSuchUser });
      expect((await row(dee.id)).must_change_password).toBe(false);
    });
  });

  describe("delete", () => {
    it("needs the email typed to confirm", async () => {
      for (const confirmEmail of ["", "yes", "bo@skybook.com"]) {
        expect(await adminDeleteUser(db, ada, { userId: dee.id, confirmEmail })).toEqual({ ok: false, error: MESSAGES.confirmDelete });
      }
      expect(await userCount()).toBe(3);
    });

    it("deletes the account, its sessions and memberships; companies they added are kept", async () => {
      await signInAs(dee.email);
      const acme = await insertCompany(db, { name: "Acme", createdBy: dee.id });
      await addCompanyMember(db, acme.id, dee.id);

      expect(await adminDeleteUser(db, ada, { userId: dee.id, confirmEmail: " DEE@skybook.com " })).toMatchObject({ ok: true });
      expect(await userCount()).toBe(2);
      expect(await sessionsOf(dee.id)).toBe(0);
      expect(await db.query("select * from company_members where user_id = $1", [dee.id])).toEqual([]);
      expect(await db.query("select name, created_by from companies where id = $1", [acme.id])).toEqual([{ name: "Acme", created_by: null }]);
    });

    it("refuses one's own account, and a user with a QC check in progress", async () => {
      expect(await adminDeleteUser(db, ada, { userId: ada.id, confirmEmail: ada.email })).toEqual({ ok: false, error: MESSAGES.notYourself });

      const acme = await insertCompany(db, { name: "Acme", createdBy: ada.id });
      await db.query("insert into qc_sessions (company_id, user_id, content_type) values ($1, $2, 'design_poster')", [acme.id, dee.id]);
      expect(await adminDeleteUser(db, ada, { userId: dee.id, confirmEmail: dee.email })).toEqual({ ok: false, error: MESSAGES.qcInProgress });
      expect(await db.query("select 1 from qc_sessions where user_id = $1", [dee.id])).toHaveLength(1);
      expect(await userCount()).toBe(3);
    });

    it("another admin can be deleted while an active admin remains", async () => {
      expect(await adminDeleteUser(db, ada, { userId: bo.id, confirmEmail: bo.email })).toMatchObject({ ok: true });
      expect(await userCount()).toBe(2);
    });
  });

  it("a plain test user inserted directly has no temporary password", async () => {
    const zed = await insertTestUser(db, { name: "Zed", email: "zed@skybook.com", role: "designer" });
    expect((await row(zed.id)).must_change_password).toBe(false);
  });
});
