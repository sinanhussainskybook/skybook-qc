-- Skybook AI QC — the Gemini API provider (Google AI Studio, GEMINI_API_KEY)
--
-- Additive: a run may now be processed by the "gemini" provider. Nothing else
-- changes; runs stay temporary and are deleted with their session.

alter table qc_analysis_runs drop constraint if exists qc_analysis_runs_provider_check;
alter table qc_analysis_runs
  add constraint qc_analysis_runs_provider_check check (provider in ('mock', 'google', 'local', 'gemini'));
