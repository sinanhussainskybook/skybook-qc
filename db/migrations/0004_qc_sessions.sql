-- Skybook AI QC — temporary QC sessions (Phase 4, D11)
--
-- TEMPORARY working data, not history. A session holds what one designer is
-- checking right now for one company: the content type, the client's
-- requirements, and the files uploaded for this check. It is deleted
-- automatically 24 hours after its last change (expires_at), or when the
-- designer starts over — together with its requirements, file records and
-- the files in the private `qc-temp-files` bucket.
--
-- Company information is NOT copied here: sessions reference the company,
-- and the QC engine reads the company's saved configuration directly.
-- Files are never stored in the database — only their metadata.
--
-- Row-level security is on with no policies, as for every QC table.

create table qc_sessions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id) on delete cascade,
  user_id      uuid not null references app_users (id) on delete cascade,
  content_type text not null check (content_type in ('design_poster', 'social_post', 'reel_short', 'youtube_video')),
  status       text not null default 'draft' check (status in ('draft', 'ready')),
  expires_at   timestamptz not null default now() + interval '24 hours',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One current session per designer per company: no session history.
  unique (company_id, user_id)
);

create index qc_sessions_expires_at_idx on qc_sessions (expires_at);
create index qc_sessions_user_id_idx on qc_sessions (user_id);

alter table qc_sessions enable row level security;

-- Uploaded information and the content being checked. The file itself is in
-- Storage at "{session_id}/{file id}.{ext}" — a path made by the server.
create table qc_files (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references qc_sessions (id) on delete cascade,
  kind         text not null check (kind in ('information', 'content')),
  file_name    text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique check (
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|doc|docx|xls|xlsx|txt|jpg|png|webp|mp4|mov|webm)$'
    and starts_with(storage_path, session_id::text || '/')
  ),
  mime_type    text not null check (mime_type in (
                 'application/pdf', 'application/msword',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                 'application/vnd.ms-excel',
                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                 'text/plain', 'image/jpeg', 'image/png', 'image/webp',
                 'video/mp4', 'video/quicktime', 'video/webm')),
  file_size    bigint not null check (file_size between 1 and 52428800),
  -- pending: upload link handed out, file not yet checked; ready: checked and usable.
  status       text not null default 'pending' check (status in ('pending', 'ready')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index qc_files_session_id_idx on qc_files (session_id);

alter table qc_files enable row level security;

-- What the client asked for. `type` is an open key (the list lives in code),
-- so new requirement types need no migration. Requirements found by future
-- AI / OCR extraction are `source = 'extracted'` and start unconfirmed;
-- only confirmed requirements are ever used by QC.
create table qc_requirements (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references qc_sessions (id) on delete cascade,
  type           text not null check (type ~ '^[a-z][a-z0-9_]{0,39}$'),
  label          text check (char_length(label) <= 120),
  expected_value text not null check (char_length(expected_value) between 1 and 2000),
  notes          text check (char_length(notes) <= 1000),
  mandatory      boolean not null default true,
  confirmed      boolean not null default false,
  source         text not null default 'manual' check (source in ('manual', 'extracted')),
  source_file_id uuid references qc_files (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index qc_requirements_session_id_idx on qc_requirements (session_id);

alter table qc_requirements enable row level security;

-- The private TEMPORARY bucket for session files, created only where
-- Supabase's storage schema exists (not in tests). Separate from the
-- permanent company-logos bucket. 50 MB per file (Supabase Free plan's
-- maximum), QC file types only, no Storage policies (server-only access).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and to_regclass('storage.buckets') is not null then
    begin
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('qc-temp-files', 'qc-temp-files', false, 52428800,
              array['application/pdf', 'application/msword',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/vnd.ms-excel',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'text/plain', 'image/jpeg', 'image/png', 'image/webp',
                    'video/mp4', 'video/quicktime', 'video/webm'])
      on conflict (id) do update set
        public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
    exception when insufficient_privilege then
      raise notice 'Could not create the qc-temp-files bucket from SQL. Create it in the Supabase dashboard: private, 50 MB, QC file types.';
    end;
  end if;
end
$$;
