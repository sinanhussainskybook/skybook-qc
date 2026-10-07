-- Skybook AI QC — content analysis runs (Phase 6, plan 6.10; D5 / D6 / D10)
--
-- TEMPORARY processing state, not history. A run is one analysis of a QC
-- session's current files by the worker (npm run qc:worker). It belongs to
-- the session and is deleted with it (24 hours after the session's last
-- change, or on Start over) — like every other QC table (D11).
--
-- `detections` holds the VALIDATED ContentDetections for the run (never a
-- raw provider response), and only the newest finished content run of a
-- session keeps it. Nothing here outlives the session: no QC history.
--
-- The table is also the queue: the worker claims a queued run with
-- SELECT … FOR UPDATE SKIP LOCKED. No separate queue service.
--
-- Row-level security is on with no policies, as for every QC table.

create table qc_analysis_runs (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references qc_sessions (id) on delete cascade,
  -- The designer who asked for it; the worker re-checks this is still the session's owner.
  requested_by      uuid not null references app_users (id) on delete cascade,
  -- content: analyse the content being checked; information: read the uploaded information (6.7).
  kind              text not null check (kind in ('content', 'information')),
  provider          text not null check (provider in ('mock', 'google')),
  status            text not null default 'queued'
                    check (status in ('queued', 'processing', 'done', 'failed', 'cancelled')),
  stage             text check (char_length(stage) <= 80),
  progress_done     integer not null default 0 check (progress_done >= 0),
  progress_total    integer not null default 0 check (progress_total >= 0 and progress_total <= 100000),
  attempts          integer not null default 0 check (attempts between 0 and 10),
  -- Which files were analysed; when the session's files change, the result no longer applies.
  files_fingerprint text not null check (char_length(files_fingerprint) between 1 and 200),
  detections        jsonb check (detections is null or octet_length(detections::text) <= 4000000),
  analysed_share    real check (analysed_share is null or (analysed_share >= 0 and analysed_share <= 1)),
  -- A short, plain reason shown to the designer. Never provider output or secrets.
  failure_reason    text check (char_length(failure_reason) <= 300),
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  heartbeat_at      timestamptz,
  finished_at       timestamptz
);

-- One active run per session.
create unique index qc_analysis_runs_one_active
  on qc_analysis_runs (session_id) where status in ('queued', 'processing');
-- The worker's queue order, and the page's "latest run".
create index qc_analysis_runs_queue on qc_analysis_runs (status, created_at);
create index qc_analysis_runs_session on qc_analysis_runs (session_id, created_at desc);

alter table qc_analysis_runs enable row level security;
