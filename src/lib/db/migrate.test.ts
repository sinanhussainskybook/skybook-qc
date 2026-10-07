import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, MIGRATIONS_DIR } from "../../../test/db";
import { applyMigrations, loadMigrations } from "@/lib/db/migrate";

describe("migrations", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("loads the numbered SQL files in order", async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect(migrations.map((m) => m.name)).toEqual([
      "0001_users_and_sign_in.sql",
      "0002_companies.sql",
      "0003_company_logos.sql",
      "0004_qc_sessions.sql",
      "0005_qc_platform.sql",
      "0006_qc_analysis_runs.sql",
      "0007_qc_local_provider.sql",
      "0008_qc_gemini_provider.sql",
    ]);
  });

  it("creates user, sign-in, company and temporary QC-session tables — no file blobs", async () => {
    const test = await createTestDatabase();
    close = test.close;
    const tables = await test.db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename"
    );
    expect(tables.map((t) => t.tablename)).toEqual([
      "app_sessions",
      "app_users",
      "brand_colors",
      "brand_fonts",
      "brand_profiles",
      "brand_terms",
      "companies",
      "company_contacts",
      "company_logos",
      "company_members",
      "golden_rules",
      "login_throttle",
      "qc_analysis_runs",
      "qc_files",
      "qc_requirements",
      "qc_sessions",
      "schema_migrations",
    ]);
    // D3 / D11: logo and QC files live in Storage — no binary column anywhere.
    const binary = await test.db.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'bytea'"
    );
    expect(binary).toEqual([]);
  });

  it("ties every company-owned table to its company, removed with it", async () => {
    const test = await createTestDatabase();
    close = test.close;
    const rows = await test.db.query<{ table_name: string; delete_rule: string }>(
      `select tc.table_name, rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage cu on cu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY' and cu.table_name = 'companies'
        order by tc.table_name`
    );
    expect(rows).toEqual(
      [
        "brand_colors",
        "brand_fonts",
        "brand_profiles",
        "brand_terms",
        "company_contacts",
        "company_logos",
        "company_members",
        "golden_rules",
        "qc_sessions",
      ].map((table_name) => ({ table_name, delete_rule: "CASCADE" }))
    );
  });

  it("switches on row-level security for every table (Supabase Data API sees nothing)", async () => {
    const test = await createTestDatabase();
    close = test.close;
    const rows = await test.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("applies each file once — running again does nothing", async () => {
    const test = await createTestDatabase();
    close = test.close;
    const again = await applyMigrations(test.db, await loadMigrations(MIGRATIONS_DIR));
    expect(again).toEqual([]);
  });

  it("keeps nothing from a file that fails part-way", async () => {
    const test = await createTestDatabase({ migrate: false });
    close = test.close;
    await expect(
      applyMigrations(test.db, [
        { name: "0001_broken.sql", sql: "create table half_done (id int); select * from missing_table;" },
      ])
    ).rejects.toThrow();

    const tables = await test.db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename = 'half_done'"
    );
    expect(tables).toEqual([]);
    expect(await test.db.query("select name from schema_migrations")).toEqual([]);
  });

  it("refuses badly named files", async () => {
    const test = await createTestDatabase({ migrate: false });
    close = test.close;
    await expect(
      applyMigrations(test.db, [{ name: "0002_x'); drop table y; --.sql", sql: "select 1" }])
    ).rejects.toThrow(/Invalid migration name/);
  });
});
