# Lokale Testumgebung (Lohn-Umbau, Branch `lohn`)

Eigene Datenbank auf diesem PC (Docker), getrennt von Live. Alles hier ist **nur lokal**:
erfundene Testpersonen, keine Mails/SMS/KI/Bexio, keine Verbindung zur Live-Datenbank
(ausser dem rein lesenden Schema-Abgleich, siehe unten).

| Was | Adresse |
|---|---|
| App (Dev-Server) | http://localhost:3100 |
| Supabase API | http://127.0.0.1:55421 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:55422/postgres` |
| Studio (Tabellen ansehen) | http://127.0.0.1:55423 |
| Mail-Fänger (Mailpit) | http://127.0.0.1:55424 |

Ports bewusst im Bereich **5542x** (trust-one nutzt die Standardports 5432x), Dev-Server **3100**.
Festgelegt in `supabase/config.toml`.

**Supabase CLI: fest `npx supabase@2.121.0`** (immer mit Versionsnummer aufrufen).
Docker Desktop muss laufen. Postgres lokal 17.11, Live 17.6 (gleiche Hauptversion).

## Starten / Stoppen

Git Bash, im Ordner `C:\Users\misch\projects\eventline-fsm-lohn`:

```bash
npx supabase@2.121.0 start          # Datenbank starten (Daten bleiben erhalten)
npm run dev -- -p 3100              # App starten (eigenes Fenster offen lassen)

npx supabase@2.121.0 stop           # Datenbank stoppen, Daten bleiben
```

Erster Start auf einem neuen Gerät oder nach `stop --no-backup`: statt `start` direkt
`bash supabase/lokal/aufbauen.sh` (startet selbst, baut alles auf).

Hinweis: Der Dev-Server ist auch im Büro-Netz erreichbar (Next.js zeigt die «Network»-Adresse).
Nur Testdaten — wer das nicht will: `npm run dev -- -p 3100 -H 127.0.0.1`.

## Testkonto

| Konto | Passwort | Rolle |
|---|---|---|
| `lohn-admin@example.com` | `LohnTest-2026!` | Admin (Lohn-Seite) |
| `lohn-admin2@example.com` | `LohnTest-2026!` | zweiter Admin (Vier Augen, Gerätefreigabe; Cookie `lokal-testgeraet-admin2`) |
| `<vorname>.<nachname>@example.com` (z. B. `lara.steiner@example.com`) | `LohnTest-2026!` | Techniker |

