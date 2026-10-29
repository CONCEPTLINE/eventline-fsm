# Live-Gang Lohn-Umbau Phase 2 «Ein Rechenkern und Momentaufnahmen»

Stand 29.10.2026, Branch `lohn`. **Vorbereitet, nicht ausgeführt.** Ausführen: Mischa (bzw. die Hauptsession),
abends, **spätestens 30.11.2026** — nie zwischen dem 5. und 7. eines Monats (Lohnlauf). Danach laufen der
November-Lohn (Auszahlung bis 4.12.) und die Korrektur 2026 auf dem Kern.
Lokal geprüft: `pruefen-phase2.mjs` (53 Prüfungen), `pruefen-phase1.mjs` (208), `pruefen-wartung.mjs` (100),
`npm test`, `tsc`, ESLint, Rückweg 364 + erneutes Einspielen.

## Voraussetzungen
- Phase 1 live (seit 29.10., Migrationen 360–362).
- **Wartungsmodus live** (Migration 363 + Code, `supabase/lokal/live-gang-wartung.md`) — sonst zuerst diesen Live-Gang.
- `node supabase/lokal/live-gang-phase2/pruefen-live.mjs vorher` am 29.10. gelesen: Daten sauber (Firmensätze
  vollständig, keine Lohnzeile mit leeren eigenen Sätzen ausser «kein Lohn», keine Überlappungen, alle mit Lohn
  haben ein Geburtsdatum, keine Stempel 2026 ohne Lohnzeile, 28 Alt-PDFs). Einziger Befund: Wartung noch nicht live.

## Was sich auf Live ändert
| Teil | Inhalt |
|---|---|
| `364_lohn_phase2_kern.sql` | Tabellen `lohn_anstellungen`, `lohn_momentaufnahmen` (+ Sicht `lohn_fassungen_gueltig`), `lohn_aenderungen` (Protokoll alt/neu/wer), `lohn_aenderungs_antraege`, `lohn_korrektur_vorschlaege`; Spalte `lohn_einstellungen.auszahlung_arbeitstag` (5); Sperr- und Protokoll-Trigger auf Lohnzeilen, Firmensätzen, Anstellungen; RPCs `lohn_momentaufnahme_speichern`, `lohn_aenderung_direkt`, `lohn_aenderung_ausfuehren` (nur Server). Additiv, idempotent. |
| Code | Rechenkern `src/lib/lohn/kern/` für alle Rechenwege; PDF aus der Momentaufnahme; Korrekturfassung; Anstellungen; Anträge nach der Sperre; Korrektur-Vorschläge; Jahresliste; Ersatzsätze gestrichen |
| Altbestand | `scripts/lohn-altbestand.mjs` übernimmt die bestehenden PDFs (28 bzw. nach dem 5.11. inkl. Oktober) als Fassung «Altbestand» |

Bestehende Zeilen und PDFs werden nicht geändert. **Wichtig:** Solange eine alte Lohnabrechnung keine Momentaufnahme
hat, verweigert der neue Code für diesen Monat jede weitere Fassung (sonst doppelte Auszahlung) — darum Altbestand
direkt nach dem Deploy übernehmen.

