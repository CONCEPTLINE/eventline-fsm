-- 287: "Zusagen an den Kunden" komplett entfernt (2026-10-02: "da stehen
-- immer die gleichen Sachen drin wie oben schon als Offen, und sie sind
-- immer so selbstverstaendliche Sachen"). Die KI pflegt keine Zusagen mehr
-- (lib/ai/eingang-verarbeitung.ts), die Karte auf der Uebersicht ist weg.
-- Daten vor dem Loeschen exportiert nach
-- C:\tmp\eventline-backup\job_zusagen_2026-10-02.json.
-- Ohne CASCADE: haengt doch noch etwas daran, bricht die Migration ab.

drop table if exists public.job_zusagen;
