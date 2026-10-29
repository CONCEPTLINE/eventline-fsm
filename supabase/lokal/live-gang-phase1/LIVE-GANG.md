# Live-Gang Lohn-Umbau Phase 1 «Gefahren und Sicherheit»

Stand 29.10.2026, Branch `lohn`. **Nicht ausgeführt** — Vorbereitung für Mischa (Freigabe nötig).
Getestet nur in der lokalen Testumgebung (`node supabase/lokal/pruefen-phase1.mjs`: 176 Prüfungen OK).

## Was sich auf Live ändert

| # | Änderung | Art | Sicherung | Rückweg |
|---|---|---|---|---|
| 1 | Migration **357** `357_lohn_phase1_schutz.sql`: neue Tabellen `lohn_dokument_protokoll`, `lohn_lauf`, `lohn_einstellungen` (Vertretung, `lauf_ab` = 2026-10-01), `lohn_dossiers` (+ Nachtrag bestehender Dossiers, 10 Jahre); neue Spalten auf `wage_documents` (Fassung, Papierkorb) und `trusted_devices` (Freigabe); RPCs nur für den Server; Schutz-Trigger (Löschen/Überschreiben); `permission_audit_log`: neue Aktionen; `get_monthly_payroll_stats` auch für den Server; anon ohne Lohnrechte; **Browser ohne Rechte auf `trusted_devices`** | additiv + Rechte verengen | `sicherung.mjs` | `357_rueckweg.sql` (nur falls 357 selbst stört) |
| 2 | **Code-Deploy** (Branch `lohn` → `main`) | Code | Vercel-Rollback | Vercel «Promote» auf vorherigen Deploy + `358_rueckweg.sql` falls 358 schon drin |
| 3 | Migration **358** `358_lohn_rechte_browser_entziehen.sql`: Browser (authenticated) verliert alle Rechte auf `employee_compensation`, `payroll_defaults`, `wage_documents` und das Ausführen von `get_monthly_payroll_stats`, `get_current_bvg_threshold`, `get_location_stats`; `_test_payroll()` wird gelöscht | Rechte entziehen | `sicherung.mjs` (Policies, Rechte, Funktionsdefinition `_test_payroll`) | `358_rueckweg.sql` |
| 4 | Einstellung **Vertretung** setzen (App: Sicherheit › Geräte) | Daten | — | in der App wieder leeren |
| 5 | Später, NICHT in Phase 1: `spaeter/NNN_wage_documents_fassungen_einmaligkeit.sql` (Einmaligkeits-Regel → «eine gültige Fassung je Periode») | Constraint | `sicherung.mjs` | im Kopf der Datei |

Unverändert bleibt: Inhalt und Rechnung der Lohnabrechnung (Phase 2), alle bestehenden PDFs, bestehende Gerätefreigaben.

## Reihenfolge (erst Leser, dann Rechte)