## Befehlsfolge
| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 0 | `git fetch --all`; höchste Migrationsnummer auf allen Branches: `for b in $(git branch -r \| grep -v HEAD); do git ls-tree --name-only $b supabase/migrations/ \| grep -E '^supabase/migrations/3[6-9][0-9]'; done \| sort -u` | keine fremde 364 — sonst umnummerieren (Datei, Verweise hier und in `pruefen-live.mjs`/`364_rueckweg.sql`) | — |
| 1 | `node supabase/lokal/live-gang-phase2/pruefen-live.mjs vorher` | `ALLES OK` | — |
| 2 | `node scripts/wartung.mjs an lohn --grund "Lohn-Umbau Phase 2"` (PowerShell wegen Umlauten), Ausnahme Mischa gesetzt (`… ausnahmen <mail>`) | Status «lohn in Wartung»; Cron pausiert | `node scripts/wartung.mjs aus lohn` |
| 3 | `node supabase/lokal/live-gang-phase2/sicherung.mjs` | «Sicherung abgelegt: …\sicherung\<datum>-phase2», Zeilenzahlen plausibel | — |
| 4 | `node scripts/apply-migration.mjs supabase/migrations/364_lohn_phase2_kern.sql` (Haupt-Checkout bzw. Management API) | keine Fehlermeldung | `364_rueckweg.sql` |
| 5 | `node supabase/lokal/live-gang-phase2/pruefen-live.mjs nach-364` | `ALLES OK` (6 Trigger, 4 RPCs, Auszahlung 5. Arbeitstag, Sperre greift) | wie 4 |
| 6 | Push/Deploy nach CLAUDE.md B1: `lohn` auf `origin/main` rebasen, `npx tsc --noEmit`, `npm test`, `git push origin main`; `/api/version` = gepushter SHA | Vercel baut (sonst Deploy per API, Memory «eventline Push → Vercel baut nicht») | Vercel «Promote» auf den vorherigen Deploy, dann `364_rueckweg.sql` |
| 7 | Altbestand Trockenlauf (PowerShell, Service-Schlüssel aus Vercel-Env, nie ausgeben): `$env:SUPABASE_URL="https://uxtotpniwbwyoznwkygd.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="…"; node scripts/lohn-altbestand.mjs --live` | «Übernehmbar: 28 (bzw. 28 + Oktober), Befunde: 0» | — (liest nur) |
| 8 | Übernahme: `node scripts/lohn-altbestand.mjs --live --schreiben` (optional `--auszahlungen <csv>` mit `profile_id,jahr,monat,datum` aus den Bankauszügen; ohne = Regel-Datum, als «geschätzt» markiert) | «Übernommen: n, Befunde: 0»; zweiter Lauf «Übernommen: 0» | Momentaufnahmen bleiben (nie löschen); Code-Rückweg wie 6 |
| 9 | `node supabase/lokal/live-gang-phase2/pruefen-live.mjs nach-altbestand` | `ALLES OK` (jede gültige Lohnabrechnung hat eine Momentaufnahme) | — |
| 10 | Stichprobe als Ausnahme (Admin, vertrautes Gerät): Lohn › Team › Monatsstunden (Oktober), eine Person öffnen (Bezugsmonat Brutto/Netto), Lohndokumente (Korrektur-Vorschläge leer, Jahresliste-Vorschau), Mitarbeiter-Lohn (Karte «Anstellung»), `/rechte-antraege` (Abschnitt Lohndaten); als Mitarbeiter «Mein Monat» | alles lädt ohne Fehler-Toast; keine Zeile mit «Fehler» | wie 6 |
| 11 | Cron-Probe: `curl -s -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/auto-lohnabrechnung?probe=1"` | `"status":"pausiert"` (Wartung) bzw. nach 12 `"probe"` mit leerem Plan | — |
| 12 | `node scripts/wartung.mjs aus lohn` | Status «aus» | — |

## Danach (gleiche Woche, vor dem November-Lauf am 5.12.)
1. **Anstellungen erfassen** (Lohn › Mitarbeiter-Lohn › Karte «Anstellung»): Eintritt, Austritt, Vertragsart, AHV-Wahl
   unter 2'500 je Jahr. Eintritt in abgerechneten Monaten = Antrag mit Begründung → der andere Admin bestätigt unter
   `/rechte-antraege` (24 h). Ohne Anstellung rechnet der Kern den ganzen Monat (Hinweis «Anstellung nicht erfasst»).
