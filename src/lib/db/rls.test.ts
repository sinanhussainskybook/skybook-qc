import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, insertTestUser, MIGRATIONS_DIR } from "../../../test/db";
import type { Database } from "@/lib/db/database";
import { addCompanyMember, findAccessibleCompany, insertCompany, listCompaniesForUser } from "@/lib/db/companies";
import { applyMigrations, loadMigrations } from "@/lib/db/migrate";

/**
 * Supabase's public Data API (REST / GraphQL with the anon or a signed-in user's key) runs as the roles
 * `anon` and `authenticated`. QC never uses it: every table has row-level security switched on with NO
 * policies, so those roles can read, add, change and delete nothing — even if they are given every table
 * privilege (the first block below; migration 0011 takes those privileges away, the second block). Only the
 * app's server connection (the tables' owner) works with the data, after its own sign-in and
 * company-membership checks (D13).
 */

const PUBLIC_ROLES = ["anon", "authenticated"] as const;

/** Every table privilege this PostgreSQL has — MAINTAIN only from PostgreSQL 17 (as migration 0011 checks). */
async function tablePrivilegesOf(db: Database): Promise<string[]> {
  const [{ version }] = await db.query<{ version: string }>("select current_setting('server_version_num') as version");
  return ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", ...(Number(version) >= 170000 ? ["MAINTAIN"] : [])];
}

