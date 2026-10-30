# Live-Gang A6 Stammdaten-Abruf (+ `/personen` mit Inaktiven, + Schalter `ABLAGE_ZIEL` für E2)

Stand 30.10.2026, Branch `lohn` (auf live `main` `f60036c`). **Vorbereitet, nicht ausgeführt.** Ausführen: Mischa bzw. die
Hauptsession. **Live-Ziel A6: bis Mi 11.11.2026**, nie zwischen dem 5. und 7. eines Monats (Lohnlauf). Unabhängig von
Migration 368 (Phase 4 Tag 2, 31.10.) — 370 braucht nur 369 (live seit 30.10.).
Vertrag: `supabase/lokal/live-gang-a6/VERTRAG.md`. Code: `src/app/api/flow/stammdaten/route.ts`, `src/lib/flow/`,
`src/lib/trust-one-ablage.ts`.

Lokal geprüft (30.10., frische Testdaten): `pruefen-flow.mjs` ALLES OK (102; davon A6: Antwortform, Standard vs. individuelle
Sätze, festes Ferien-% (`ferien_pct`), keine verbotenen Felder, Partner/unbekannte ID fallen weg, Protokoll ohne Monat, `jti` doppelt, abgelaufen, falscher
`aud`, > 50 Profile, Wartung, Höchstzahl in der Gruppe «Abruf», 503 ohne Schlüssel; `/personen` mit Inaktiven und `aktiv`),
`pruefen.mjs`, `pruefen-phase1` (209), `-phase2`, `-phase4` (170), `-wartung` ALLES OK, `npm test`, `tsc`, ESLint,
`abgleich.mjs` (0 unerwartete Unterschiede; erwartet 368 + 370), Rückweg 370 → `/stammdaten` 500, `/personen` 200 → 370 erneut
→ `pruefen-live.mjs nachher|app --lokal` ALLES OK. (Nebenbei: `seed-lohn-test.sql` räumt `lohn_bexio_fassungen` mit ab —
sonst brach `aufbauen.sh --nur-seed` nach einem `pruefen-flow`-Lauf ab.)

## Was sich auf Live ändert
| Teil | Inhalt |
|---|---|
| `370_flow_stammdaten.sql` | `flow_abrufe.aud` (Regel `flow_abrufe_aud_check`) und `flow_abruf_beginnen` kennen zusätzlich `flow-stammdaten` (Gruppe «abruf», 10 je Minute zusammen mit Stempel/Personen/Vergleich). Sonst nichts; ändert keine Zeile; idempotent; Rechte unverändert (nur `service_role`). |
| Code A6 | neue Route `POST /api/flow/stammdaten` (Ausweis wie A1, `aud` `flow-stammdaten`, Antwort laut `VERTRAG.md`). |
| Code A1 `/personen` | liefert zusätzlich inaktive interne Profile mit ERP-Anstellung, deren Austritt leer oder ≥ 2026-12-01 ist, und je Person das neue Feld `aktiv` (bisherige Felder/Sortierung unverändert). **Änderung an einer live-Route — Trust flow ist informiert (Wunsch der Backoffice-Session).** |
| Code E2 | Schalter `ABLAGE_ZIEL` in `src/lib/trust-one-ablage.ts` (Fristen-Zähler und Link der Dashboard-Kachel). **Ohne die Env bleibt alles wie heute** (Zähler und Link Trust one). |
| Vercel-Env | keine neue Pflicht-Variable. `FLOW_ABRUF_PUBLIC_KEY` ist seit 30.10. gesetzt. E2: `ABLAGE_ZIEL` erst zum Umschalten (unten). |

## Befehlsfolge A6 (keine Wartung nötig)
| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 0 | `git fetch --all`; höchste Migrationsnummer auf allen Branches (Stand 30.10.: 369 live, 368 auf `lohn`, 365/366 auf `origin/vertrieb-kampagnen`) | 370 frei — sonst umnummerieren (Datei, Verweise hier/in `VERTRAG.md`, `abgleich.mjs`, Rückweg) | — |
| 1 | `node supabase/lokal/live-gang-a6/pruefen-live.mjs vorher` | `ALLES OK` (369 live, 370 fehlt) | — |
| 2 | Migration 370 über die Management API (wie 369; im Worktree zeigt `apply-migration.mjs` auf lokal) | keine Fehlermeldung | `370_rueckweg.sql` |
| 3 | `node supabase/lokal/live-gang-a6/pruefen-live.mjs nachher` | `ALLES OK` | wie 2 |
| 4 | Code deployen (Push nach CLAUDE.md B1; `/api/version` = SHA). Reihenfolge Migration → Code ist die sichere: umgekehrt antwortet `/stammdaten` bis Schritt 2 mit 500 (nie offen) | Vercel fertig | Vercel «Promote» auf den vorherigen Deploy |
| 5 | `node supabase/lokal/live-gang-a6/pruefen-live.mjs app` | `/stammdaten`, `/personen`, `/stempel` → 401 auf einen ungültigen Ausweis (404 = Code fehlt, 503 = Schlüssel fehlt) | — |
| 6 | `abgleich.mjs`: 370-Muster aus `NOCH_NICHT_LIVE` nehmen (`flow_abrufe_aud_check`, `flow_abruf_beginnen`) — **erledigt 30.10.** —, danach 0 unerwartete Unterschiede | — | — |
| 7 | Trust flow: Import Teil 1 (Vorschau je Person, Bestätigen durch Mischa/Leo). Nur lesend prüfen: `select aud, status, angefragt, geliefert, empfangen_at from flow_abrufe where aud = 'flow-stammdaten' order by empfangen_at desc limit 5` | Status `ok`, `geliefert` = erwartete Personen | — |
| 8 | Hauptsession trägt in `_backoffice-uebergabe/06_Aenderungen.md` ein: A6 live (URL `…/api/flow/stammdaten`), `/personen` mit `aktiv` | — | — |

