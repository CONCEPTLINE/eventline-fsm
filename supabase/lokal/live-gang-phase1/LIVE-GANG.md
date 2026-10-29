# Live-Gang Lohn-Umbau Phase 1 «Gefahren und Sicherheit»

Stand 29.10.2026 abends, Branch `lohn`. **Vorbereitet, nicht ausgeführt.** Ausführen: Mischa (bzw. die Hauptsession),
abends, sobald freigegeben, **spätestens Dienstag 3.11.2026** — nie zwischen dem 5. und 7. eines Monats (Lohnlauf).
Lokal geprüft: `node supabase/lokal/pruefen-phase1.mjs` (208 Prüfungen OK), `npm test`, `tsc`, ESLint, Rückwege.

Entscheide der Firma 29.10.: Strohmann-Schutz JA (Migration 361). Vertretung: vorerst niemand (Leo und Mischa
decken sich gegenseitig) — `lohn_einstellungen.vertretung_profile_id` bleibt leer.

## Was sich auf Live ändert

| Migration | Inhalt | wann |
|---|---|---|
| `360_lohn_phase1_schutz.sql` | Fassungen + Papierkorb (`wage_documents`), Protokoll, Lohnlauf-Status, Lohn-Einstellungen (`lauf_ab` 2026-10-01, Vertretung leer), Dossier-Register (10 J.), Gerätefreigabe-Spalten, RPCs nur Server, 12 Schutz-Trigger, Browser ohne Rechte auf `trusted_devices`, anon ohne Lohnrechte, `get_monthly_payroll_stats` für den Server | vor dem Code |
| `361_lohn_rechte_vier_augen.sql` | Rechte-Anträge (Admin-Rolle, Lohnrecht, Vertretung nur mit Bestätigung des anderen Admins), 5 Trigger, RPC `rechte_antrag_ausfuehren` | vor dem Code |
| Code (Branch `lohn`) | Leser über den Server, Fassungen, Lauf, Gerätefreigabe per Knopf, Vier Augen, «Ansicht als», Archivieren statt Löschen | Push |
| `362_lohn_rechte_browser_entziehen.sql` | Browser ohne Rechte auf Lohnzeilen, Firmensätze, Lohndokumente, Lohnstatistik; `_test_payroll()` weg | nach dem Code |
| später, NICHT Phase 1 | `spaeter/NNN_wage_documents_fassungen_einmaligkeit.sql` | wenn Phase-1-Code bewährt |

Daten werden nicht umgeschrieben — ausser `trusted_devices.freigabe_art = 'mail_link'` für bestehende Freigaben und dem
Nachtrag bestehender Dossiers in `lohn_dossiers`. Bestehende PDFs und Gerätefreigaben bleiben.

## Befehlsfolge (im Ordner des Worktrees bzw. nach dem Merge im Haupt-Checkout)

| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 0 | `git fetch --all` und höchste Migrationsnummer prüfen: `for b in $(git branch -r \| grep -v HEAD); do git ls-tree --name-only $b supabase/migrations/ \| grep -E '^supabase/migrations/3[6-9][0-9]' ; done \| sort -u` | keine fremde 360/361/362 (Stand 29.10.: höchste fremde 359 auf `lena-telefon`) — sonst umnummerieren (Dateien, Verweise in diesem Ordner, `pruefen-phase1.mjs`) | — |
| 1 | `node supabase/lokal/live-gang-phase1/pruefen-live.mjs vorher` | `ALLES OK` (0 Profile mit `is_active` NULL, ≥ 2 aktive Admins, Phase 1 noch nicht da). Hinweis «Admins ohne Gerät» beachten | — |
| 2 | `node supabase/lokal/live-gang-phase1/sicherung.mjs` | «Sicherung abgelegt: …_lohn-korrektur\sicherung\<datum>-phase1», Zeilenzahlen plausibel | — |
| 3 | `node scripts/apply-migration.mjs supabase/migrations/360_lohn_phase1_schutz.sql` | keine Fehlermeldung | `360_rueckweg.sql` |
| 4 | `node scripts/apply-migration.mjs supabase/migrations/361_lohn_rechte_vier_augen.sql` | keine Fehlermeldung | `361_rueckweg.sql`, dann `360_rueckweg.sql` |
| 5 | `node supabase/lokal/live-gang-phase1/pruefen-live.mjs nach-360-361` | `ALLES OK` (17 Trigger, 5 Tabellen, `lauf_ab` 2026-10-01, Vertretung leer) | wie 4 |
| 6 | Push/Deploy nach CLAUDE.md B1: `lohn` auf aktuelles `origin/main` rebasen, `npx tsc --noEmit`, `npm test`, `git push origin main` (Konflikt `src/lib/build-info.ts` = eine Seite nehmen) | Vercel baut; `curl -s https://eventline-fsm-usyk.vercel.app/api/version` liefert den 7-stelligen SHA des gepushten Commits (60–120 s; sonst Deploy per API, Memory «eventline Push → Vercel baut nicht») | Vercel: vorherigen Deploy «Promote to Production» (360/361 dürfen bleiben) |
| 7 | Leser-Stichprobe Live (Admin auf vertrautem Gerät): Lohn › Team › Lohndokumente (Status-Zeile, Papierkorb), Monatsstunden, Mitarbeiter-Lohn; Kalender-Woche (BVG-Pillen); ein Auftrag mit Terminen; ein Projekt mit Mitgliedern; Finanzen; `/rechte-antraege` öffnet; als Mitarbeiter am Handy «Meine Lohndokumente» und Dashboard «Mein Monat» | alles lädt ohne Fehler-Toast; BVG-Pillen mit Gerät als «x %», ohne Gerät als «BVG» | wie 6 |
| 8 | Cron-Probelauf (schreibt nichts): `curl -s -H "Authorization: Bearer $CRON_SECRET" "https://eventline-fsm-usyk.vercel.app/api/cron/auto-lohnabrechnung?probe=1"` (CRON_SECRET aus Vercel-Env, nie ausgeben) | `"status":"probe"`, `lauf_ab` `2026-10`, `plan` leer (vor 5.11.) bzw. nur Oktober 2026 (ab 5.11.); `hinweise` lesen (z. B. inaktive Personen mit offener Lohnzeile) | — |
| 9 | `node scripts/apply-migration.mjs supabase/migrations/362_lohn_rechte_browser_entziehen.sql` | keine Fehlermeldung | `362_rueckweg.sql` |
| 10 | `node supabase/lokal/live-gang-phase1/pruefen-live.mjs nach-362`, danach Stichprobe 7 wiederholen | `ALLES OK`; Seiten wie in 7 | `362_rueckweg.sql` |
| 11 | `supabase/lokal/abgleich.mjs`: die Einträge `public._test_payroll()` aus der Liste «bekannt, nur Live» entfernen; `node supabase/lokal/abgleich.mjs` | 0 unerwartete Unterschiede bei Lohn-Objekten (Objekte anderer Sessions, z. B. `lena_protokoll` aus `lena-telefon`, gesondert einordnen) | — |
| 12 | Am 7.11. den Oktober-Lauf kontrollieren: Lohn › Lohndokumente → Status-Zeile, «Details» | 1 Abrechnung je aktiver Person für Oktober, 0 Fehler | Fehler betreffen nur einzelne Personen → von Hand erzeugen |

### Rückweg im Detail
- **Code zurück** (Schritt 6–10): Vercel «Promote» auf den vorherigen Deploy. Ist 362 schon drin, **zuerst**
  `node scripts/apply-migration.mjs supabase/lokal/live-gang-phase1/362_rueckweg.sql` (sonst sehen alte Seiten keine
  Lohnwerte). Danach `361_rueckweg.sql` — der alte Code ändert Rollen direkt, was 361 verweigert. 360 kann bleiben
  (alter Code läuft; nur Überschreiben/Löschen von Lohndaten bricht dann mit Fehler ab — gewollt).