1. **Freigabe** Mischa/Leo einholen. Zeitpunkt nicht zwischen dem 5. und 7. eines Monats (Lauf).
2. **Sicherung** (nur lesend):
   `node supabase/lokal/live-gang-phase1/sicherung.mjs`
   → `C:\Users\misch\projects\_lohn-korrektur\sicherung\<datum>-phase1\` (CSV + SQL). Zeilenzahlen notieren.
3. **Migrationsnummern prüfen**: `git fetch --all`, höchste Nummer auf `main` + allen Branches; 357/358 ggf. umbenennen
   (Inhalt unverändert, Verweise in diesem Ordner und in `TESTUMGEBUNG.md` nachziehen).
4. **Migration 357 einspielen** (vor dem Code — der neue Code ruft die RPCs):
   `node scripts/apply-migration.mjs supabase/migrations/357_lohn_phase1_schutz.sql`
   Prüfen: `select count(*) from pg_trigger where tgname like '%lohn_schutz%'` = 12;
   `select lauf_ab from lohn_einstellungen` = 2026-10-01.
   Zwischen 357 und dem Deploy: der ALTE Code kann eine vorhandene Abrechnung nicht mehr überschreiben (bricht mit Fehler ab)
   und «Alle neu erstellen» schlägt fehl — gewollt. Deploy darum direkt danach.
5. **Code deployen** (Branch `lohn` auf `main` zusammenführen, Rebase auf aktuellen `main`, Konflikte siehe unten).
   `/api/version` abwarten.
6. **Leser prüfen** (Live, als Admin mit vertrautem Gerät): Lohn › Team › Lohndokumente (Lauf-Status, Papierkorb),
   Monatsstunden, Mitarbeiter-Lohn, Kalender-Woche (BVG-Pillen), ein Auftrag mit Terminen, ein Projekt mit Mitgliedern,
   Finanzen. Als Mitarbeiter am Handy: «Meine Lohndokumente», Dashboard «Mein Monat».
7. **Probelauf des Crons** (schreibt nichts):
   `curl -H "Authorization: Bearer <CRON_SECRET>" "https://eventline-fsm-usyk.vercel.app/api/cron/auto-lohnabrechnung?probe=1"`
   → `plan` muss leer sein (vor dem 5.11.) bzw. nur Oktober 2026 enthalten (ab dem 5.11.). Frühere Monate nie
   (`lauf_ab` = 2026-10-01; März–September gehören zur Korrektur, Phase K).
8. **Migration 358 einspielen**:
   `node scripts/apply-migration.mjs supabase/migrations/358_lohn_rechte_browser_entziehen.sql`
   Prüfen: `select count(*) from pg_policies where tablename in ('employee_compensation','payroll_defaults','wage_documents')` = 0;
   `select has_table_privilege('authenticated','public.employee_compensation','SELECT')` = false;
   `select to_regprocedure('public._test_payroll()')` = null. Dann Schritt 6 wiederholen.
9. **Vertretung** in der App setzen (Sicherheit › Geräte), sobald Leo/Mischa sie bestimmt haben.
10. **Abgleich nachführen**: `supabase/lokal/abgleich.mjs` — Einträge `public._test_payroll()` aus der Liste
    «bekannt, nur Live» entfernen; `node supabase/lokal/abgleich.mjs` muss 0 unerwartete Unterschiede zeigen.
11. Am **7.11.** den Oktober-Lauf kontrollieren (Lohn › Lohndokumente: Status-Zeile, Details).

## Rückweg

- Code zurück: Vercel → vorheriger Deploy «Promote to Production». Ist 358 schon eingespielt: **zuerst**
  `358_rueckweg.sql` (sonst sehen alte Kalender/Projekte/Lohn-Seiten keine Lohnwerte). 357 kann bleiben.
- 357 selbst macht Probleme: `358_rueckweg.sql`, dann `357_rueckweg.sql` (entfernt Trigger/RPCs, behält Tabellen,
  Spalten und Protokolle). Lokal getestet: Rückweg und erneutes Vorwärts laufen sauber.
- Daten werden in Phase 1 nicht umgeschrieben (ausser `trusted_devices.freigabe_art = 'mail_link'` für bestehende
  Freigaben und dem Nachtrag in `lohn_dossiers`) — die Sicherung dient dem Nachweis, nicht einem Daten-Rückspiel.

## Für die Finanzen-Session (gemeinsame Gerätesperre)

- `requireTrustedDevice` / `requireAdminTrustedDevice` verhalten sich gleich (neu intern über `pruefeVertrautesGeraet`,
  zusätzlich exportiert für Server-Komponenten).
- **Kein Schnellweg mehr**: gleicher Browser-Typ gibt keinen Zugang. Jedes neue Gerät braucht eine Freigabe.
- **Freigabe per Knopf** durch den anderen Admin oder die Vertretung, angemeldet, auf eigenem vertrautem Gerät,
  innerhalb von 24 h (`/api/trust/freigabe`, Seite `/geraet-freigabe?id=…`, Glocke + Mail an admin@). Der Mail-Link
  gibt nicht mehr beim Öffnen frei (`/api/trust/confirm` leitet nur noch auf die Seite).
- Notweg: `node scripts/geraet-notfreigabe.mjs` (Mischa, mit Grund, im Rechte-Protokoll).
- Der Browser hat **keine Rechte mehr auf `trusted_devices`** (Migration 357). Das Sicherheits-Dashboard liest die
  Geräte jetzt über `/api/trust/devices?all=true`.
- `TrustedDeviceGate` hat neue Texte und zeigt «abgelaufen» (Props unverändert). Finanzen lokal mitgetestet
  (mit Gerät 200, ohne Gerät 403).
- Bestehende Freigaben bleiben gültig.

## Cron-Routen (zeitsicherer Vergleich)

Neu: `src/lib/geheimnis.ts` (`istCronAufruf`, `geheimnisGleich`, crypto.timingSafeEqual). Eingesetzt nur in
`/api/cron/auto-lohnabrechnung`. Noch mit `!==` (andere Sessions, bitte nachziehen):
`auftrag-overdue`, `bexio-offerten`, `db-retention`, `finanzen-sync`, `job-drafts-archive`, `notification-cleanup`,
`notification-wake-snoozed`, `reminders`, `security-audit`, `stempel-reminder`, `zugriffe-digest`,
`/api/customers/auto-archive`.

## Zusammenführen mit `main` — Dateien anderer Sessions

Berührt (nur das Nötige, bitte beim Rebase beachten): `src/app/(app)/kalender/page.tsx`,
`src/components/kalender/week-view.tsx`, `src/components/kalender/types.ts` (Kalender/Handy-Session),
`src/components/auftrag/appointments-section.tsx`, `src/app/(app)/projekte/[id]/page.tsx`,
`src/components/sicherheit/sicherheit-dashboard.tsx`, `src/components/trust/trusted-device-gate.tsx`,
`src/lib/api-auth.ts` (Finanzen), `src/app/api/dashboard/route.ts`, `src/components/einstellungen/*`.
Nicht berührt: `src/app/api/ki/**`, `src/lib/ki/**`, `src/app/(app)/vertrieb/**`.
