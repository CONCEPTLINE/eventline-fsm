# Stand Lohn-Umbau Phase 2 (29.10.2026, abends nach Standby)

Branch `lohn`, lokal, **nicht gepusht**. Auf `origin/main` 145eb71 (Sicherheits-Update Abhängigkeiten) rebased,
`npm ci` erledigt, alle Prüfungen danach erneut grün (unten). HEAD siehe `git log -1`.

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

## Zuletzt grün (29.10.2026 abends, NACH Rebase auf 145eb71 und `npm ci`)
- `npx tsc --noEmit`: grün · `npm test`: 34 Dateien, 407 Tests grün
- ESLint über alle 91 geänderten Dateien gegen origin/main: keine neuen Befunde (behoben: `wartung-card.tsx`,
  react-hooks/set-state-in-effect → Laden per queueMicrotask wie im Repo üblich)
- voller `aufbauen.sh` → `pruefen-phase1.mjs` 208 OK → `pruefen-wartung.mjs` 100 OK
- `aufbauen.sh --nur-seed` → `pruefen-phase2.mjs` 53 OK
- `abgleich.mjs` (Live nur gelesen): 0 unerwartete Unterschiede; 248 Objekte aus 363/364 als «noch nicht live»
  erwartet, 19 Objekte `lena_protokoll` (Migration 359, Branch lena-telefon) als «andere Session» eingeordnet
- `live-gang-phase2/pruefen-live.mjs vorher` (Live, nur lesend): Daten sauber; einziger Befund: Wartungsmodus noch nicht live
- Dev-Server läuft auf http://127.0.0.1:3100 (Next 16.4.3)

## Nächster Schritt
1. Schlussbericht an die Hauptsession; Freigabe für den Live-Gang (erst Wartungsmodus 363, dann Phase 2 nach `LIVE-GANG.md`,
   spätestens 30.11.2026, nie 5.–7. eines Monats).
2. Beim Zusammenführen: Migrationsnummern 363/364 erneut gegen alle Branches prüfen; `abgleich.mjs` nach dem Live-Gang
   die Liste «noch nicht live» leeren.

## Bekannte offene Punkte (fachlich)
- 2'500-Rückerstattung 2026 nicht automatisch (Entscheid: mit dem November-Lohn als Korrektur).
- Quellensteuer der Vormonate (Dario) nicht in der Nachrechnung — eigene Abklärung `arbeit\quellensteuer\`.
- Altbestand-Auszahlungsdaten geschätzt (Regel 5. Arbeitstag), echte Daten optional per `--auszahlungen <csv>`.
- `get_monthly_payroll_stats()` ungenutzt → später entfernen.
