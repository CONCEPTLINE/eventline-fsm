# Live-Gang Lohn-Umbau Phase 4 «Stempel und Monatsabschluss»

Stand 30.10.2026. **Tag 1 und Tag 2 ausgeführt am 30.10.2026** (368 um 21:50, `nach-368` ALLES OK, Sicherung vorher). Ausführen: Mischa (bzw. die Hauptsession),
abends, **spätestens 30.11.2026** (vor dem November-Lauf am 5.12.) — nie zwischen dem 5. und 7. eines Monats.
Zwei Schritte an zwei Tagen: **Tag 1** Migration 367 + Code, **Tag 2** (frühestens nach einer Nacht) Migration 368.
Grund: 368 lässt überlappende Stempel und Stempel > 16 h ohne Begründung nicht mehr zu — erst wenn der Code mit den
Klartext-Meldungen auf allen Handys geladen ist (und ihre Offline-Warteschlangen geleert sind), darf die Regel greifen.

Lokal geprüft (30.10.): `pruefen-phase4.mjs` 170, `pruefen-phase1.mjs` 209, `pruefen-wartung.mjs` 106, `pruefen-phase2.mjs` 54
(alle ALLES OK, je auf frischen Testdaten), `npm test` 462, `tsc`, ESLint, `abgleich.mjs` (0 unerwartete Unterschiede),
Rückwege 368 → 367 → erneut einspielen → `pruefen-live.mjs nach-368 --lokal` ALLES OK.
Live am 30.10. nur lesend geprüft: `pruefen-live.mjs vorher` ALLES OK (2 Überlappungs-Paare, s. u.).

## Voraussetzungen
- Phase 2 + Wartungsmodus live (seit 29.10., Migrationen 363/364).
- Entscheid Mischa 30.10. (A2): Das ERP rechnet bis und mit **Lohnmonat November 2026** (`lauf_bis`), ab Dezember
  rechnet Trust flow/Bexio. Stunden, Stempel und Prognosen laufen im ERP weiter.

## Was sich auf Live ändert
| Teil | Inhalt |
|---|---|
| `367_lohn_phase4_monatsabschluss.sql` (Tag 1) | `lohn_einstellungen.lauf_bis` = 2026-11-01 (danach keine Lohnabrechnung, Korrektur oder Zusatzposten — DB-Sperre); `time_entries`: `lang_begruendung`, `geprueft_*` (nur Server), `ueberlappung_altfall` (nur DB) + Feldschutz; Sperre auch für den Server (Stempel abgerechneter Monate nur per Antrag, Bereich «stempel»), Protokoll bei Antrag/Notweg; `lohn_zusatzposten` (+ Sperre/Protokoll); `lohn_momentaufnahmen.auszahlungsbetrag`; `lohn_auszahlungen` («ausbezahlt» von Hand); `lohn_lauf.blockiert` + Alarm-Spalten, Status «blockiert»; `lohn_zustellung_wahl` (übernimmt die 6 bestehenden Einwilligungen), `lohn_dokument_zustellung` (+ Verlauf je Fassung); `stempel_ueberlappung()`. Ändert sonst keine bestehende Zeile. Idempotent. |
| Code (Tag 1) | Klartext statt Datenbankfehler beim Stempeln (Handy/Desktop/Tickets/Projekt-Tabs/Rapport); Ausstempeln nach > 16 h mit Endzeit + Begründung; Stempel-Antrag nach der Sperre; «geprüft»; Lauf blockiert bei offenen/langen Stempeln + Alarm-Mail an die Lohnverwaltung; Erinnerung vor der Sperre (neuer Cron `/api/cron/stempel-monatsende`, 1.–4. 07:00); Statusspalte in Lohn › Monatsstunden; «ausbezahlt»; Zusatzposten im Kern (`KERN_VERSION` 2026.11-2); Lohnabrechnung in Klartext ohne interne Angaben; Lohnausweis 2026 (ESTV-Formular 11) + AK-40-Export; Zustellung (Meldung ohne Beträge, Wahl digital/Papier, geöffnet); Zähler «Anträge» inkl. Rechte/Lohndaten. |
| `368_stempel_regeln.sql` (Tag 2) | `btree_gist`; Regel «keine überlappenden Stempel derselben Person» (Altfälle markiert und ausgenommen); Begründungspflicht > 16 h. |