## Rückweg A6
- **Schnell, ohne Datenbank:** Vercel «Promote» auf den Deploy vor A6 → `/stammdaten` 404, `/personen` wieder ohne Inaktive/`aktiv`.
- **Datenbank:** `370_rueckweg.sql` — `flow_abruf_beginnen` wie 369 (nimmt `flow-stammdaten` nicht mehr an → `/stammdaten` 500,
  A1/A5 laufen weiter). Die erweiterte Regel und protokollierte A6-Aufrufe bleiben. Erneut einspielen stellt alles her.
- Lokal getestet: Rückweg → `/stammdaten` 500, `/personen` 200 → 370 erneut → `pruefen-live.mjs nachher|app --lokal` ALLES OK.

## E2 Fristen-Zähler aus Trust flow (Preview bis 18.11., Umschalten 28.11.)
Ein Schalter für die ganze Ablage: Env **`ABLAGE_ZIEL`** = `trust-one` (Standard, auch leer/unbekannt) | `trust-flow`.
Bei `trust-flow` holen Dashboard und Büro-Bildschirm den Zähler per `POST {TRUST_FLOW_URL}/api/ablage/extern/fristen`
(`TRUST_FLOW_URL` optional, Standard `https://flow.trust-group.ch`) mit `Authorization: Bearer <TRUST_ONE_ABLAGE_TOKEN>`
(derselbe Wert wie heute — in Trust one/Trust flow heisst er `ABLAGE_EXTERN_TOKEN` und zieht mit um) und Body
`{"firma":"eventline","tage":30}`. Antwort `{offen, faellig, vorschlaege}`: `faellig` → «aktiv» (Wand), `faellig` +
`vorschlaege` → Dashboard (wie heute aktiv + Vorschlag); `offen` wird nicht gebraucht. Gleiche Zeitgrenze (8 s), gleicher
Zwischenspeicher (5 min, je Ziel eigener Eintrag → Umschalten wirkt sofort nach dem Redeploy), gleiche Fehler (nie still 0;
die Zeile fehlt, Fehler im Log `dashboard.fristen` / `bildschirm.fristen`).

| # | Schritt | Erfolg = |
|---|---|---|
| E2.1 | Code geht mit dem A6-Deploy mit — ohne `ABLAGE_ZIEL` keine Änderung | Dashboard zeigt die Fristen wie bisher (aus Trust one) |
| E2.2 | **Preview (bis 18.11.):** Vercel → Environment Variables → **Preview**: `ABLAGE_ZIEL=trust-flow`; prüfen, dass `TRUST_ONE_ABLAGE_TOKEN` auch für Preview gesetzt ist; Preview neu bauen | Dashboard der Preview zeigt die Zahl aus Trust flow, die Zeile «Fristen in 30 Tagen» führt auf `https://flow.trust-group.ch/eventline/fristen`; Vercel-Log ohne `dashboard.fristen`-Fehler |
| E2.3 | **Umschalten (Production, mit dem Ablage-Umzug):** `ABLAGE_ZIEL=trust-flow` + Redeploy. Schaltet nur den Fristen-Zähler und den Kachel-Link. **E1 entfällt** (Mischa 30.10.: den Mail-Eingang fürs Backoffice baut Trust flow selbst mit eigener Adresse); `ablage@…` geht bis zur Umstellung durch Trust flow weiter an trust one. | Dashboard/Wand zeigen die Zahl aus Trust flow |
| E2.R | **Rückweg:** `ABLAGE_ZIEL` löschen (oder `trust-one`) + Redeploy | Zahl wieder aus Trust one |

**Link der Dashboard-Kachel** «Fristen in 30 Tagen» folgt demselben Schalter (`ablageFristenLink()`, vom Server ins
Dashboard geliefert): bei `trust-flow` → `{TRUST_FLOW_URL}/eventline/fristen` (Standard `https://flow.trust-group.ch/eventline/fristen`),
sonst wie bisher `TRUST_ONE_FRISTEN_LINK` (Trust one). Alte Dashboard-Zwischenspeicher im Browser ohne Link fallen auf Trust one zurück.
