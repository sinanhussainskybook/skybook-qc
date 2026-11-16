import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_COST } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { createUser } from "@/lib/auth/create-user";
import { getSessionUser, SIGN_IN_IP_LIMIT, SIGN_IN_LIMIT, signIn, signOut } from "@/lib/auth/sign-in";
import { hashSessionToken, SESSION_DURATION_MS } from "@/lib/auth/session-token";

const PASSWORD = "a-very-long-passphrase";
const T0 = new Date("2026-09-29T09:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe("sign-in, sessions and sign-out", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDatabase());
    const people = [
      { name: "Dee Designer", email: "dee@skybook.com", role: "designer" },
      { name: "Ada Admin", email: "ada@skybook.com", role: "admin" },
      { name: "Old Account", email: "old@skybook.com", role: "designer" },
    ];
    for (const person of people) {
      const result = await createUser(
        db,
        { ...person, password: PASSWORD, passwordConfirmation: PASSWORD },
        TEST_COST
      );
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
    }
    await db.query("update app_users set active = false where email = 'old@skybook.com'");
  });
  afterAll(() => close());

  it("signs in with the right details and returns the user without the hash", async () => {
    const result = await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, T0);
    expect(result).toMatchObject({
      ok: true,
      user: { name: "Dee Designer", email: "dee@skybook.com", role: "designer", active: true },
    });
    if (!result.ok) return;
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(result.expiresAt.getTime() - T0.getTime()).toBe(SESSION_DURATION_MS);
  });

  it("stores only the hash of the session token", async () => {
    const result = await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, T0);
    if (!result.ok) throw new Error("expected sign-in");
    const rows = await db.query<{ id: string }>("select id from app_sessions");
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(hashSessionToken(result.token));
    expect(ids).not.toContain(result.token);
  });

  it("ignores letter case and spaces in the email", async () => {
    const result = await signIn(db, { email: "  DEE@Skybook.com ", password: PASSWORD }, T0);
    expect(result.ok).toBe(true);
  });

  it("gives the same answer for a wrong password, an unknown email and a switched-off account", async () => {
    const wrongPassword = await signIn(db, { email: "dee@skybook.com", password: "wrong-password-123" }, T0);
    const unknownEmail = await signIn(db, { email: "nobody@skybook.com", password: PASSWORD }, T0);
    const inactive = await signIn(db, { email: "old@skybook.com", password: PASSWORD }, T0);
    for (const result of [wrongPassword, unknownEmail, inactive]) {
      expect(result).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects empty or oversized input without a session", async () => {
    expect(await signIn(db, { email: "", password: PASSWORD }, T0)).toEqual({ ok: false, reason: "invalid" });
    expect(await signIn(db, { email: "dee@skybook.com", password: "" }, T0)).toEqual({ ok: false, reason: "invalid" });
    expect(
      await signIn(db, { email: "dee@skybook.com", password: "x".repeat(129) }, T0)
    ).toEqual({ ok: false, reason: "invalid" });
  });

  describe("session lookup", () => {
    it("turns a live token back into its user — admin role included", async () => {
      const result = await signIn(db, { email: "ada@skybook.com", password: PASSWORD }, T0);
      if (!result.ok) throw new Error("expected sign-in");
      expect(await getSessionUser(db, result.token, minutes(1))).toMatchObject({
        email: "ada@skybook.com",
        role: "admin",
      });
    });

    it("ends the session when it expires", async () => {
      const result = await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, T0);
      if (!result.ok) throw new Error("expected sign-in");
      const justBefore = new Date(result.expiresAt.getTime() - 1);
      expect(await getSessionUser(db, result.token, justBefore)).not.toBeNull();
      expect(await getSessionUser(db, result.token, result.expiresAt)).toBeNull();
    });

    it("ends the session when the account is switched off", async () => {
      const result = await signIn(db, { email: "ada@skybook.com", password: PASSWORD }, T0);
      if (!result.ok) throw new Error("expected sign-in");
      await db.query("update app_users set active = false where email = 'ada@skybook.com'");
      try {
        expect(await getSessionUser(db, result.token, minutes(1))).toBeNull();
      } finally {
        await db.query("update app_users set active = true where email = 'ada@skybook.com'");
      }
    });

    it("ignores tokens that are malformed or made up", async () => {
      expect(await getSessionUser(db, "not-a-token", T0)).toBeNull();
      expect(await getSessionUser(db, "A".repeat(43), T0)).toBeNull();
    });

    it("sign-out removes the session for good", async () => {
      const result = await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, T0);
      if (!result.ok) throw new Error("expected sign-in");
      await signOut(db, result.token);
      expect(await getSessionUser(db, result.token, minutes(1))).toBeNull();
    });

    it("cleans up expired sessions when someone signs in", async () => {
      await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, T0);
      const muchLater = new Date(T0.getTime() + SESSION_DURATION_MS * 3);
      await signIn(db, { email: "dee@skybook.com", password: PASSWORD }, muchLater);
      const [row] = await db.query<{ count: number }>(
        "select count(*)::int as count from app_sessions where expires_at <= $1",
        [muchLater]
      );
      expect(row.count).toBe(0);
    });
  });

  describe("failed-attempt limit", () => {
    const email = "dee@skybook.com";

    it(`allows ${SIGN_IN_LIMIT.maxAttempts} attempts per 15 minutes, then blocks even the right password`, async () => {
      for (let i = 0; i < SIGN_IN_LIMIT.maxAttempts; i++) {
        expect(await signIn(db, { email, password: `wrong-password-${i}` }, minutes(100))).toEqual({
          ok: false,
          reason: "invalid",
        });
      }
      const blocked = await signIn(db, { email, password: PASSWORD }, minutes(101));
      expect(blocked).toMatchObject({ ok: false, reason: "throttled" });
      if (blocked.ok || blocked.reason !== "throttled") return;
      expect(blocked.retryAfterSeconds).toBe(14 * 60);
    });

    it("opens again once the window has passed", async () => {
      const result = await signIn(db, { email, password: PASSWORD }, minutes(116));
      expect(result.ok).toBe(true);
    });

    it("clears the count after a successful sign-in", async () => {
      await signIn(db, { email, password: "wrong-password-x" }, minutes(200));
      await signIn(db, { email, password: PASSWORD }, minutes(200));
      const rows = await db.query("select * from login_throttle where key = $1", [`email:${email}`]);
      expect(rows).toEqual([]);
    });

    it("limits unknown emails the same way, so the limit doesn't reveal real accounts", async () => {
      const ghost = "ghost@skybook.com";
      for (let i = 0; i < SIGN_IN_LIMIT.maxAttempts; i++) {
        await signIn(db, { email: ghost, password: PASSWORD }, minutes(300));
      }
      expect(await signIn(db, { email: ghost, password: PASSWORD }, minutes(300))).toMatchObject({
        reason: "throttled",
      });
    });

    it("counts attempts sent at the same moment", async () => {
      const email2 = "burst@skybook.com";
      const results = await Promise.all(
        Array.from({ length: SIGN_IN_LIMIT.maxAttempts + 3 }, () =>
          signIn(db, { email: email2, password: "whatever-password" }, minutes(400))
        )
      );
      const throttled = results.filter((r) => !r.ok && r.reason === "throttled");
      expect(throttled).toHaveLength(3);
    });
  });

  describe("per-IP limit", () => {
    const ipCount = async (key: string) =>
      (await db.query<{ attempts: number }>("select attempts from login_throttle where key = $1", [key]))[0]?.attempts ?? 0;

    it(`allows ${SIGN_IN_IP_LIMIT.maxAttempts} attempts per 15 minutes from one address, across many emails`, async () => {
      const clientIp = "203.0.113.10";
      for (let i = 0; i < SIGN_IN_IP_LIMIT.maxAttempts; i++) {
        // A different email each time, so the per-email limit never triggers.
        const result = await signIn(db, { email: `guess-${i}@skybook.com`, password: PASSWORD, clientIp }, minutes(500));
        expect(result).toEqual({ ok: false, reason: "invalid" });
      }
      const blocked = await signIn(db, { email: "guess-next@skybook.com", password: PASSWORD, clientIp }, minutes(501));
      expect(blocked).toEqual({ ok: false, reason: "throttled", retryAfterSeconds: 14 * 60 });
    });

    it("blocks even the right password from that address, without touching the person's own email count", async () => {
      const clientIp = "203.0.113.10";
      expect(await signIn(db, { email: "ada@skybook.com", password: PASSWORD, clientIp }, minutes(502))).toMatchObject({
        reason: "throttled",
      });
      expect(await ipCount("email:ada@skybook.com")).toBe(0);
    });

    it("doesn't affect anyone signing in from another address", async () => {
      const result = await signIn(db, { email: "ada@skybook.com", password: PASSWORD, clientIp: "198.51.100.20" }, minutes(502));
      expect(result.ok).toBe(true);
    });

    it("opens again once the window has passed", async () => {
      const result = await signIn(db, { email: "ada@skybook.com", password: PASSWORD, clientIp: "203.0.113.10" }, minutes(516));
      expect(result.ok).toBe(true);
    });

    it("keeps counting after a successful sign-in (only the email count is cleared)", async () => {
      const clientIp = "203.0.113.11";
      await signIn(db, { email: "dee@skybook.com", password: "wrong-password-y", clientIp }, minutes(600));
      await signIn(db, { email: "dee@skybook.com", password: PASSWORD, clientIp }, minutes(600));
      expect(await ipCount("ip:203.0.113.11")).toBe(2);
      expect(await ipCount("email:dee@skybook.com")).toBe(0);
    });

    it("still applies the per-email limit to attempts from different addresses", async () => {
      const email = "spread@skybook.com";
      for (let i = 0; i < SIGN_IN_LIMIT.maxAttempts; i++) {
        await signIn(db, { email, password: PASSWORD, clientIp: `192.0.2.${i + 1}` }, minutes(700));
      }
      expect(await signIn(db, { email, password: PASSWORD, clientIp: "192.0.2.99" }, minutes(700))).toMatchObject({
        reason: "throttled",
      });
    });

    it("counts IPv6 addresses in one /64 together", async () => {
      await signIn(db, { email: "v6-a@skybook.com", password: PASSWORD, clientIp: "2001:db8:5:6::1" }, minutes(800));
      await signIn(db, { email: "v6-b@skybook.com", password: PASSWORD, clientIp: "2001:db8:5:6::abcd" }, minutes(800));
      expect(await ipCount("ip:2001:db8:5:6::/64")).toBe(2);
    });

    it("counts attempts sent at the same moment", async () => {
      const clientIp = "203.0.113.12";
      const results = await Promise.all(
        Array.from({ length: SIGN_IN_IP_LIMIT.maxAttempts + 4 }, (_, i) =>
          signIn(db, { email: `burst-ip-${i}@skybook.com`, password: "whatever-password", clientIp }, minutes(900))
        )
      );
      expect(results.filter((r) => !r.ok && r.reason === "throttled")).toHaveLength(4);
    });

    it("is skipped when the address is unknown (no counter row)", async () => {
      await signIn(db, { email: "no-ip@skybook.com", password: PASSWORD, clientIp: null }, minutes(1000));
      const rows = await db.query("select key from login_throttle where key like 'ip:%' and window_started_at = $1", [minutes(1000)]);
      expect(rows).toEqual([]);
    });
  });
});