2. **Korrektur 2026** (Lohn › Lohndokumente › Korrektur-Vorschläge): «Jahr nachrechnen» 2026 → je abweichendem Monat ein
   Vorschlag. Je Vorschlag «Korrekturfassung erstellen» mit Begründung (z. B. «Korrektur 2026: NBU nach 7/87,
   1. August 0,39 %, Sonntag Sa 23–So 23»), Auszahlungsdatum = November-Lohn. Die Korrekturfassung ersetzt den Monat,
   ausbezahlt (bzw. zurückgefordert) wird die Differenz. Erwartung aus der Nachrechnung März–Oktober (29.10.):
   18 von 28 Monaten abweichend, Summe Netto **+CHF 81.42** zugunsten der Mitarbeitenden (Details
   `_lohn-korrektur\arbeit\phase2\erklaerung.md`). Quellensteuer der Vormonate (Dario) ist darin NICHT enthalten —
   eigene Abklärung (`arbeit\quellensteuer\`).
3. **2'500-Grenze 2026**: Jahresliste 2026 (Basis Auszahlungsjahr) zeigt je Person den beitragsfreien AHV-Lohn. Die
   Rückerstattung abgezogener AHV/ALV-Beiträge geschieht NICHT automatisch — mit dem November-Lohn (letzte Auszahlung 2026)
   als Korrektur entscheiden (offener Punkt).
4. `supabase/lokal/abgleich.mjs`: Phase-2-Objekte sind dann auf beiden Seiten — 0 unerwartete Unterschiede bei Lohn-Objekten.

## Rückweg im Detail
- **Code zurück:** Vercel «Promote» auf den vorherigen Deploy, **dann** `364_rueckweg.sql` (der Phase-1-Lohn-Editor
  schreibt Lohnzeilen direkt; die Sperre würde ihn in abgerechneten Monaten blockieren). Tabellen und Daten bleiben.
- **Nur 364 stört:** `364_rueckweg.sql` (Trigger und Funktionen weg). Erneutes Einspielen von 364 stellt alles her.
- Lokal getestet: Rückweg → 364 erneut → `pruefen-live.mjs nach-364 --lokal` ALLES OK.

## Notweg (Lohndaten ohne zweite Person)
SQL in derselben Transaktion: `select set_config('lohn.notweg','an', true); select set_config('lohn.grund','<Grund>', true);`
und danach die Änderung — das Protokoll vermerkt Quelle «notweg» und den Grund. Nur Mischa, nur im Notfall.

## Später (nicht in diesem Live-Gang)
- `get_monthly_payroll_stats()` wird vom Code nicht mehr benutzt → in einer späteren Migration entfernen.
- Einmaligkeits-Regel `wage_doc_unique_per_period` ersetzen (`live-gang-phase1/spaeter/`) — der Phase-2-Code funktioniert mit und ohne.
- Ab Lohnmonat Dezember 2026 rechnet Bexio (Backoffice) — der Kern ist dafür in `_backoffice-uebergabe\09_Rechenkern.md` beschrieben.

## Beim Zusammenführen mit `main` beachten (Dateien anderer Sessions)
`src/app/api/dashboard/route.ts` («Mein Monat»), `src/app/(app)/kalender/page.tsx` (nur Kommentar),
`src/components/einstellungen/team-tab.tsx` (Ferienzuschlag-Anzeige, Warnung unter 18), `src/app/api/admin/users/route.ts`
(`alter_warning`), `src/app/api/admin/users/[id]/dossier/route.ts` (Import NBU-Hinweis), `src/app/(app)/rechte-antraege/page.tsx`.
Entfernt: `src/lib/nbu-pflicht.ts`, `src/lib/ferienanteil.ts`, `src/lib/bvg-forecast.ts`, `src/lib/swiss-holidays.ts`
(+ Tests, `payroll-scenarios.test.ts`) — falls andere Sessions sie inzwischen importieren: auf `src/lib/lohn/kern` umstellen.
Nicht berührt: `src/app/api/ki/**`, `src/lib/ki/**`, `src/app/(app)/vertrieb/**`.
