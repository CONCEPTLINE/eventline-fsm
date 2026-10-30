# Live-Gang A6 Stammdaten-Abruf (+ `/personen` mit Inaktiven, + Schalter `ABLAGE_ZIEL` für E2 und E1)

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
| Code E1 | Mail-Eingang `ablage@…` folgt demselben Schalter: bei `trust-flow` Anhang mit «TFD1» verschlüsselt an Trust flow (`src/lib/ablage/tfd1.ts`, `leiteAblageAnhangWeiter`). **Ohne die Env bleibt alles wie heute** (Klartext an trust one). |
| Vercel-Env | keine neue Pflicht-Variable. `FLOW_ABRUF_PUBLIC_KEY` ist seit 30.10. gesetzt. E2/E1: `ABLAGE_ZIEL` und `RIG_ABLAGE_ENC_PUBLIC_KEY` erst zum Umschalten (unten). |

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
| E2.3 | **Umschalten 28.11. (Production):** zusammen mit E1 (Schritt E1.3 unten) — `ABLAGE_ZIEL=trust-flow` schaltet Fristen-Zähler **und** Mail-Eingang um, also erst setzen, wenn der E1-Code live ist und `RIG_ABLAGE_ENC_PUBLIC_KEY` in Production steht. | Dashboard/Wand zeigen die Zahl aus Trust flow |
| E2.R | **Rückweg:** `ABLAGE_ZIEL` löschen (oder `trust-one`) + Redeploy | Zahl wieder aus Trust one |

**Link der Dashboard-Kachel** «Fristen in 30 Tagen» folgt demselben Schalter (`ablageFristenLink()`, vom Server ins
Dashboard geliefert): bei `trust-flow` → `{TRUST_FLOW_URL}/eventline/fristen` (Standard `https://flow.trust-group.ch/eventline/fristen`),
sonst wie bisher `TRUST_ONE_FRISTEN_LINK` (Trust one). Alte Dashboard-Zwischenspeicher im Browser ohne Link fallen auf Trust one zurück.

## E1 Mail-Eingang an Trust flow, verschlüsselt «TFD1» (Preview bis 18.11., Umschalten 28.11.)
Derselbe Schalter **`ABLAGE_ZIEL`**. Bei `trust-flow` geht jeder erlaubte Anhang einer Mail an `ablage@…` nicht mehr an
trust one, sondern an `POST {TRUST_FLOW_URL}/api/ablage/extern/eingang` (Bearer `TRUST_ONE_ABLAGE_TOKEN`, gleicher Wert):
`anmelden` (`firma:"eventline"`, Name, Typ, Klartext-Grösse, Resend-Mail-ID, Absender, Betreff) → Anhang mit «TFD1» für den
Rig verschlüsseln (Kontext = `auftrag_id`, `src/lib/ablage/tfd1.ts`, byte-genau gegen die 3 Testvektoren der Referenz) →
`PUT upload_url` (nur das Chiffrat, `application/octet-stream`) → `bestaetigen`. Trust flow und die Cloud sehen den Inhalt nie.
Vertrag: `_backoffice-uebergabe/12_TFD1_Referenz.md`.

**Sicherheit (Schlüssel fest hinterlegt):** Env **`RIG_ABLAGE_ENC_PUBLIC_KEY`** = öffentlicher Rig-Schlüssel (P-256 roh,
base64url, 87 Zeichen; liefert die Backoffice-Session in `06_Aenderungen.md`, spätestens 13.11.). `rig_schluessel` aus der
Antwort von `anmelden` muss **genau** diesem Wert entsprechen, sonst bricht das ERP ab (Log «Rig-Schlüssel stimmt nicht»),
**kein Upload**. Fehlt die Env oder ist sie ungültig, geht bei `trust-flow` gar nichts raus (fail closed). Kein Geheimnis —
der Wert ist öffentlich; geheim bleibt nur der Token.

