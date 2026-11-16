-- Skybook AI QC — each user's AI analyses in a table of their own
--
-- The per-user AI limits (30 analyses in 24 hours, 2 waiting or running) were
-- counted in the sign-in table `login_throttle`, under `ai:` / `ai-slot:`
-- keys. They now get their own table: one row per analysis, written BEFORE a
-- run is queued (a reservation).
--   reserved_at  when it was reserved: it counts for 24 hours from then;
--   queuing      true while the run is still being queued (it holds one of
--                the user's "waiting or running" places); false once the run
--                is queued (the run itself counts then). A reservation left
--                behind by a crash stops holding a place after 2 minutes.
-- Rows older than 24 hours are deleted by the hourly clean-up.
--
-- Only adds a table: nothing existing is changed, so the app keeps working
-- whether it runs before or after this migration. The old `ai:` rows in
-- `login_throttle` are left alone (the clean-up removes them within a day);
-- the counts restart at zero with the new table.
--
-- Like every QC table: row-level security on with no policies, and no
-- privileges for Supabase's public Data API roles (anon, authenticated) —
-- migration 0011 already stops new tables getting them; this makes sure.

create table analysis_usage (
  id          uuid primary key,
  user_id     uuid not null references app_users (id) on delete cascade,
  reserved_at timestamptz not null,
  queuing     boolean not null default true
);

-- "This user's analyses in the last 24 hours" and the clean-up both look by time.
create index analysis_usage_user_reserved_at on analysis_usage (user_id, reserved_at);
create index analysis_usage_reserved_at on analysis_usage (reserved_at);

alter table analysis_usage enable row level security;

revoke all on analysis_usage from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on analysis_usage from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on analysis_usage from authenticated';
  end if;
end $$;
