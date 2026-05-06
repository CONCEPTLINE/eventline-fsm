-- Trigram-Indizes fuer schnellere ILIKE-Suchen.
--
-- Standard-B-tree-Indizes helfen bei ILIKE '%foo%' nicht — Postgres muss
-- jede Zeile sequenziell scannen. pg_trgm + GIN-Index speichert 3-Zeichen-
-- Trigramme aller Werte → ILIKE 'sca%' oder '%sca%' nutzt den Index und
-- skaliert auf 100k+ Zeilen ohne spuerbaren Slowdown.
--
-- Drei haupt-Suchfelder:
--  - jobs.title          (Operations-Liste, Stempel-Modal, Tickets)
--  - customers.name      (/kunden, Auftrag-Form)
--  - tickets.title       (Tickets-Liste, Belege)
--
-- Kosten: ein paar MB pro Index, schreib-Latenz minimal hoeher (nicht
-- spuerbar bei der Eventline-Schreibrate).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS jobs_title_trgm_idx
  ON public.jobs USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS customers_name_trgm_idx
  ON public.customers USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS tickets_title_trgm_idx
  ON public.tickets USING GIN (title gin_trgm_ops);
