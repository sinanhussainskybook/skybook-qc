-- Skybook AI QC — users and sign-in (Phase 2, D1 + D2)
--
-- Saved information only: user accounts and what is needed to sign them in.
-- Nothing about QC content is ever stored in this database.
--
-- Row-level security is switched on for every table with NO policies, so
-- Supabase's public Data API (anon / authenticated keys) can read nothing.
-- Only the app's server connection (the table owner) can.

-- Staff accounts. Created with `npm run user:create`; there is no sign-up.
create table app_users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(btrim(name)) between 1 and 100),
  email         text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  password_hash text not null,
  role          text not null check (role in ('admin', 'designer')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index app_users_email_key on app_users (email);

alter table app_users enable row level security;

-- One row per signed-in browser. `id` is the SHA-256 hash of the cookie
-- token, so a copy of this table cannot be used to sign in.
create table app_sessions (
  id         text primary key check (id ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references app_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index app_sessions_user_id_idx on app_sessions (user_id);
create index app_sessions_expires_at_idx on app_sessions (expires_at);

alter table app_sessions enable row level security;

-- Sign-in attempts per email in a fixed time window. Keyed by the email
-- typed, whether or not an account exists, so the limit never reveals
-- which emails are real. Cleared after a successful sign-in.
create table login_throttle (
  key               text primary key,
  attempts          integer not null check (attempts >= 0),
  window_started_at timestamptz not null
);

alter table login_throttle enable row level security;