describe("Supabase Data API roles can't touch QC data (RLS on, no policies) — even with every table privilege", () => {
  let db: Database;
  let close: () => Promise<void>;
  let tables: string[];
  let acme: string;
  let globex: string;

  /** Runs `fn` as `role`, the way the Data API would, and always switches back. */
  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await db.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.query("reset role");
    }
  }
  const countAsOwner = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0].n);

  beforeAll(async () => {
    const test = await createTestDatabase();
    db = test.db;
    close = test.close;
    // As if the Data API roles were given every table privilege again (migration 0011 takes them away).
    for (const role of PUBLIC_ROLES) await db.query(`create role ${role} nologin`);
    await db.query("grant usage on schema public to anon, authenticated");
    await db.query("grant all on all tables in schema public to anon, authenticated");

    tables = (
      await db.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' order by 1`
      )
    ).map((r) => r.relname);

    // Two companies with data in every company table, a designer of each, and a QC check.
    const dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    const sam = await insertTestUser(db, { name: "Sam", email: "sam@skybook.com", role: "designer" });
    acme = (await insertCompany(db, { name: "Acme", createdBy: dee.id })).id;
    globex = (await insertCompany(db, { name: "Globex", createdBy: sam.id })).id;
    await addCompanyMember(db, acme, sam.id);
    for (const id of [acme, globex]) {
      await db.query("insert into company_contacts (company_id, phone) values ($1, '+971 4 123 4567')", [id]);
      await db.query("insert into brand_profiles (company_id, tone) values ($1, 'Warm')", [id]);
      await db.query("insert into brand_colors (company_id, name, hex) values ($1, 'Blue', '#0066B2')", [id]);
      await db.query("insert into brand_fonts (company_id, family) values ($1, 'Geist')", [id]);
      await db.query("insert into brand_terms (company_id, kind, term) values ($1, 'approved', 'Villas')", [id]);
      await db.query("insert into golden_rules (company_id, rule, category) values ($1, 'Always show the logo', 'logo_rule')", [id]);
      await db.query(
        "insert into company_logos (company_id, file_name, storage_path, mime_type, file_size) values ($1::uuid, 'logo.png', $1::uuid::text || '/' || gen_random_uuid() || '.png', 'image/png', 10)",
        [id]
      );
    }
    const [session] = await db.query<{ id: string }>(
      "insert into qc_sessions (company_id, user_id, content_type, expires_at) values ($1, $2, 'design_poster', now() + interval '1 day') returning id",
      [acme, dee.id]
    );
    await db.query("insert into qc_requirements (session_id, type, expected_value) values ($1, 'price', 'AED 1,299')", [session.id]);
    await db.query(
      "insert into qc_analysis_runs (session_id, requested_by, kind, provider, files_fingerprint) values ($1, $2, 'content', 'mock', 'x')",
      [session.id, dee.id]
    );
    await db.query("insert into app_sessions (id, user_id, expires_at) values ($1, $2, now() + interval '1 day')", ["a".repeat(64), dee.id]);
    await db.query("insert into login_throttle (key, attempts, window_started_at) values ('email:dee@skybook.com', 1, now())");
  });
  afterAll(() => close());

  it("every table has row-level security on and NO policies (none to get wrong)", async () => {
    expect(tables.length).toBeGreaterThanOrEqual(17);
    const rls = await db.query<{ relname: string; on: boolean }>(
      `select c.relname, c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`
    );
    for (const row of rls) expect([row.relname, row.on]).toEqual([row.relname, true]);
    expect(await db.query("select policyname from pg_policies where schemaname = 'public'")).toEqual([]);
    // No views or functions of QC's own that could read the tables some other way.
    expect(await db.query("select table_name from information_schema.views where table_schema = 'public'")).toEqual([]);
    expect(await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")).toEqual([]);
  });

  for (const role of PUBLIC_ROLES) {
    it(`${role}: READ — every table looks empty, including both companies' data`, async () => {
      for (const table of tables) {
        expect([table, await as(role, async () => (await db.query(`select * from ${table}`)).length)]).toEqual([table, 0]);
      }
      // The data is there (the owner sees it): it's hidden, not missing.
      expect(await countAsOwner("companies")).toBe(2);
      expect(await countAsOwner("brand_colors")).toBe(2);
    });

    it(`${role}: CREATE — refused by row-level security (no company, user, member or QC check can be added)`, async () => {
      const attempts: [string, string, unknown[]][] = [
        ["companies", "insert into companies (name, created_by) values ('Hijack', (select null::uuid))", []],
        ["company_members", "insert into company_members (company_id, user_id) values ($1, gen_random_uuid())", [globex]],
        ["golden_rules", "insert into golden_rules (company_id, rule, category) values ($1, 'x', 'other')", [globex]],
        ["brand_colors", "insert into brand_colors (company_id, name, hex) values ($1, 'x', '#000000')", [globex]],
        ["app_users", "insert into app_users (name, email, role, password_hash) values ('x', 'x@x.com', 'admin', 'x')", []],
        ["app_sessions", "insert into app_sessions (id, user_id, expires_at) values ($1, gen_random_uuid(), now())", ["b".repeat(64)]],
        ["login_throttle", "insert into login_throttle (key, attempts, window_started_at) values ('email:x@y.com', 1, now())", []],
        ["analysis_usage", "insert into analysis_usage (id, user_id, reserved_at) values (gen_random_uuid(), gen_random_uuid(), now())", []],
      ];
      for (const [table, sql, params] of attempts) {
        await expect(as(role, () => db.query(sql, params)), table).rejects.toThrow(/row-level security/);
      }
      expect(await countAsOwner("companies")).toBe(2);
      expect(await countAsOwner("app_users")).toBe(2);
    });

    it(`${role}: UPDATE — changes nothing in any table (no admin role, no other company's settings)`, async () => {
      for (const [table, set] of [
        ["app_users", "role = 'admin', active = true"],
        ["companies", "name = 'Hijacked'"],
        ["company_contacts", "phone = '+1 555 0000'"],
        ["golden_rules", "rule = 'hijacked'"],
        ["qc_requirements", "expected_value = 'hijacked'"],
        ["login_throttle", "attempts = 0"],
      ] as const) {
        expect([table, (await as(role, () => db.query(`update ${table} set ${set} returning 1`))).length]).toEqual([table, 0]);
      }
      expect((await db.query<{ name: string }>("select name from companies order by name")).map((r) => r.name)).toEqual(["Acme", "Globex"]);
      expect((await db.query<{ role: string }>("select role from app_users")).map((r) => r.role)).toEqual(["designer", "designer"]);
    });

    it(`${role}: DELETE — removes nothing from any table`, async () => {
      const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await countAsOwner(t)] as const)));
      for (const table of tables) {
        expect([table, (await as(role, () => db.query(`delete from ${table} returning 1`))).length]).toEqual([table, 0]);
      }
      const after = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await countAsOwner(t)] as const)));
      expect(after).toEqual(before);
    });
  }

  it("the app's own server connection (the tables' owner) is the only one that works with the data", async () => {
    // RLS isn't forced on the owner: that's how the server reads and writes, after its own checks (D13).
    const forced = await db.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity");
    expect(forced).toEqual([]);
    expect(await countAsOwner("companies")).toBe(2);
  });
});

