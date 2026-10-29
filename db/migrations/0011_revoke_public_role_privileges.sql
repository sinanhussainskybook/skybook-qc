-- Skybook AI QC — no table privileges for Supabase's public Data API roles
--
-- QC never uses Supabase's Data API (REST / GraphQL): only the app's server
-- works with the data, through its own database connection as the tables'
-- owner, after its own sign-in and company-membership checks (D13). Row-level
-- security is already on for every table with no policies, so `anon` and
-- `authenticated` can read, add, change and delete no rows. This also takes
-- away every table privilege they have, so they can't even try — including
-- TRUNCATE, which row-level security doesn't cover, and MAINTAIN (VACUUM,
-- ANALYZE and the like; PostgreSQL 17 and later).
--
-- Limited to QC's own 17 tables in public (named below) and the migrating
-- role's default privileges for public. Nothing else is changed: no other
-- table, no Supabase system schema, no storage default, no other role's
-- defaults (e.g. supabase_admin's). Run as the owner of QC's tables (the user
-- in DATABASE_URL; on Supabase, `postgres`). It:
--   0. stops unless it is that owner;
--   1. revokes everything from anon, authenticated and PUBLIC (which both
--      inherit) on QC's tables. As the owner it removes the grants recorded
--      under the owner, which includes grants a superuser made;
--   2. stops this role's default grants to anon and authenticated for tables
--      it creates in public later (QC's future tables);
--   3. checks the result: if anon or authenticated can still do anything at
--      all on a QC table (a grant from another grantor, PUBLIC, or a role they
--      belong to), or this role's defaults would still grant them a new table
--      in public (e.g. an all-schemas default), it stops and names what's left
--      — and, like every migration, nothing of it is kept.
-- The owner's own access is unchanged: the app works exactly as before.
-- Where the roles don't exist (local PostgreSQL, tests) nothing is done.

do $$
declare
  qc_tables constant text[] := array[
    'app_users', 'app_sessions', 'login_throttle',
    'companies', 'company_members', 'company_contacts', 'company_logos',
    'brand_profiles', 'brand_colors', 'brand_fonts', 'brand_terms', 'golden_rules',
    'qc_sessions', 'qc_files', 'qc_requirements', 'qc_analysis_runs',
    'schema_migrations'];
  public_roles text[] := array(select rolname from pg_roles where rolname in ('anon', 'authenticated'));
  -- Every table privilege this server has: MAINTAIN exists from PostgreSQL 17 (naming it earlier is an error).
  -- `revoke all` covers them all on any version; this list is what the final check looks for.
  table_privileges constant text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end;
  t text;
  r text;
  not_owned text;
  leftover text;
  defaults_left text;
begin
  -- Only where Supabase's roles exist (not local PostgreSQL or tests).
  if cardinality(public_roles) = 0 then
    return;
  end if;

  -- 0. Run by the owner of every QC table, or not at all.
  select string_agg(q.name, ', ')
    into not_owned
    from unnest(qc_tables) as q(name)
   where not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = q.name and c.relkind = 'r' and c.relowner = current_user::regrole);
  if not_owned is not null then
    raise exception 'Run this as the owner of QC''s tables (normally postgres). Missing or not owned by %: %', current_user, not_owned;
  end if;

  -- 1. QC's tables: no privileges for anon, authenticated or PUBLIC.
  foreach t in array qc_tables loop
    execute format('revoke all on public.%I from public', t);
    foreach r in array public_roles loop
      execute format('revoke all on public.%I from %I', t, r);
    end loop;
  end loop;

  -- 2. This role's default grants for tables it creates in public later.
  foreach r in array public_roles loop
    execute format('alter default privileges in schema public revoke all on tables from %I', r);
  end loop;

  -- 3. Check the result; if anything is left, stop (nothing of this migration is kept) and name it.
  select string_agg(format('%s: %s on %s', g.rolname, p.priv, q.name), ', ' order by q.name, g.rolname, p.priv)
    into leftover
    from unnest(qc_tables) as q(name)
    cross join unnest(table_privileges) as p(priv)
    cross join (select rolname from pg_roles where rolname = any (public_roles)) as g
   where has_table_privilege(g.rolname, format('public.%I', q.name), p.priv);

  select string_agg(format('%s: %s (%s)', g.rolname, a.privilege_type,
                           case when d.defaclnamespace = 0 then 'all-schemas default' else 'public default' end),
                    ', ' order by g.rolname, a.privilege_type)
    into defaults_left
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) as a
    join pg_roles g on g.oid = a.grantee
   where d.defaclrole = current_user::regrole and d.defaclobjtype = 'r'
     and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
     and g.rolname = any (public_roles);

  if leftover is not null or defaults_left is not null then
    raise exception 'anon / authenticated would still have table privileges. On QC tables: %. In % defaults for new tables: %',
      coalesce(leftover, 'none'), current_user, coalesce(defaults_left, 'none');
  end if;
end
$$;