- **360 selbst stört**: `362_rueckweg` → `361_rueckweg` → `360_rueckweg`. Tabellen, Spalten und Protokolle bleiben.
- Lokal getestet: alle Rückwege und das erneute Vorwärts-Einspielen laufen sauber.

## Neu für Admins (kurz erklären)
- Neue Geräte: Freigabe per Knopf durch den anderen Admin (Glocke/Mail → `/geraet-freigabe`), 24 h, selbst auf vertrautem Gerät.
- Admin-Rolle, Lohnrecht und Vertretung: Antrag → der andere Admin bestätigt unter `/rechte-antraege` (24 h, vertrautes Gerät).
- Notwege (nur Mischa, mit Grund, protokolliert): `node scripts/geraet-notfreigabe.mjs`, `node scripts/rechte-notfreigabe.mjs`.
- Lohndokumente: kein «Alle neu erstellen» mehr; nur gesperrte Monate; neue Fassung statt Überschreiben; Papierkorb statt Löschen.

## Für die Finanzen-Session (gemeinsame Gerätesperre)
- `requireTrustedDevice` / `requireAdminTrustedDevice` unverändert im Verhalten; neu exportiert `pruefeVertrautesGeraet()`.
  `requireAdmin` verlangt jetzt zusätzlich `is_active = true`.
- Kein Schnellweg mehr (gleicher Browser-Typ gab sofort Zugang). Freigabe nur per Knopf (s. o.); der Mail-Link gibt nicht mehr frei.
- Browser ohne Rechte auf `trusted_devices` (360). Sicherheits-Dashboard liest Geräte über `/api/trust/devices?all=true`.
- `TrustedDeviceGate`: neue Texte, Zustand «abgelaufen» (Props unverändert). Finanzen lokal mitgetestet (mit Gerät 200, ohne 403).
- Bestehende Freigaben bleiben gültig.

## Cron-Routen (zeitsicherer Vergleich)
`src/lib/geheimnis.ts` (`istCronAufruf`, crypto.timingSafeEqual) ist nur in `/api/cron/auto-lohnabrechnung` eingesetzt.
Noch mit `!==` (andere Sessions, bitte nachziehen): `auftrag-overdue`, `bexio-offerten`, `db-retention`, `finanzen-sync`,
`job-drafts-archive`, `notification-cleanup`, `notification-wake-snoozed`, `reminders`, `security-audit`,
`stempel-reminder`, `zugriffe-digest`, `/api/customers/auto-archive`.

## Beim Zusammenführen mit `main` beachten (Dateien anderer Sessions)
`src/app/(app)/kalender/page.tsx`, `src/components/kalender/week-view.tsx`, `src/components/kalender/types.ts`,
`src/components/auftrag/appointments-section.tsx`, `src/app/(app)/projekte/[id]/page.tsx`,
`src/components/sicherheit/sicherheit-dashboard.tsx`, `src/components/trust/trusted-device-gate.tsx`, `src/lib/api-auth.ts`,
`src/app/api/dashboard/route.ts`, `src/components/einstellungen/*`, `src/app/api/admin/{users,roles}/**`.
Entfernt: `src/app/api/hr/wage-documents/{rebuild-all,generate/bulk}`, `src/app/api/team/toggle-role` (ungenutzt, Admin ohne Antrag).
Nicht berührt: `src/app/api/ki/**`, `src/lib/ki/**`, `src/app/(app)/vertrieb/**`.
Der Branch enthält auch die Testumgebung (Commit 89bf2f9a: `supabase/config.toml` Ports 5542x, Seed, `supabase/lokal/`) —
mit der Hauptsession klären, ob sie mit nach `main` soll.