## Befehlsfolge Tag 1 (Wartung «lohn»)
| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 0 | `git fetch --all`; höchste Migrationsnummer auf allen Branches (Befehl wie Phase 2, Schritt 0). Stand 30.10.: 365/366 auf `origin/vertrieb-kampagnen` (auf Live schon eingespielt), 367/368 frei | keine fremde 367/368 — sonst umnummerieren (Dateien, Verweise hier, `pruefen-live.mjs`, Rückwege, `abgleich.mjs`) | — |
| 1 | `node supabase/lokal/live-gang-phase4/pruefen-live.mjs vorher` | `ALLES OK`; 2 Überlappungs-Paare (03.05.2026 30 min, 12.06.2026 1 min, beide ausgetreten) | — |
| 2 | `node scripts/wartung.mjs an lohn --grund "Lohn-Umbau Phase 4"` (PowerShell), Ausnahme Mischa | Status «lohn in Wartung», Cron pausiert | `node scripts/wartung.mjs aus lohn` |
| 3 | `node supabase/lokal/live-gang-phase4/sicherung.mjs` | «Sicherung abgelegt: …\sicherung\<datum>-phase4», Zeilenzahlen plausibel | — |
| 4 | Migration 367 über die Management API (wie Phase 2, Schritt 4; im Worktree zeigt `apply-migration.mjs` auf lokal) | keine Fehlermeldung | `367_rueckweg.sql` |
| 5 | `node supabase/lokal/live-gang-phase4/pruefen-live.mjs nach-367` | `ALLES OK` (lauf_bis 2026-11, Dezember gesperrt, Stempel-Sperre nur nach dem 5., Einwilligungen übernommen) | wie 4 |
| 6 | Push/Deploy nach CLAUDE.md B1: `lohn` auf `origin/main` rebasen, `npx tsc --noEmit`, `npm test`, `git push origin main`; `/api/version` = gepushter SHA | Vercel baut (sonst Deploy per API, Memory «eventline Push → Vercel baut nicht»); Vercel-Cron `stempel-monatsende` erscheint | Vercel «Promote» auf den vorherigen Deploy (der Phase-2-Code läuft auch mit 367) |
| 7 | Stichprobe als Ausnahme (Admin, vertrautes Gerät): Lohn › Monatsstunden (Statusspalte; September «ausbezahlt (übernommen)»/Korrektur, Oktober «fehlt» bzw. ab 5.11. Status, Dezember «über Trust flow»), Lohndokumente › «Protokoll» und Zustellung, Mitarbeiter-Lohn › Karte «Einmalige Lohnposten», Jahresliste (Knöpfe Lohnausweis/AK 40/CSV-Vorlage), Stempelzeiten (lange Stempel markiert). Als Mitarbeiter am Handy: einstempeln, ausstempeln; Lohn «Meine» → Wahl digital/Papier | alles lädt ohne Fehler-Toast | wie 6 |
| 8 | Cron-Proben: `curl -s -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/auto-lohnabrechnung?probe=1"` und `.../api/cron/stempel-monatsende` | `"status":"pausiert"` bzw. «Wartung — nichts versendet» | — |
| 9 | `node scripts/wartung.mjs aus lohn` | Status «aus» | — |

## Befehlsfolge Tag 2 (frühestens nach einer Nacht, abends; keine Wartung nötig)
| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 10 | `node supabase/lokal/live-gang-phase4/pruefen-live.mjs vorher-368` | `ALLES OK`; weiterhin genau die 2 bekannten Paare (jede neue Überlappung zuerst ansehen — 368 markiert sonst auch sie als Altfall) | — |
| 11 | Migration 368 über die Management API (sperrt `time_entries` für ein paar Sekunden) | NOTICE «Überlappung: 4 Stempel als Altfall markiert» | `368_rueckweg.sql` |
| 12 | `node supabase/lokal/live-gang-phase4/pruefen-live.mjs nach-368` | `ALLES OK` (Regel aktiv, 16 h, keine Überlappung ausser Altfällen) | wie 11 |
| 13 | Stichprobe am Handy (eigenes Konto): ein- und ausstempeln; Stempelzeiten öffnen | normal, keine Meldung | wie 11 |

