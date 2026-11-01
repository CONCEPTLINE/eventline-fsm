# Live-Gang E2 Fristen-Zähler aus Trust flow (Schalter `ABLAGE_ZIEL`)

Stand 01.11.2026, Branch `lohn`. Code: `src/lib/trust-one-ablage.ts` — Schalter `ABLAGE_ZIEL` für den Fristen-Zähler und
den Link der Dashboard-Kachel. **Ohne die Env bleibt alles wie heute** (Zähler und Link Trust one). Vercel-Env: keine neue
Pflicht-Variable; `ABLAGE_ZIEL` erst zum Umschalten (unten).

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
| E2.1 | Code ging mit dem Deploy vom 30.10. mit — ohne `ABLAGE_ZIEL` keine Änderung | Dashboard zeigt die Fristen wie bisher (aus Trust one) |
| E2.2 | **Preview (bis 18.11.):** Vercel → Environment Variables → **Preview**: `ABLAGE_ZIEL=trust-flow`; prüfen, dass `TRUST_ONE_ABLAGE_TOKEN` auch für Preview gesetzt ist; Preview neu bauen | Dashboard der Preview zeigt die Zahl aus Trust flow, die Zeile «Fristen in 30 Tagen» führt auf `https://flow.trust-group.ch/eventline/fristen`; Vercel-Log ohne `dashboard.fristen`-Fehler |
| E2.3 | **Umgeschaltet 01.11.2026** (Ablage-Umzug nach Trust flow am 01.11. 01:25; zugleich Weiterleitung `ablage@` entfernt). **Umschalten (Production, mit dem Ablage-Umzug):** `ABLAGE_ZIEL=trust-flow` + Redeploy. Schaltet nur den Fristen-Zähler und den Kachel-Link. **E1 entfällt** (Mischa 30.10.: den Mail-Eingang fürs Backoffice baut Trust flow selbst mit eigener Adresse); `ablage@…` geht bis zur Umstellung durch Trust flow weiter an trust one. | Dashboard/Wand zeigen die Zahl aus Trust flow |
| E2.R | **Rückweg:** `ABLAGE_ZIEL` löschen (oder `trust-one`) + Redeploy | Zahl wieder aus Trust one |

**Link der Dashboard-Kachel** «Fristen in 30 Tagen» folgt demselben Schalter (`ablageFristenLink()`, vom Server ins
Dashboard geliefert): bei `trust-flow` → `{TRUST_FLOW_URL}/eventline/fristen` (Standard `https://flow.trust-group.ch/eventline/fristen`),
sonst wie bisher `TRUST_ONE_FRISTEN_LINK` (Trust one). Alte Dashboard-Zwischenspeicher im Browser ohne Link fallen auf Trust one zurück.
