-- Skybook AI QC — the local analysis provider (Phase 6, Local AI plan)
--
-- Additive: a run may now be processed by the LOCAL provider (PaddleOCR,
-- Ollama on loopback, whisper.cpp on the same server). Nothing else changes;
-- runs stay temporary and are deleted with their session.

alter table qc_analysis_runs drop constraint if exists qc_analysis_runs_provider_check;
alter table qc_analysis_runs
  add constraint qc_analysis_runs_provider_check check (provider in ('mock', 'google', 'local'));
