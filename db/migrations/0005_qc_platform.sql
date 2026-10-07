-- Skybook AI QC — platform / placement and measured content (Phase 5, task 5.11, D4)
--
-- Extends the EXISTING temporary QC tables (D11); no new tables, so the same
-- ownership, expiry and clean-up rules keep applying.
--
--  * qc_sessions: which platform and placement the content is for. The
--    approved platform values (D4) live in code (lib/qc/platforms.ts); the
--    database only checks the keys are well formed. For platforms with no
--    official spec (website / email banner, print, presentation slide, other)
--    the designer types the required size, stored in the custom_* columns.
--  * qc_files: what was measured from the uploaded content itself (width,
--    height, length, DPI, pages) — never the file, only numbers.

alter table qc_sessions
  add column platform         text check (platform ~ '^[a-z][a-z0-9_]{0,39}$'),
  add column placement        text check (placement ~ '^[a-z][a-z0-9_]{0,39}$'),
  add column custom_label     text check (char_length(custom_label) between 1 and 120),
  add column custom_width     integer check (custom_width between 1 and 100000),
  add column custom_height    integer check (custom_height between 1 and 100000),
  add column custom_unit      text check (custom_unit in ('px', 'mm')),
  add column custom_min_dpi   integer check (custom_min_dpi between 1 and 2400),
  add column custom_max_bytes bigint check (custom_max_bytes between 1 and 52428800),
  -- A placement only together with a platform; a custom size always has both sides and a unit.
  add constraint qc_sessions_placement_needs_platform check (placement is null or platform is not null),
  add constraint qc_sessions_custom_size_complete check (
    (custom_width is null and custom_height is null and custom_unit is null)
    or (custom_width is not null and custom_height is not null and custom_unit is not null)
  );

alter table qc_files
  add column media_width       integer check (media_width between 1 and 1000000),
  add column media_height      integer check (media_height between 1 and 1000000),
  add column media_duration_ms bigint  check (media_duration_ms between 0 and 864000000),
  add column media_dpi         integer check (media_dpi between 1 and 100000),
  add column media_pages       integer check (media_pages between 1 and 100000),
  -- Why something couldn't be measured (shown as "not verified", never guessed).
  add column media_note        text check (char_length(media_note) <= 300);