describe("migration 0011: the Data API roles have no table privileges at all", () => {
  let db: Database;
  let close: () => Promise<void>;
  let tables: string[];
  let PRIVILEGES: string[] = [];

  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await db.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.query("reset role");
    }
  }
  const privilegesOf = async (role: string, table: string) =>
    (
      await Promise.all(
        PRIVILEGES.map(async (p) => [p, (await db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, `public.${table}`, p]))[0].ok] as const)
      )
    )
      .filter(([, ok]) => ok)
      .map(([p]) => p);
  const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0].n);

  beforeAll(async () => {
    // A database set up the way Supabase sets one up: the roles exist BEFORE the migrations run, may use
    // the public schema, and are granted everything on every table the migrating role creates.
    const test = await createTestDatabase({ migrate: false });
    db = test.db;
    close = test.close;
    PRIVILEGES = await tablePrivilegesOf(db);
    for (const role of PUBLIC_ROLES) await db.query(`create role ${role} nologin`);
    await db.query("grant usage on schema public to anon, authenticated");
    await db.query("alter default privileges in schema public grant all on tables to anon, authenticated");

    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const before = migrations.filter((m) => m.name < "0011");
    expect(before.length).toBe(migrations.length - 2);
    await applyMigrations(db, before);
    tables = (
      await db.query<{ relname: string }>(
        "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1"
      )
    ).map((r) => r.relname);
    // Before 0011 the roles hold every privilege on every table — TRUNCATE included, which RLS doesn't cover.
    for (const role of PUBLIC_ROLES) for (const table of tables) expect([role, table, await privilegesOf(role, table)]).toEqual([role, table, PRIVILEGES]);

    // Some data, through the app's own functions (as the owner).
    const dee = await insertTestUser(db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
    const acme = await insertCompany(db, { name: "Acme", createdBy: dee.id });
    await db.query("insert into golden_rules (company_id, rule, category) values ($1, 'Always show the logo', 'logo_rule')", [acme.id]);

    expect(await applyMigrations(db, migrations)).toEqual(["0011_revoke_public_role_privileges.sql", "0012_analysis_usage.sql"]);
  });
  afterAll(() => close());

  it("no privilege of any kind on any table (QC's 16 and schema_migrations)", async () => {
    expect(tables.length).toBeGreaterThanOrEqual(17);
    expect(tables).toContain("schema_migrations");
    for (const role of PUBLIC_ROLES) for (const table of tables) expect([role, table, await privilegesOf(role, table)]).toEqual([role, table, []]);
  });

  it("0012's analysis_usage, created after 0011 even with default grants set up, gets no privilege either", async () => {
    for (const role of PUBLIC_ROLES) expect([role, await privilegesOf(role, "analysis_usage")]).toEqual([role, []]);
  });

  for (const role of PUBLIC_ROLES) {
    it(`${role}: READ, CREATE, UPDATE, DELETE and TRUNCATE are each refused on every table; nothing changes`, async () => {
      const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)] as const)));
      for (const table of tables) {
        const [column] = await db.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position limit 1",
          [table]
        );
        for (const sql of [
          `select * from ${table}`,
          `insert into ${table} default values`,
          `update ${table} set ${column.column_name} = ${column.column_name}`,
          `delete from ${table}`,
          `truncate ${table} cascade`,
        ]) {
          await expect(as(role, () => db.query(sql)), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
        }
      }
      const after = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)] as const)));
      expect(after).toEqual(before);
      expect(after.companies).toBe(1);
      expect(after.golden_rules).toBe(1);
    });
  }

  it("tables added later by the same role get no privileges for them either", async () => {
    await db.query("create table future_feature (id integer primary key)");
    try {
      for (const role of PUBLIC_ROLES) {
        expect(await privilegesOf(role, "future_feature")).toEqual([]);
        await expect(as(role, () => db.query("select * from future_feature"))).rejects.toThrow(/permission denied/);
      }
    } finally {
      await db.query("drop table future_feature");
    }
  });

  it("the app's own connection (the owner) works exactly as before", async () => {
    const owner = await insertTestUser(db, { name: "Owner Check", email: "owner-check@skybook.com", role: "designer" });
    const globex = await insertCompany(db, { name: "Globex", createdBy: owner.id });
    expect((await listCompaniesForUser(db, owner)).map((c) => c.name)).toEqual(["Globex"]);
    expect(await findAccessibleCompany(db, owner, globex.id)).toMatchObject({ name: "Globex" });
    await db.query("update companies set description = 'Updated' where id = $1", [globex.id]);
    await db.query("delete from companies where id = $1", [globex.id]);
    expect(await findAccessibleCompany(db, owner, globex.id)).toBeNull();
  });

  it("is safe to run again, and does nothing where the roles don't exist (local PostgreSQL, tests)", async () => {
    const sql = (await loadMigrations(MIGRATIONS_DIR)).find((m) => m.name.startsWith("0011"))!.sql;
    await db.exec(sql);
    expect(await privilegesOf("anon", "companies")).toEqual([]);
    const plain = await createTestDatabase(); // no anon / authenticated roles: every migration, 0011 and 0012 included
    try {
      const applied = (await plain.db.query<{ name: string }>("select name from schema_migrations order by name")).map((r) => r.name);
      expect(applied).toContain("0011_revoke_public_role_privileges.sql");
      expect(applied.at(-1)).toBe("0012_analysis_usage.sql");
    } finally {
      await plain.close();
    }
  });
});

