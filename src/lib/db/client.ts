import "server-only";
import postgres from "postgres";
import type { Database } from "@/lib/db/database";

/**
 * The app's connection to its own Supabase PostgreSQL database (D1).
 *
 * The connection string comes from DATABASE_URL — never from code. Nothing
 * connects until the first query, so the app builds without the variable.
 */

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "DATABASE_URL is not set. Add the Supabase connection string to .env.local (see .env.example)."
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

export const DEFAULT_POOL_MAX = 5;

/**
 * Connections the app may hold open at once (DATABASE_POOL_MAX, 1–20).
 * Anything else falls back to the default.
 */
export function parsePoolMax(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_POOL_MAX;
  const value = Number(text);
  return value >= 1 && value <= 20 ? value : DEFAULT_POOL_MAX;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** Wraps a `postgres` connection in the app's Database shape. */
export function wrapPostgres(sql: postgres.Sql | postgres.TransactionSql): Database {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as Row[];
    },
    async exec(script: string) {
      // The simple protocol runs a multi-statement script as one transaction.
      await sql.unsafe(script).simple();
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      if (!("begin" in sql)) throw new Error("Nested database transactions aren't supported.");
      return (await sql.begin((tx) => fn(wrapPostgres(tx)))) as T;
    },
  };
}

/** A database connection that would not be encrypted (never shows the connection string). */
export class DatabaseTlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTlsError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** This machine only (local PostgreSQL in development) — never a remote server. */
export function isLocalDatabaseHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "" || LOCAL_HOSTS.has(h) || h.endsWith(".localhost") || h.startsWith("/");
}

/**
 * TLS for the database connection. Any database that isn't on this machine
 * (Supabase included) MUST be encrypted:
 *   - sslmode require / verify-full / verify-ca, or no sslmode → TLS is used;
 *   - sslmode disable / allow / prefer (which can fall back to plain text) →
 *     refused with a DatabaseTlsError, before anything is sent.
 * A local database keeps whatever its connection string says (unchanged).
 * The result is passed to the driver as its `ssl` option; undefined = the
 * driver's own handling of the connection string (local only).
 */
export function databaseSsl(url: string): "require" | "verify-full" | undefined {
  // No host at all (postgres://user@/db?host=/socket) means a local socket on this machine.
  if (/^postgres(ql)?:\/\/[^/@]*@?\//i.test(url.trim())) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim().replace(/^postgres(ql)?:/i, "http:"));
  } catch {
    throw new DatabaseTlsError("DATABASE_URL isn't a valid connection string.");
  }
  const host = parsed.searchParams.get("host") ?? parsed.hostname;
  if (isLocalDatabaseHost(host)) return undefined;
  const mode = (parsed.searchParams.get("sslmode") ?? "require").toLowerCase();
  if (mode === "require") return "require";
  if (mode === "verify-full" || mode === "verify-ca") return "verify-full";
  throw new DatabaseTlsError(
    `DATABASE_URL points to a remote database with sslmode=${mode}. Remote connections must be encrypted: use sslmode=require.`
  );
}

export function connect(url: string, options: { max?: number } = {}) {
  const ssl = databaseSsl(url);
  return postgres(url, {
    // Remote databases are always encrypted (refused otherwise) — see databaseSsl.
    // Only set for remote ones: the driver treats a present-but-undefined `ssl` as
    // "no TLS", which would override a local connection string's own sslmode.
    ...(ssl ? { ssl } : {}),
    // Supabase's transaction pooler (port 6543) does not support prepared
    // statements; turning them off works with every Supabase connection type.
    prepare: false,
    max: options.max ?? parsePoolMax(process.env.DATABASE_POOL_MAX),
    idle_timeout: 20,
    connect_timeout: 10,
    // Keep NOTICE messages (e.g. "table already exists") out of the logs.
    onnotice: () => {},
  });
}

// One pool per server process. Kept on globalThis so development hot
// reloads don't open a new pool on every edit.
const globalForDb = globalThis as unknown as { skybookQcSql?: postgres.Sql };

export function getDatabase(): Database {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new DatabaseNotConfiguredError();

  globalForDb.skybookQcSql ??= connect(url);
  return wrapPostgres(globalForDb.skybookQcSql);
}
