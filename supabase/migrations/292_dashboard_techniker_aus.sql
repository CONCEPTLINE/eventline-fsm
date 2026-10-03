-- 292: Techniker sehen auf dem Dashboard nur ihren Einsatz und ihren Monat
-- (2026-10-03, Mischa). Ihre Rechte (Auftraege/Kalender ansehen) wuerden
-- auch Kennzahlen, «Braucht Aufmerksamkeit» und «Als Naechstes» erlauben —
-- fuer Mathis und Sebastiano soll die Startseite aber ruhig bleiben:
-- Naechster Einsatz + Mein Monat, sonst nichts.
--
-- Rollen-Schalter roles.dashboard_bereiche_aus (Migration 290). Idempotent:
-- greift nur, solange fuer die Rolle noch nichts ausgeschaltet ist — eine
-- spaetere Aenderung im Rollen-Editor wird nicht ueberschrieben.

update public.roles
set dashboard_bereiche_aus = array['kennzahlen', 'aufmerksamkeit', 'naechste']::text[]
where slug = 'techniker'
  and dashboard_bereiche_aus = '{}'::text[];

-- Neuer Bereich «Als Naechstes» (Key naechste) im Spalten-Kommentar nachtragen.
comment on column public.roles.dashboard_bereiche_aus is
  'Dashboard-Bereiche, die fuer diese Rolle AUS geschaltet sind (Keys aus src/lib/dashboard-bereiche.ts: kennzahlen, aufmerksamkeit, anwesenheit, team, naechste, einsatz, monat). Leer = alles an, was die Rechte der Rolle erlauben. Fuer die Admin-Rolle ignoriert.';