## Rückweg im Detail
- **Nur 368 stört** (z. B. Stempeln am Handy klemmt): `368_rueckweg.sql` — Regel und Begründungspflicht weg, Markierungen bleiben.
  Erneut einspielen stellt sie her (vorher `vorher-368` ansehen).
- **367 stört**: zuerst `368_rueckweg.sql` (falls eingespielt), dann `367_rueckweg.sql` — neue Trigger auf `time_entries`
  und Zusatzposten weg, Funktionen aus 364/360 wiederhergestellt; Tabellen, Spalten, Daten und `lauf_bis` bleiben.
- **Code zurück**: Vercel «Promote» auf den vorherigen Deploy. Der Phase-2-Code läuft mit 367 (Speicher-Funktion hat dieselbe
  Signatur; neue Spalten haben Standardwerte); 368 vorher zurücknehmen (der alte Code zeigt sonst Datenbankfehler).
- Lokal getestet: 368_rueckweg → 367_rueckweg → 367 → 368 → `pruefen-live.mjs nach-368 --lokal` ALLES OK.

## Danach (vor dem November-Lauf am 5.12.)
1. **Zusatzposten** erfassen (Lohn › Mitarbeiter-Lohn › «Einmalige Lohnposten», Lohnmonat November 2026):
   «Quellensteuer vom Arbeitgeber bezahlt» (Art Lohn, AHV-pflichtig, steuerbar; Betrag nach Eingang der Belege) —
   Entscheid 29.10. Rückerstattungen (z. B. AHV/ALV unter CHF 2'500, falls entschieden) als Art «Rückerstattung» mit Abzug.
2. **Korrektur 2026** wie in Phase 2 beschrieben (Korrektur-Vorschläge, Auszahlung mit dem November-Lohn).
3. Nach der Auszahlung je Fassung **«ausbezahlt»** setzen (Monatsstunden › Status). Altbestand gilt als ausbezahlt.
4. **Lohnausweis 2026** (nach der Dezember-Auszahlung des November-Lohns, Januar 2027): Jahresliste 2026 (Auszahlungsjahr)
   → «CSV-Vorlage» laden, AHV-Nr./Adressen ausfüllen (nur lokal, nie hochladen ausser beim Erzeugen; wird nicht gespeichert)
   → «Lohnausweise (PDF)». **AK 40**: «AK 40 (CSV)» (AHV-Lohn, beitragsfrei, ALV-Lohn, Zeitraum) bis 30.1.2027.
5. Ab Lohnmonat Dezember 2026: Lohn über Trust flow/Bexio; das ERP liefert Stunden (Stempel) und zeigt «über Trust flow».

## Beim Zusammenführen mit `main` beachten (Dateien anderer Sessions)
Stempel-Teile, die auch die Mobile-Session anfasst: `src/components/mobile/{stempel-sheet,stempelzeiten-mobil,heute-screen,auftrag-feld}.tsx`,
`src/components/stempel/{sidebar-stempel,job-stempel-button}.tsx`, `src/lib/use-stempel.tsx`, `src/lib/offline/{db,stempel-outbox}.ts`
(je nur `if (res.abgebrochen) return;` bzw. Klartext-Meldungen). Weiter: `src/components/tickets/new-ticket-modal.tsx`,
`src/app/(app)/tickets/[id]/page.tsx`, `src/components/projekt/tabs/{overview,zeit}-tab.tsx`, `src/lib/notification-*.ts`,
`src/lib/use-nav-counts.tsx`, `src/types/index.ts`, `vercel.json` (neuer Cron). Nicht berührt: `src/app/api/ki/**`, `src/lib/ki/**`,
`src/app/(app)/vertrieb/**`. `supabase/lokal/abgleich.mjs` nach dem Live-Gang: `NOCH_NICHT_LIVE` leeren.
