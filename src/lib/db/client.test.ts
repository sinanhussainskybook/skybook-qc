import { describe, expect, it } from "vitest";
import { connect, databaseSsl, DatabaseTlsError, DEFAULT_POOL_MAX, isLocalDatabaseHost, parsePoolMax } from "@/lib/db/client";

describe("database TLS", () => {
  const supabase = (query = "") => `postgresql://postgres.abcdefghij:not-a-real-password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres${query}`;

  it("a remote database always uses TLS — with sslmode=require, or when sslmode is missing", () => {
    expect(databaseSsl(supabase("?pgbouncer=true&sslmode=require"))).toBe("require");
    expect(databaseSsl(supabase("?pgbouncer=true"))).toBe("require"); // the live misconfiguration found in review: now encrypted anyway
    expect(databaseSsl(supabase())).toBe("require");
    expect(databaseSsl(supabase("?sslmode=REQUIRE"))).toBe("require");
    expect(databaseSsl(supabase("?sslmode=verify-full"))).toBe("verify-full");
    expect(databaseSsl(supabase("?sslmode=verify-ca"))).toBe("verify-full");
    expect(databaseSsl("postgres://user:pw@db.example.com/app")).toBe("require");
  });

  it("a remote database configured WITHOUT TLS is refused before anything is sent — the message never shows the connection string", () => {
    for (const mode of ["disable", "allow", "prefer", "false"]) {
      const url = supabase(`?pgbouncer=true&sslmode=${mode}`);
      expect(() => databaseSsl(url), mode).toThrow(DatabaseTlsError);
      expect(() => connect(url), mode).toThrow(DatabaseTlsError); // connect() itself refuses
      try {
        databaseSsl(url);
      } catch (error) {
        expect((error as Error).message).toMatch(/must be encrypted: use sslmode=require/);
        expect((error as Error).message).not.toMatch(/not-a-real-password|pooler\.supabase\.com|abcdefghij/);
      }
    }
    expect(() => databaseSsl("not a url")).toThrow(DatabaseTlsError);
  });

  it("a local database keeps its own settings (development unchanged)", () => {
    for (const url of [
      "postgres://postgres:postgres@localhost:5432/qc",
      "postgres://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable",
      "postgres://postgres@[::1]:5432/qc",
      "postgres://postgres@db.localhost/qc",
      "postgres://postgres@/qc?host=/var/run/postgresql",
    ]) {
      expect(databaseSsl(url), url).toBeUndefined();
    }
    expect(isLocalDatabaseHost("LOCALHOST")).toBe(true);
    expect(isLocalDatabaseHost("pooler.supabase.com")).toBe(false);
    expect(isLocalDatabaseHost("localhost.evil.com")).toBe(false);
  });

  it("connect() passes TLS to the driver only for remote databases", () => {
    const remote = connect(supabase("?pgbouncer=true"), { max: 1 }) as unknown as { options: { ssl: unknown } };
    expect(remote.options.ssl).toBe("require");
    // Local: no ssl option is passed, so the connection string's own sslmode still applies.
    const local = connect("postgres://postgres:postgres@localhost:5432/qc?sslmode=require", { max: 1 }) as unknown as { options: { ssl: unknown } };
    expect(local.options.ssl).toBe("require");
    const plainLocal = connect("postgres://postgres:postgres@localhost:5432/qc", { max: 1 }) as unknown as { options: { ssl: unknown } };
    expect(plainLocal.options.ssl).toBe(false);
  });
});

describe("DATABASE_POOL_MAX", () => {
  it("uses a whole number from 1 to 20", () => {
    expect(parsePoolMax("1")).toBe(1);
    expect(parsePoolMax(" 20 ")).toBe(20);
  });

  it("falls back to the default for anything else", () => {
    for (const raw of [undefined, "", "0", "21", "-1", "2.5", "lots"]) {
      expect(parsePoolMax(raw), String(raw)).toBe(DEFAULT_POOL_MAX);
    }
  });
});