Gerätesperre der Lohn-Seite: für den Admin ist regulär ein **vertrautes Testgerät** registriert
(Tabelle `trusted_devices`, Status approved). Im Browser einmal das Cookie setzen
(Entwicklertools → Konsole auf http://localhost:3100):

```js
document.cookie = "eventline_trusted_device=lokal-testgeraet-admin; path=/";
```

(Alternativ den normalen Freigabe-Ablauf der App nutzen — Mails landen dann im Mail-Fänger.)

## Neu aufbauen / Testdaten neu laden

```bash
bash supabase/lokal/aufbauen.sh             # alles neu: leere DB, Migrationen, Live-Nachträge, Testdaten (~1 min)
bash supabase/lokal/aufbauen.sh --nur-seed  # nur Testdaten neu laden (Schema bleibt)
bash supabase/lokal/aufbauen.sh --ohne-seed # nur Schema
```

Wichtig: `npx supabase@2.121.0 db reset` **allein** ergibt eine leere Datenbank — Migrationen und
Seed sind in `config.toml` absichtlich aus, weil `aufbauen.sh` sie steuert:

1. alle `supabase/migrations/*.sql` in Namensreihenfolge (inkl. `126b_…`, das die CLI überspringen würde),
   je Datei eine Transaktion, Windows-Zeilenenden entfernt — wie die Management-API auf Live;
2. ausgelassen, weil auf Live noch nicht eingespielt: `351_ablage_technik_nach_trust_one.sql`
   (Liste `NICHT_AUF_LIVE` im Skript — nachführen, sobald sie auf Live läuft);
3. `supabase/lokal/nach-migrationen.sql`: was auf Live ohne Migration entstand bzw. anders aussieht (s. u.);
4. `supabase/seed-lohn-test.sql`: Testdaten (bricht ab, wenn die DB Konten ausserhalb `@example.com` hat).

Neue Migration für den Lohn-Umbau testen: Datei in `supabase/migrations/` anlegen, `bash supabase/lokal/aufbauen.sh`.
Oder einzeln: `docker exec -i supabase_db_eventline-fsm-lohn psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -f - < supabase/migrations/<datei>.sql`.

## Rauchtest (Login, Lohn-Seite, PDF)

```bash
node supabase/lokal/pruefen.mjs                                   # Lara Steiner, September 2026
node supabase/lokal/pruefen.mjs <profil-id> <jahr> <monat>        # beliebig
```

Meldet sich als Test-Admin an, ruft `/lohn` und `/api/hr/monthly-stats` mit Testgerät auf, erzeugt eine
Lohnabrechnung über die bestehende Route `POST /api/hr/wage-documents/generate`, holt das PDF aus dem lokalen
Bucket `lohndokumente` nach `supabase/lokal/ausgabe/` und meldet sich **nur lokal** ab (`signOut({ scope: "local" })`).
Bricht ab, wenn `.env.local` nicht auf das lokale Supabase zeigt.

Prüftor Phase 1 (Sicherheit, Lauf, Fassungen, Papierkorb, Gerätefreigabe, Vier Augen, «Ansicht als», Löschschutz):

```bash
bash supabase/lokal/aufbauen.sh        # frische Testdaten
node supabase/lokal/pruefen-phase1.mjs # 209 Prüfungen, meldet sich nur lokal ab
```

Braucht in `.env.local` einen lokalen Testwert für `CRON_SECRET` (z. B. `lokal-cron-geheimnis-phase1`; der Dev-Server
lädt `.env.local` bei Änderung neu). Setzt lokal `lohn_einstellungen.lauf_ab = 2026-03-01`, damit mehrere gesperrte
Monate nachgeholt werden. Live-Gang-Paket (Sicherung, Rückwege, Reihenfolge): `supabase/lokal/live-gang-phase1/`.

Wartungsmodus (Migration 363, `scripts/wartung.mjs … --lokal`):

```bash
node supabase/lokal/pruefen-wartung.mjs   # 106 Prüfungen, ~1 min (wartet je Schalten 11 s auf den App-Cache)
```

Schaltet per Skript ein (alle Bereiche, Ausnahme = Admin Zwei), prüft Hinweisseiten, 503 je Bereich,
pausierten Cron und die Ausnahme, schaltet in der App wieder aus und prüft «wie vorher». Setzt Wartung und
Ausnahmen am Ende zurück. Live-Gang: `supabase/lokal/live-gang-wartung.md`.

Prüftor Phase 2 (Rechenkern, Momentaufnahmen, Altbestand, Sperre/Anträge, Jahresliste):

```bash
bash supabase/lokal/aufbauen.sh --nur-seed   # frische Testdaten
node supabase/lokal/pruefen-phase2.mjs       # 54 Prüfungen, meldet sich nur lokal ab
```

Braucht die PDFs des ALTEN Generators in `supabase/lokal/ausgabe/altbestand/` (nicht eingecheckt). Einmalig erzeugen:
Anleitung im Kopf von `supabase/lokal/altbestand-erzeugen.mjs` (temporärer Worktree mit dem Code vor Phase 2 auf
Port 3101). Phase 1 zusätzlich nach vollem `aufbauen.sh` (ohne Reste aus Phase-2-Läufen).

Nachrechnung März–Oktober auf Live (NUR LESEND, Ergebnis nur in `_lohn-korrektur\arbeit\phase2\`):
`node supabase/lokal/nachrechnung-live.mjs` — Konsole zeigt nur Anzahlen und Summen je Ursache.

Unit-Tests: `npm test` (vitest; Rechenkern `src/lib/lohn/kern/kern.test.ts`, `src/lib/lohn/hilfen.test.ts`,
`src/lib/lohn/jahresliste.test.ts`, Lauf/Fassungen).

## Abgleich mit Live wiederholen

```bash
node supabase/lokal/abgleich.mjs
```

Liest auf Live **nur den Katalog** (Management-API, Endpoint `database/query/read-only`, Rolle
`supabase_read_only_user` — kann nichts schreiben; Token aus `_secrets\supabase-access-token.txt` oder
`SUPABASE_ACCESS_TOKEN`). Vergleicht je Objekt: Tabellen + RLS-Schalter, Spalten (Typ, NOT NULL, Default),
Views, Funktionen (md5 der Definition, Eigentümer, SECURITY DEFINER, search_path), EXECUTE-Rechte,
Tabellen-, Spalten- und Schema-Rechte für anon/authenticated/service_role, Policies (public, finanzen,
storage), Trigger, Indizes, Constraints, Enums, Sequenzen, Storage-Buckets, Realtime-Publikation,
Erweiterungen, zusätzliche Rollen. Ergebnis in `supabase/lokal/abgleich-ergebnis.txt` (nicht eingecheckt).
Exit-Code 0 = keine unerwarteten Unterschiede.

Stand 29.10.2026: **3642 Objekte live, 0 unerwartete Unterschiede.**

## Bekannte Abweichungen

### Lokal bewusst anders als Live
- `public._test_payroll()` — Test-Überbleibsel auf Live (verweist auf eine echte Profil-ID), nicht nachgebaut.
- Rolle `sicherung_lesen` — Nur-Lese-Login der Datensicherung, nur Live.
- Auth-Einstellungen nur das Nötige wie Live (Registrierung aus, TOTP an). Mails gehen lokal in den Mail-Fänger.
- Realtime (Live-Aktualisierung) ist lokal blockiert: die Content-Security-Policy in `next.config.ts` leitet die
  WebSocket-Adresse nur aus `https://` ab (`wss:`), lokal ist es `http://` → `ws://` fehlt. Seiten funktionieren,
  aktualisieren sich aber nicht von selbst. (Nicht geändert — Code-Anpassung wäre `SUPA.replace(/^http/, "ws")`.)

### Repo-Migrationen ≠ Live (Befund, lokal auf Live-Stand gebracht in `nach-migrationen.sql`)
Diese Teile stehen in Migrationen, sind auf Live aber nicht (so) vorhanden:

| Migration | Auf Live fehlt / anders |
|---|---|
| 001, 053 | Policies «Profiles sind für authentifizierte Benutzer sichtbar», «Profile: eigenes oder admin»; FK `profiles.id → auth.users` |
| 110 | Spalte `bexio_connection.feature_accounting` |
| 114 | Funktion `get_my_compensation()` |
| 135 | `wage_documents.created_at`, `updated_at` + Trigger `wage_documents_updated_at` |
| 168 | `permission_audit_log`: Sperr-Policies `*_none`; `permission_audit_select_admin` gilt live für Rolle `public` |
| 185 | `company_settings.created_at` + Trigger |
| 205 | `job_overdue_reminders`: Sperr-Policies `*_none`; `select_admin` live per `profiles.role = 'admin'` |
| 209 | `user_passkey_challenges`: Sperr-Policies `*_none` (RLS an, ohne Policy ohnehin gesperrt) |
| 213 | `get_all_time_entries()` liefert live keine Projekt-Spalten |
| 216 | `job_drafts.archived_at`, Index, `archive_stale_job_drafts()` → **Cron `/api/cron/job-drafts-archive` ruft auf Live eine fehlende Funktion auf** |
| 217 | Benachrichtigungs-Standardwerte (2 Funktionen, Trigger auf `profiles`, `user_notification_settings.created_at`) |
| 351 | gewollt noch nicht eingespielt (siehe Dateikopf) |
| – | Live zusätzlich: Buckets `documents` (25 MB), `lohndokumente`, `personal-dossiers` (per Dashboard), Realtime für `jobs`, Spalten-Rechte auf `profiles` |
| – | `get_my_wage_consent`, `handle_new_user`, `prevent_profile_delete`: live einzeilig formatiert, gleiche Logik |

## Testdaten (`supabase/seed-lohn-test.sql`)

Standardwerte wie Live: ab 09.03.2026 (BVG-Schwelle 1'890) und ab 01.01.2027 (1'920), Sätze wie Live
(u. a. NBU 1.45/1.44 %, FAK 1.35 %, BU 0.5742/0.5829 %, VK 0.11 %). Firma: «EVENTLINE GmbH (TESTUMGEBUNG)».
Alle Lohnzeilen ab 09.03.2026, Stempelzeiten März 2026 – Januar 2027.

| Person | Lohn/h | Sonderfall |
|---|---|---|
| Lena Jung | 24.00 | unter 20, 20. Geburtstag 15.07.2026; Auffahrt; 1. August 18:00–23:30 |
| Noah Brunner | 30.00 | Ferienanteil-Override 10.64 %; Nachtschichten Fr 22–04; 31.05.→01.06. (über Mitternacht + Monatsende, So→Mo); Sa 08.08. 21:00 → So 05:00 und So 16.08. 20:00 → Mo 00:30 (Sonntag laut Vertrag Sa 23 – So 23); überlappende Stempel 11.09. (30 min, Altfall markiert); Silvester → Neujahr; offener Stempel 29.01.2027 (sein letzter, Regel 368) |
| Mia Keller | 27.00 | NBU: jede Woche 7.75 h → Ø knapp unter 8 h |
| Elias Meier | 27.00 | NBU: jede Woche 8.25 h → Ø knapp über 8 h |
| Sara Huber | 28.00 | sporadisch 5 h/Monat + grosse Woche 08.–12.06. (42.5 h) |
| Jonas Frei | 25.00 | 2'500-Grenze knapp darunter: 2026 = 99 h = CHF 2'475.00, keine Zuschläge |
| Lara Steiner | 26.00 → 28.00 | 2'500-Grenze knapp darüber (2026 = CHF 2'532.00); Lohnerhöhung ab 15.09.2026 |
| Luca Rossi | 29.00 | eigene Sätze inkl. Quellensteuer 10.58 % (2026 und 2027); Monatsbrutto um die BVG-Schwelle (8 vs. 9 Tage × 8 h); 1. August |
| Ben Wyss | 26.50 | Austritt: Lohnzeile bis 30.06.2026, Profil inaktiv |

Feste IDs: Admin `a0000000-0000-4000-8000-000000000001`, Personen `…000000000011` (Lena) bis `…000000000019` (Ben)
in obiger Reihenfolge.

Schon sichtbar (Audit-Befund bestätigt): Der alte Generator rechnete Lara September 2026 alle 12 h mit 28.00
(CHF 336.00) statt 6 h × 26.00 + 6 h × 28.00 (CHF 324.00). Seit Phase 2 rechnet der Kern tageweise (CHF 324.00
plus 1. August 0,39 % = CHF 325.15).

Anstellungen (Phase 2, `lohn_anstellungen`): alle Testpersonen ab 09.03.2026, Ben Austritt 30.06.2026;
Elias ohne Anstellung (Fall «nicht erfasst»).

## Sicherheit
- `.env.local` (nicht eingecheckt) enthält nur die Standard-Demo-Schlüssel des lokalen Supabase; Mail-, Push-, KI-,
  Bexio-, Trust-one-, Cron- und Management-Schlüssel sind leer. **Nie `vercel env pull` in diesem Ordner.**
- `seed-lohn-test.sql` bricht ab, sobald die Datenbank echte Konten enthält.
- Live wird nur vom Abgleich gelesen (read-only Endpoint), nie beschrieben.
