import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { countUsers, findUserForSignIn } from "@/lib/db/users";
import { addCompanyMember, insertCompany } from "@/lib/db/companies";
import { createUser } from "@/lib/auth/create-user";
import { verifyPassword } from "@/lib/auth/password";
import { NO_SUCH_USER, resetPassword } from "@/lib/auth/reset-password";
import { insertSession } from "@/lib/db/sessions";
import { recordAttempt } from "@/lib/db/login-throttle";

describe("resetPassword (npm run user:reset-password)", () => {
  let db: Database;
  let close: () => Promise<void>;
  const OLD = "the-original-passphrase";
  const NEW = "a-brand-new-passphrase";
  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const anna = await createUser(db, { name: "Anna Lee", email: "anna@skybook.com", role: "admin", password: OLD, passwordConfirmation: OLD }, TEST_COST);
    await createUser(db, { name: "Ben Ito", email: "ben@skybook.com", role: "designer", password: OLD, passwordConfirmation: OLD }, TEST_COST);
    if (!anna.ok) throw new Error("setup");
    const acme = await insertCompany(db, { name: "Acme", createdBy: anna.user.id });
    await addCompanyMember(db, acme.id, (await findUserForSignIn(db, "ben@skybook.com"))!.id);
  });
  afterAll(() => close());

  const snapshot = () =>
    db.query<Record<string, unknown>>("select id, name, email, role, active, created_at, updated_at, password_hash from app_users order by email");
  const memberships = () => db.query("select company_id, user_id from company_members order by 1, 2");

  it("sets the new password with the same scrypt hashing; ONLY that user's password hash changes", async () => {
    const before = await snapshot();
    const membersBefore = await memberships();
    const result = await resetPassword(db, { email: "  Anna@Skybook.com ", password: NEW, passwordConfirmation: NEW }, TEST_COST);
    expect(result).toMatchObject({ ok: true, user: { email: "anna@skybook.com", name: "Anna Lee", role: "admin", active: true } });

    const anna = (await findUserForSignIn(db, "anna@skybook.com"))!;
    expect(anna.passwordHash).toMatch(/^scrypt\$/); // the same stored format as user:create
    expect(await verifyPassword(NEW, anna.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD, anna.passwordHash)).toBe(false);

    // Every other column of Anna's row, and Ben's whole row, are exactly as before; no user added; memberships untouched.
    const after = await snapshot();
    const without = (rows: Record<string, unknown>[]) => rows.map(({ password_hash, ...rest }) => (rest.email === "anna@skybook.com" ? rest : { ...rest, password_hash }));
    expect(without(after)).toEqual(without(before));
    expect(after.find((r) => r.email === "anna@skybook.com")!.password_hash).not.toBe(before.find((r) => r.email === "anna@skybook.com")!.password_hash);
    expect(await countUsers(db)).toBe(2);
    expect(await memberships()).toEqual(membersBefore);
  });

  it("never creates a user: an unknown email changes nothing", async () => {
    const before = await snapshot();
    expect(await resetPassword(db, { email: "nobody@skybook.com", password: NEW, passwordConfirmation: NEW }, TEST_COST)).toEqual({ ok: false, errors: { email: NO_SUCH_USER } });
    expect(await snapshot()).toEqual(before);
    expect(await countUsers(db)).toBe(2);
  });

  it("the same password rules as user:create — too short, mismatched or the email itself → nothing changes", async () => {
    const before = await snapshot();
    const tryWith = (password: string, passwordConfirmation = password, email = "ben@skybook.com") => resetPassword(db, { email, password, passwordConfirmation }, TEST_COST);
    expect(await tryWith("short-11-ch")).toEqual({ ok: false, errors: { password: "Use at least 12 characters." } });
    expect(await tryWith(NEW, "something-different")).toEqual({ ok: false, errors: { password: "The two passwords don't match." } });
    expect(await tryWith("ben@skybook.com")).toEqual({ ok: false, errors: { password: "The password can't be the email address." } });
    expect(await tryWith(NEW, NEW, "not-an-email")).toMatchObject({ ok: false, errors: { email: expect.any(String) } });
    expect(await snapshot()).toEqual(before);
  });

  it("signs the user out everywhere and clears their failed sign-in attempts — other users keep theirs", async () => {
    const anna = (await findUserForSignIn(db, "anna@skybook.com"))!;
    const ben = (await findUserForSignIn(db, "ben@skybook.com"))!;
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await insertSession(db, { tokenHash: "a".repeat(64), userId: anna.id, expiresAt: later });
    await insertSession(db, { tokenHash: "b".repeat(64), userId: anna.id, expiresAt: later });
    await insertSession(db, { tokenHash: "c".repeat(64), userId: ben.id, expiresAt: later });
    for (const key of ["email:anna@skybook.com", "email:ben@skybook.com"]) {
      for (let i = 0; i < 3; i++) await recordAttempt(db, key, new Date(), 900);
    }
    const sessionsOf = async (userId: string) => (await db.query("select id from app_sessions where user_id = $1", [userId])).length;
    const attemptsFor = async (key: string) => (await db.query("select key from login_throttle where key = $1", [key])).length;

    expect(await resetPassword(db, { email: "anna@skybook.com", password: NEW, passwordConfirmation: NEW }, TEST_COST)).toMatchObject({ ok: true });
    expect(await sessionsOf(anna.id)).toBe(0);
    expect(await attemptsFor("email:anna@skybook.com")).toBe(0);
    // Ben is untouched.
    expect(await sessionsOf(ben.id)).toBe(1);
    expect(await attemptsFor("email:ben@skybook.com")).toBe(1);
  });

  it("a refused reset (bad password, unknown email) signs nobody out and clears nothing", async () => {
    const ben = (await findUserForSignIn(db, "ben@skybook.com"))!;
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await db.query("delete from app_sessions");
    await insertSession(db, { tokenHash: "d".repeat(64), userId: ben.id, expiresAt: later });
    await recordAttempt(db, "email:ben@skybook.com", new Date(), 900);
    expect(await resetPassword(db, { email: "ben@skybook.com", password: "short", passwordConfirmation: "short" }, TEST_COST)).toMatchObject({ ok: false });
    expect(await resetPassword(db, { email: "nobody@skybook.com", password: NEW, passwordConfirmation: NEW }, TEST_COST)).toMatchObject({ ok: false });
    expect((await db.query("select id from app_sessions where user_id = $1", [ben.id])).length).toBe(1);
    expect((await db.query("select key from login_throttle where key = 'email:ben@skybook.com'")).length).toBe(1);
  });
});
