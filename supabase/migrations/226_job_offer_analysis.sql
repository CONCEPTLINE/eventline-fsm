-- 226_job_offer_analysis.sql
-- ============================================================
-- Cache fuer die KI-Analyse der Offerten-PDFs pro Auftrag.
--
-- Feature (Leo 2026-09-08): Aus dem im Auftrag hinterlegten
-- Offerten-Dokument (Dateiname enthaelt "offerte") werden per
-- Claude API NUR die Arbeits-/Stundenpositionen extrahiert
-- (kein Material). Gewinn = Offerten-Arbeitserloes minus
-- Personal-Kosten-Prognose (job-costs.ts) — angezeigt als
-- Pill neben der Kosten-Prognose im Termine-Header.
--
-- Cache-Logik: 1 Row pro Auftrag. Neu analysiert wird NUR wenn
-- keine Row existiert oder document_path nicht mehr zum aktuell
-- neuesten Offerten-PDF passt (= Offerte ersetzt/geloescht).
-- So gibt es KEINEN LLM-Call pro Seitenaufruf.
-- ============================================================

create table if not exists public.job_offer_analysis (
  job_id           uuid primary key references public.jobs(id) on delete cascade,
  -- storage_path des analysierten Offerten-PDFs — Cache-Schluessel:
  -- weicht er vom aktuell neuesten Offerten-Dokument ab, wird neu analysiert.
  document_path    text not null,
  -- Summe aller Arbeits-/Stundenpositionen der Offerte in CHF (ohne Material).
  total_arbeit_chf numeric not null default 0,
  -- Extrahierte Einzelpositionen: [{beschreibung, stunden|null, betrag_chf}]
  positions        jsonb not null default '[]'::jsonb,
  analyzed_at      timestamptz not null default now(),
  -- Verwendetes Claude-Modell (Nachvollziehbarkeit bei Modellwechsel).
  model            text
);

comment on table public.job_offer_analysis is
  'KI-extrahierte Arbeitsstunden-Positionen aus dem Offerten-PDF eines Auftrags (Cache — 1 LLM-Call pro Offerten-Version, nicht pro Seitenaufruf).';

alter table public.job_offer_analysis enable row level security;

-- Bewusst KEIN authenticated-Zugriff: nur service_role (Admin-Client in
-- /api/admin/job-offer-profit, dort admin-gated) liest/schreibt. Die Daten
-- lassen Rueckschluesse auf Marge/Loehne zu — Clients bleiben komplett
-- draussen. Die 4-Verben-Regel wird wie in 209_user_passkeys.sql mit
-- explizit-verbietenden Policies dokumentiert.
drop policy if exists job_offer_analysis_select_none on public.job_offer_analysis;
create policy job_offer_analysis_select_none on public.job_offer_analysis
  for select to authenticated using (false);

drop policy if exists job_offer_analysis_insert_none on public.job_offer_analysis;
create policy job_offer_analysis_insert_none on public.job_offer_analysis
  for insert to authenticated with check (false);

drop policy if exists job_offer_analysis_update_none on public.job_offer_analysis;
create policy job_offer_analysis_update_none on public.job_offer_analysis
  for update to authenticated using (false);

drop policy if exists job_offer_analysis_delete_none on public.job_offer_analysis;
create policy job_offer_analysis_delete_none on public.job_offer_analysis
  for delete to authenticated using (false);