**Fehler wie heute** (Route `api/inbound/mail` unverändert in der Logik): `fehler` → Webhook antwortet 502, Resend wiederholt
später, schon gelieferte Anhänge meldet Trust flow als `schon_da`; `abgewiesen` → Mail gilt als verarbeitet (200), die Admins
bekommen die Mitteilung «Ablage-Mail: Anhang nicht übernommen … Bitte die Datei direkt in Trust flow ablegen.». Zuordnung:
503 (Büro nicht erreichbar, Ablage im Lesebetrieb), 502, Netz, Zeit, Rig-Schlüssel falsch/fehlt und **401** (Token
falsch; Log-Grund «HTTP 401 (zugang)» — Resend wiederholt, nach der Korrektur des Tokens kommen die Anhänge noch an) =
`fehler`; 400/413/415 und Anhang > 48 MiB (wird gar nicht erst angemeldet) = `abgewiesen`. Eingebaute Wiederholungen nach Vertrag:
409 (Auftrag abgelaufen) → einmal neu anmelden; 5xx beim PUT bzw. 502 beim Bestätigen → Upload einmal wiederholen.
Log-Kontext: `inbound.ablage.weiterleitung` (Grund ohne Inhalt/Geheimnis).

| Env (Vercel) | Wert | wann |
|---|---|---|
| `ABLAGE_ZIEL` | `trust-flow` | Preview ab Probe, Production am 28.11. |
| `RIG_ABLAGE_ENC_PUBLIC_KEY` | Wert aus `06_Aenderungen.md` (87 Zeichen) | Preview ab Probe, Production **vor** bzw. mit `ABLAGE_ZIEL` |
| `TRUST_FLOW_URL` | optional, Standard `https://flow.trust-group.ch` | nur falls abweichend |
| `TRUST_ONE_ABLAGE_TOKEN` | unverändert (= `ABLAGE_EXTERN_TOKEN` in Trust flow) | muss auch für Preview gesetzt sein |

| # | Schritt | Erfolg = |
|---|---|---|
| E1.1 | Code geht mit dem nächsten Deploy von `lohn` mit — ohne `ABLAGE_ZIEL` keine Änderung | Ablage-Mails landen weiter in trust one |
| E1.2 | **Preview-Probe (bis 18.11.):** Preview-Env wie Tabelle (zusätzlich `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY` für Preview prüfen), Preview neu bauen. Backoffice-Session bestätigt, dass die Ablage in Trust flow Mail-Eingänge annimmt (sonst 503 = Lesebetrieb). Eine Test-Mail ohne Personendaten mit einem kleinen PDF an `ablage@…` schicken (die Produktion legt sie wie gewohnt in trust one ab), ihre Resend-ID aus dem Resend-Dashboard nehmen und der Preview zustellen: `RESEND_WEBHOOK_SECRET=… [VERCEL_BYPASS=…] node supabase/lokal/live-gang-a6/probe-e1.mjs <preview-url> <email_id>` | `HTTP 200 {"ok":true,"ablage":1,…}`; die Datei liegt im NAS-Eingang (`System/Eingang/eventline-gmbh/…`) und lässt sich öffnen (= Rig hat entschlüsselt). Zweiter Aufruf mit derselben ID → wieder 200 (`schon_da`). Gegenprobe mit einer **zweiten** Test-Mail (die erste meldet Trust flow schon als da) und falschem `RIG_ABLAGE_ENC_PUBLIC_KEY` auf der Preview → `HTTP 502`, Log «Rig-Schlüssel stimmt nicht», nichts in Trust flow |
| E1.3 | **Umschalten 28.11. (Production, zusammen mit E2.3):** `RIG_ABLAGE_ENC_PUBLIC_KEY` setzen, dann `ABLAGE_ZIEL=trust-flow`, Redeploy (~2 Min.). Danach eine Test-Mail an `ablage@…` | Test-Datei im NAS-Eingang von Trust flow, nicht mehr in trust one; Vercel-Log ohne `inbound.ablage.*` |
| E1.R | **Rückweg:** `ABLAGE_ZIEL` löschen (oder `trust-one`) + Redeploy; `RIG_ABLAGE_ENC_PUBLIC_KEY` darf stehen bleiben (der trust-one-Weg nutzt ihn nicht) | Ablage-Mails wieder an trust one; was bis dahin bei Trust flow ankam, liegt im NAS-Eingang |

Hinweis: Fehlt am 28.11. `RIG_ABLAGE_ENC_PUBLIC_KEY` in Production, gehen Ablage-Mails nicht verloren — der Webhook antwortet
502 und Resend wiederholt; Env nachtragen + Redeploy, die nächste Wiederholung (innerhalb der Wiederholungsfrist von Resend) liefert nach. Auftrags-Mails (`auftrag@…`)
sind von E1 nicht betroffen.