/**
 * Migration 0011 the way production is set up: QC's 17 tables are owned by a role that is NOT a superuser
 * (Supabase's `postgres`, here `qc_owner`), which has default grants to anon and authenticated in public;
 * another role (Supabase's `supabase_admin`, here `other_admin`) has defaults of its own; and a storage-like
 * schema has defaults too. The migration may change ONLY QC's tables and the owner's defaults for public —
 * and when it can't remove everything, it must stop and keep nothing.
 */
describe("migration 0011 as on production (non-superuser owner; other roles' and schemas' defaults left alone)", () => {
  let PRIVILEGES: string[] = [];
  const OWNER = "qc_owner";
  const QC_TABLES = [
    "app_sessions", "app_users", "brand_colors", "brand_fonts", "brand_profiles", "brand_terms", "companies", "company_contacts",
    "company_logos", "company_members", "golden_rules", "login_throttle", "qc_analysis_runs", "qc_files", "qc_requirements",
    "qc_sessions", "schema_migrations",
  ];
  type Setup = { db: Database; close: () => Promise<void>; migrations: Awaited<ReturnType<typeof loadMigrations>> };

  const privilegesOf = async (db: Database, role: string, table: string) => {
    const out: string[] = [];
    for (const p of PRIVILEGES) {
      if ((await db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, p]))[0].ok) out.push(p);
    }
    return out;
  };
  async function asRole<T>(db: Database, role: string, fn: () => Promise<T>): Promise<T> {
    await db.query(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.query("reset role");
    }
  }
  /** Everything 0011 could change, to prove a failed run kept none of it. */
  async function snapshot(db: Database) {
    return {
      applied: (await db.query<{ name: string }>("select name from schema_migrations order by name")).map((r) => r.name),
      grants: await db.query(
        `select c.relname, coalesce(e.rolname, 'PUBLIC') as grantee, g.rolname as grantor, a.privilege_type
           from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
           left join pg_roles e on e.oid = a.grantee join pg_roles g on g.oid = a.grantor
          where n.nspname = 'public' order by 1, 2, 3, 4`
      ),
      defaults: await db.query(
        `select pg_get_userbyid(d.defaclrole) as role, coalesce(n.nspname, '(all schemas)') as schema, d.defaclacl::text as acl
           from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1, 2`
      ),
    };
  }

  async function productionLike(): Promise<Setup> {
    const test = await createTestDatabase({ migrate: false });
    const { db } = test;
    for (const role of [...PUBLIC_ROLES, OWNER, "other_admin"]) await db.query(`create role ${role} nologin`);
    await db.query(`grant usage, create on schema public to ${OWNER}, other_admin`);
    await db.query("grant usage on schema public to anon, authenticated");
    // The owner's defaults in public (as found on production); other_admin's own defaults in public.
    await db.query(`alter default privileges for role ${OWNER} in schema public grant all on tables to anon, authenticated`);
    await db.query("alter default privileges for role other_admin in schema public grant all on tables to anon, authenticated");
    // A storage-like schema with the owner's defaults: not QC's, must stay as it is.
    await db.query(`create schema storage_like authorization ${OWNER}`);
    await db.query(`alter default privileges for role ${OWNER} in schema storage_like grant all on tables to anon, authenticated`);
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    await asRole(db, OWNER, () => applyMigrations(db, migrations.filter((m) => m.name < "0011")));
    // On QC's tables: a superuser's grant (Supabase: supabase_admin) and a grant to PUBLIC.
    await db.query("grant all on companies to anon, authenticated");
    await db.query("grant select, truncate on golden_rules to public");
    // Tables in public that aren't QC's: one of the owner's (it got the default grants), one of another role.
    await asRole(db, OWNER, () => db.query("create table owner_extra (id integer primary key)"));
    await asRole(db, "other_admin", () => db.query("create table not_qc (id integer primary key)"));
    return { ...test, migrations };
  }
  const applyAs = (setup: Setup, role = OWNER) => asRole(setup.db, role, () => applyMigrations(setup.db, setup.migrations));

  let prod: Setup;
  let before: Awaited<ReturnType<typeof snapshot>>;
  beforeAll(async () => {
    prod = await productionLike();
    PRIVILEGES = await tablePrivilegesOf(prod.db);
    for (const role of PUBLIC_ROLES) for (const t of QC_TABLES) expect([role, t, await privilegesOf(prod.db, role, `public.${t}`)]).toEqual([role, t, PRIVILEGES]);
    before = await snapshot(prod.db);
    expect(await applyAs(prod)).toEqual(["0011_revoke_public_role_privileges.sql", "0012_analysis_usage.sql"]);
  });
  afterAll(() => prod.close());

  it("MAINTAIN is covered on this PostgreSQL (17+): held on every QC table before, gone after", async () => {
    expect(PRIVILEGES).toContain("MAINTAIN");
    const maintainBefore = (before.grants as { relname: string; grantee: string; privilege_type: string }[]).filter(
      (g) => g.privilege_type === "MAINTAIN" && PUBLIC_ROLES.includes(g.grantee as (typeof PUBLIC_ROLES)[number]) && QC_TABLES.includes(g.relname)
    );
    expect(new Set(maintainBefore.map((g) => g.relname)).size).toBe(17);
    for (const role of PUBLIC_ROLES) {
      for (const t of QC_TABLES) {
        expect([role, t, (await prod.db.query<{ ok: boolean }>("select has_table_privilege($1, $2, 'MAINTAIN') as ok", [role, `public.${t}`]))[0].ok]).toEqual([role, t, false]);
      }
    }
  });

  it("removes every privilege on QC's 17 tables — the owner's default grants, the superuser's grant and the PUBLIC one", async () => {
    for (const role of PUBLIC_ROLES) for (const t of QC_TABLES) expect([role, t, await privilegesOf(prod.db, role, `public.${t}`)]).toEqual([role, t, []]);
    expect(await prod.db.query("select 1 from information_schema.role_table_grants where table_name = 'golden_rules' and grantee = 'PUBLIC'")).toEqual([]);
  });

  it("0012's analysis_usage (created by the owner after 0011) gets nothing either, and has row-level security", async () => {
    for (const role of PUBLIC_ROLES) expect([role, await privilegesOf(prod.db, role, "public.analysis_usage")]).toEqual([role, []]);
    const [{ rls }] = await prod.db.query<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = 'public.analysis_usage'::regclass");
    expect(rls).toBe(true);
  });

  it("QC's future tables (created by the owner in public) get nothing", async () => {
    await asRole(prod.db, OWNER, () => prod.db.query("create table later_qc_table (id integer primary key)"));
    try {
      for (const role of PUBLIC_ROLES) expect(await privilegesOf(prod.db, role, "public.later_qc_table")).toEqual([]);
    } finally {
      await prod.db.query("drop table later_qc_table");
    }
  });

  it("changes nothing outside its scope: other tables in public, other roles' defaults, other schemas' defaults", async () => {
    const after = await snapshot(prod.db);
    // Grants on tables that aren't QC's: exactly as before.
    // analysis_usage is QC's too (made by 0012, right after 0011).
    const notQc = (rows: unknown[]) => (rows as { relname: string }[]).filter((r) => !QC_TABLES.includes(r.relname) && r.relname !== "analysis_usage");
    expect(notQc(after.grants)).toEqual(notQc(before.grants));
    expect(await privilegesOf(prod.db, "anon", "public.owner_extra")).toEqual(PRIVILEGES);
    // Defaults: only the owner's for public changed; other_admin's and the storage-like schema's are untouched.
    const others = (rows: unknown[]) => (rows as { role: string; schema: string }[]).filter((r) => !(r.role === OWNER && r.schema === "public"));
    expect(others(after.defaults)).toEqual(others(before.defaults));
    expect(others(after.defaults).length).toBeGreaterThanOrEqual(2);
    await asRole(prod.db, "other_admin", () => prod.db.query("create table other_admin_later (id integer primary key)"));
    await asRole(prod.db, OWNER, () => prod.db.query("create table storage_like.owner_later (id integer primary key)"));
    expect(await privilegesOf(prod.db, "anon", "public.other_admin_later")).toEqual(PRIVILEGES);
    expect(await privilegesOf(prod.db, "anon", "storage_like.owner_later")).toEqual(PRIVILEGES);
  });

  it("the app (the owner's connection) works with QC's tables exactly as before", async () => {
    await asRole(prod.db, OWNER, async () => {
      const dee = await insertTestUser(prod.db, { name: "Dee", email: "dee@skybook.com", role: "designer" });
      const acme = await insertCompany(prod.db, { name: "Acme", createdBy: dee.id });
      expect((await listCompaniesForUser(prod.db, dee)).map((c) => c.name)).toEqual(["Acme"]);
      expect(await findAccessibleCompany(prod.db, dee, acme.id)).toMatchObject({ name: "Acme" });
      await prod.db.query("update companies set description = 'Updated' where id = $1", [acme.id]);
      await prod.db.query("delete from companies where id = $1", [acme.id]);
    });
  });

  it("can't remove a grant (made by a non-owner): stops, names it, keeps NOTHING", async () => {
    const other = await productionLike();
    try {
      await asRole(other.db, OWNER, () => other.db.query("grant all on brand_colors to other_admin with grant option"));
      await asRole(other.db, "other_admin", () => other.db.query("grant all on brand_colors to anon"));
      const was = await snapshot(other.db);
      await expect(applyAs(other)).rejects.toThrow(/On QC tables: anon: DELETE on brand_colors, .*anon: TRUNCATE on brand_colors/);
      expect(await snapshot(other.db)).toEqual(was);
      expect((await snapshot(other.db)).applied).not.toContain("0011_revoke_public_role_privileges.sql");
    } finally {
      await other.close();
    }
  });

  it("a MAINTAIN grant it can't remove (made by a non-owner): stops, names MAINTAIN, keeps NOTHING", async () => {
    const other = await productionLike();
    try {
      await asRole(other.db, OWNER, () => other.db.query("grant maintain on brand_fonts to other_admin with grant option"));
      await asRole(other.db, "other_admin", () => other.db.query("grant maintain on brand_fonts to authenticated"));
      const was = await snapshot(other.db);
      await expect(applyAs(other)).rejects.toThrow(/On QC tables: authenticated: MAINTAIN on brand_fonts\. In qc_owner defaults for new tables: none/);
      expect(await snapshot(other.db)).toEqual(was);
    } finally {
      await other.close();
    }
  });

  it("an all-schemas default of the owner still granting them: stops, names it, keeps NOTHING (and doesn't change it)", async () => {
    const other = await productionLike();
    try {
      await other.db.query(`alter default privileges for role ${OWNER} grant select, truncate on tables to anon`);
      const was = await snapshot(other.db);
      await expect(applyAs(other)).rejects.toThrow(/In qc_owner defaults for new tables: anon: SELECT \(all-schemas default\), anon: TRUNCATE \(all-schemas default\)/);
      expect(await snapshot(other.db)).toEqual(was);
    } finally {
      await other.close();
    }
  });

  it("run as a role that doesn't own QC's tables: stops before changing anything", async () => {
    const other = await productionLike();
    try {
      const was = await snapshot(other.db);
      // Through the migration runner, it's stopped even earlier (it can't touch schema_migrations).
      await expect(applyAs(other, "other_admin")).rejects.toThrow(/must be owner of table schema_migrations/);
      expect(await snapshot(other.db)).toEqual(was);
      // The migration's own check, run on its own as that role.
      const sql = other.migrations.find((m) => m.name.startsWith("0011"))!.sql;
      await expect(asRole(other.db, "other_admin", () => other.db.exec(sql))).rejects.toThrow(
        /Run this as the owner of QC's tables \(normally postgres\)\. Missing or not owned by other_admin: app_users, /
      );
      expect(await snapshot(other.db)).toEqual(was);
    } finally {
      await other.close();
    }
  });
});
