-- Skybook AI QC — company logos (Phase 3.5, D3)
--
-- The logo FILE lives in Supabase Storage (private bucket "company-logos").
-- This table holds only its metadata. Never a binary / blob.
-- One current logo per company; no history, no old versions.

create table company_logos (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null unique references companies (id) on delete cascade,
  file_name    text not null check (char_length(file_name) between 1 and 255),
  -- Always "{company_id}/{random uuid}.{ext}", made by the server. The path
  -- must start with this row's own company, so it can't point elsewhere.
  storage_path text not null unique check (
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp|svg)$'
    and starts_with(storage_path, company_id::text || '/')
  ),
  mime_type    text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  file_size    integer not null check (file_size between 1 and 2097152),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table company_logos enable row level security;

-- The private Storage bucket, created only where Supabase's storage schema
-- exists (not in tests). Private, 2 MB limit, logo types only. No policies
-- are added to storage.objects: Supabase's anon / authenticated roles get no
-- access; only the app's server (service role) reads and writes, after its
-- own sign-in and company-membership checks.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and to_regclass('storage.buckets') is not null then
    begin
      insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('company-logos', 'company-logos', false, 2097152,
              array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
      on conflict (id) do update set
        public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
    exception when insufficient_privilege then
      raise notice 'Could not create the company-logos bucket from SQL. Create it in the Supabase dashboard: private, 2 MB, PNG/JPEG/WEBP/SVG.';
    end;
  end if;
end
$$;
