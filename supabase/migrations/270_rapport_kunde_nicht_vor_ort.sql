-- Einsatzrapport: "Kunde nicht vor Ort" — der Techniker schliesst den
-- Rapport bewusst OHNE Kundenunterschrift ab (niemand da zum
-- Unterschreiben). Wird im Formular als dritte Option neben Kunde/Mieter
-- gewaehlt und im PDF explizit ausgewiesen, statt eine leere
-- Unterschriftslinie zu drucken.

alter table public.service_reports
  add column if not exists client_absent boolean not null default false;
