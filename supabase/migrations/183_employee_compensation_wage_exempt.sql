-- Explizit-Kennzeichen: dieser Mitarbeiter wird NICHT entgeltet
-- (z.B. Inhaber, Praktikant ohne Vertrag, ehrenamtliche Helfer).
-- Unterschied zu "noch kein Lohn hinterlegt": exempt = bewusste Wahl,
-- kein Lohn faellt an. Konsequenz: Mitarbeiter erscheint gar nicht
-- in der Monats-Lohntabelle und wird in Kosten-Aggregaten uebersprungen.
--
-- hourly_wage_chf bleibt NOT NULL — bei exempt=true steht dort 0.
-- Ist ok weil alle Kosten-Berechnungen den exempt-Flag prio-en.

alter table public.employee_compensation
  add column if not exists wage_exempt boolean not null default false;

comment on column public.employee_compensation.wage_exempt is
  'true = Mitarbeiter wird nicht entgeltet (Inhaber, Praktikant, ehrenamtl.). Erscheint dann nicht in der Lohntabelle.';
