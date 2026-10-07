-- Skybook AI QC — companies and their saved brand / QC configuration (Phase 3)
--
-- Saved information only. Every company-owned table points at companies(id)
-- with ON DELETE CASCADE, so nothing here can exist without its company or
-- become global. Access is by membership (D13).
--
-- Logos are NOT stored yet: where logo files live is decision D3, still open.
--
-- Row-level security is on with no policies, as for the Phase 2 tables.

create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  description text check (char_length(description) <= 2000),
  category    text check (char_length(category) <= 100),
  country     text check (char_length(country) <= 100),
  city        text check (char_length(city) <= 100),
  address     text check (char_length(address) <= 500),
  active      boolean not null default true,
  created_by  uuid references app_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table companies enable row level security;

-- Who may open which company (D13). Admins can open every company without a row here.
create table company_members (
  company_id uuid not null references companies (id) on delete cascade,
  user_id    uuid not null references app_users (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (company_id, user_id)
);

create index company_members_user_id_idx on company_members (user_id);

alter table company_members enable row level security;

-- One set of contact details per company. Phone and WhatsApp are kept as typed.
create table company_contacts (
  company_id uuid primary key references companies (id) on delete cascade,
  phone      text check (char_length(phone) <= 40),
  whatsapp   text check (char_length(whatsapp) <= 40),
  email      text check (char_length(email) <= 254),
  website    text check (website ~ '^https?://' and char_length(website) <= 2048),
  updated_at timestamptz not null default now()
);

alter table company_contacts enable row level security;

-- The written parts of the brand guidelines, one row per company.
create table brand_profiles (
  company_id           uuid primary key references companies (id) on delete cascade,
  tone                 text check (char_length(tone) <= 2000),
  capitalization_rules text check (char_length(capitalization_rules) <= 2000),
  naming_conventions   text check (char_length(naming_conventions) <= 2000),
  logo_rules           text check (char_length(logo_rules) <= 2000),
  template_notes       text check (char_length(template_notes) <= 2000),
  other_guidelines     text check (char_length(other_guidelines) <= 5000),
  updated_at           timestamptz not null default now()
);

alter table brand_profiles enable row level security;

-- Approved brand colours. HEX is stored as #RRGGBB; RGB is worked out from it
-- when shown. CMYK is optional because it can't be worked out exactly.
create table brand_colors (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  hex        text not null check (hex ~ '^#[0-9A-F]{6}$'),
  cmyk       text check (cmyk ~ '^\d{1,3}, \d{1,3}, \d{1,3}, \d{1,3}$'),
  usage      text check (char_length(usage) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index brand_colors_company_id_idx on brand_colors (company_id);
alter table brand_colors enable row level security;

-- Approved fonts.
create table brand_fonts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  family        text not null check (char_length(family) between 1 and 100),
  weights       text check (char_length(weights) <= 200),
  usage         text check (char_length(usage) <= 200),
  size_guidance text check (char_length(size_guidance) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index brand_fonts_company_id_idx on brand_fonts (company_id);
alter table brand_fonts enable row level security;

-- Terminology: words to use (approved) or avoid (banned).
create table brand_terms (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id) on delete cascade,
  term       text not null check (char_length(term) between 1 and 200),
  kind       text not null check (kind in ('approved', 'banned')),
  note       text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index brand_terms_company_id_idx on brand_terms (company_id);
alter table brand_terms enable row level security;

-- Golden Rules (D12): the company's non-negotiable rules. Stored and managed
-- here; applied automatically by the QC engine from Phase 5.
create table golden_rules (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies (id) on delete cascade,
  rule           text not null check (char_length(rule) between 1 and 1000),
  category       text not null check (category in (
                   'mandatory_disclaimer', 'approved_product_name', 'approved_cta',
                   'logo_rule', 'approved_color', 'approved_font', 'other')),
  approved_value text check (char_length(approved_value) <= 1000),
  mandatory      boolean not null default false,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index golden_rules_company_id_idx on golden_rules (company_id);
alter table golden_rules enable row level security;
