import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { countUsers } from "@/lib/db/users";
import { createUser, type NewUserInput } from "@/lib/auth/create-user";
import { verifyPassword } from "@/lib/auth/password";

describe("createUser (npm run user:create)", () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDatabase()));
  afterAll(() => close());

  const input = (overrides: Partial<NewUserInput> = {}): NewUserInput => ({
    name: "Anna Lee",
    email: "Anna@Skybook.com",
    role: "designer",
    password: "a-very-long-passphrase",
    passwordConfirmation: "a-very-long-passphrase",
    ...overrides,
  });

  it("creates an active user with a lower-case email and a hashed password", async () => {
    const result = await createUser(db, input(), TEST_COST);
    expect(result).toMatchObject({
      ok: true,
      user: { name: "Anna Lee", email: "anna@skybook.com", role: "designer", active: true },
    });
    expect(result.ok && "passwordHash" in result.user).toBe(false);

    const [row] = await db.query<{ password_hash: string }>(
      "select password_hash from app_users where email = 'anna@skybook.com'"
    );
    expect(row.password_hash).not.toContain("a-very-long-passphrase");
    expect(await verifyPassword("a-very-long-passphrase", row.password_hash)).toBe(true);
  });

  it("creates an admin", async () => {
    const result = await createUser(
      db,
      input({ name: "Sam Admin", email: "sam@skybook.com", role: "admin" }),
      TEST_COST
    );
    expect(result).toMatchObject({ ok: true, user: { role: "admin" } });
  });

  it("refuses a second account with the same email, in any letter case", async () => {
    const before = await countUsers(db);
    const result = await createUser(db, input({ email: "ANNA@skybook.com" }), TEST_COST);
    expect(result).toEqual({
      ok: false,
      errors: { email: "A user with this email already exists." },
    });
    expect(await countUsers(db)).toBe(before);
  });

  it("reports every invalid field and saves nothing", async () => {
    const before = await countUsers(db);
    const result = await createUser(
      db,
      input({ name: " ", email: "nope", role: "owner", password: "short", passwordConfirmation: "short" }),
      TEST_COST
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "email",
      "name",
      "password",
      "role",
    ]);
    expect(await countUsers(db)).toBe(before);
  });

  it("refuses when the two passwords differ", async () => {
    const result = await createUser(
      db,
      input({ email: "new@skybook.com", passwordConfirmation: "something-else-entirely" }),
      TEST_COST
    );
    expect(result).toMatchObject({ ok: false, errors: { password: /match/ } });
  });

  it("is backed by database rules too (role and email format)", async () => {
    await expect(
      db.query(
        "insert into app_users (name, email, role, password_hash) values ('X', 'x@y.com', 'owner', 'h')"
      )
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into app_users (name, email, role, password_hash) values ('X', 'X@Y.com', 'admin', 'h')"
      )
    ).rejects.toThrow();
  });
});
