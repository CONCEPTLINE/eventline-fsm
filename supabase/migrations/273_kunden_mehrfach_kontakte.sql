-- Kunden: mehrere E-Mails/Telefonnummern mit Label (Leo 2026-09-29:
-- "primär, sekundär, notfall oder so"). Als jsonb-Arrays
-- [{label, wert}, ...] direkt am Kunden — kein Join fuer die Anzeige.
--
-- Die bestehenden Einzel-Spalten email/phone BLEIBEN und spiegeln immer
-- den ERSTEN Eintrag der Liste (= Primaerkontakt): alle bestehenden
-- Konsumenten (Bexio-Abgleich, Mails, Listen, PDFs) funktionieren
-- unveraendert weiter. Die Formulare pflegen beide synchron.

alter table public.customers
  add column if not exists emails jsonb not null default '[]'::jsonb,
  add column if not exists phones jsonb not null default '[]'::jsonb;

-- Backfill: bestehende Einzelwerte als Primaer-Eintrag uebernehmen.
update public.customers
  set emails = jsonb_build_array(jsonb_build_object('label', 'Primär', 'wert', btrim(email)))
  where emails = '[]'::jsonb and email is not null and btrim(email) <> '';

update public.customers
  set phones = jsonb_build_array(jsonb_build_object('label', 'Primär', 'wert', btrim(phone)))
  where phones = '[]'::jsonb and phone is not null and btrim(phone) <> '';
