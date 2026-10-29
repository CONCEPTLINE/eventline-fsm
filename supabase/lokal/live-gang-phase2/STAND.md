# Stand Lohn-Umbau Phase 2 (29.10.2026, spät)

Branch `lohn`, lokal, **nicht gepusht**. Rebase auf `origin/main` 145eb71 (Sicherheits-Update Abhängigkeiten) ist
**erledigt** (konfliktfrei, HEAD siehe `git log -1`).

## Fertig (alles committet)
- Rechenkern `src/lib/lohn/kern/` (rein, tageweise Lohn, Sonntag Sa 23–So 23, Nacht je Abend, 1. August 0,39 %,
  Ferienzuschlag nach Alter, NBU 7/87, Firmensätze nach Auszahlungsdatum, 5-Rappen-Rundung, keine Ersatzsätze).
- Alle Rechenwege über den Kern: Monatstabelle, Lohnabrechnung/PDF (aus Momentaufnahme), Excel (ganze Monate),
  Lohn-Details, «Mein Monat», BVG-Ampel; Projektkosten ohne Ersatzsätze. Alte NBU-/Ferien-/Prognose-Module entfernt.
- Migration 364 (Momentaufnahmen, Anstellungen, Protokoll, Sperre + Anträge, Korrektur-Vorschläge, Auszahlungstag).
- Korrekturfassung (Begründung, Differenz an eigenem Tag), Korrektur-Vorschläge, Jahresliste (JSON + Excel).
- Altbestand-Werkzeug `scripts/lohn-altbestand.mjs` (28 echte PDFs offline geprüft: 28/28 ohne Befund).
- Bedienung (Begründungs-Modal, Anstellung, Vorschläge, Jahresliste, Lohndaten-Anträge auf /rechte-antraege).
- Live-Gang-Paket in diesem Ordner (LIVE-GANG.md, pruefen-live.mjs, sicherung.mjs, 364_rueckweg.sql).
- Nachrechnung Live März–Oktober (nur lesend): 28 Monate verglichen, 18 abweichend, Summe Netto +CHF 81.42
  (Ergebnis in `_lohn-korrektur\arbeit\phase2\`).
- Backoffice: `_backoffice-uebergabe\09_Rechenkern.md` + Eintrag in `06_Aenderungen.md`.

## Zuletzt grün (VOR dem Rebase auf 145eb71)
- `npx tsc --noEmit`: grün · `npm test`: 34 Dateien, 407 Tests grün
- `pruefen-phase1.mjs`: 208 OK (nach vollem `aufbauen.sh`) · `pruefen-wartung.mjs`: 100 OK
- `pruefen-phase2.mjs`: 53 OK — Lauf VOR den letzten Kern-Änderungen (eigene Sätze nach Arbeitsmonat, nur
  gebrauchte Sätze prüfen) → erneut laufen lassen
- `pruefen-live.mjs vorher` (Live, nur lesend): Daten sauber; einziger Befund: Wartungsmodus (363) noch nicht live
- ESLint-Vergleich gegen origin/main: lief noch, bisher keine neuen Befunde gemeldet → erneut laufen lassen

## Offen / nächster Schritt
1. `npm ci` (Abhängigkeiten von 145eb71), Dev-Server neu starten: `npm run dev -- -p 3100 -H 127.0.0.1`
2. `npx tsc --noEmit -p .`, `npm test`, ESLint auf geänderte Dateien (keine neuen Befunde gegenüber origin/main)
3. `bash supabase/lokal/aufbauen.sh` → `node supabase/lokal/pruefen-phase1.mjs` → `node supabase/lokal/pruefen-wartung.mjs`
   → `bash supabase/lokal/aufbauen.sh --nur-seed` → `node supabase/lokal/pruefen-phase2.mjs`
   (Altbestand-PDFs liegen in `supabase/lokal/ausgabe/altbestand/`, nicht eingecheckt)
4. Schlussbericht an die Hauptsession (Commit-SHA nach dem Rebase nennen).
5. Live-Gang nach `LIVE-GANG.md` (erst nach Wartungsmodus-Live-Gang), spätestens 30.11.2026.

## Bekannte offene Punkte (fachlich)
- 2'500-Rückerstattung 2026 nicht automatisch (Entscheid: mit dem November-Lohn als Korrektur).
- Quellensteuer der Vormonate (Dario) nicht in der Nachrechnung — eigene Abklärung `arbeit\quellensteuer\`.
- Altbestand-Auszahlungsdaten geschätzt (Regel 5. Arbeitstag), echte Daten optional per `--auszahlungen <csv>`.
- `get_monthly_payroll_stats()` ungenutzt → später entfernen.
