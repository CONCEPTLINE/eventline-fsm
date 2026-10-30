# Vertrag A6 — `POST /api/flow/stammdaten` (ERP → Trust flow)

Stand 30.10.2026, Branch `lohn`, Migration 370. Antwortform = die Form, gegen die Trust flow seinen Import (Teil 1)
gebaut hat (Nachtrag der Hauptsession, 30.10.). Abstimmung: `_backoffice-uebergabe/07_Rueckfragen.md`, 30.10. 12:20 / 12:45 / 13:00.
Code: `src/app/api/flow/stammdaten/route.ts`, `src/lib/flow/` (`regeln.ts` → `pruefeStammdatenClaims`, `stammdatenPerson`;
`daten.ts` → `stammdatenAntwort`). Ablauf, Einmal-Schutz, Höchstzahl und Protokoll sind dieselben wie bei A1.

## 1. Aufruf

| | |
|---|---|
| URL | `https://eventline-fsm-usyk.vercel.app/api/flow/stammdaten` |
| Methode | `POST`, `Content-Type: application/jose` |
| Körper | nur der Ausweis (kompaktes JWS, höchstens 16 000 Zeichen) |
| Ausweis | Header `{"alg":"EdDSA","typ":"JWT"}`, signiert mit `FLOW_ABRUF_PRIVATE_KEY` (Ed25519); das ERP prüft mit `FLOW_ABRUF_PUBLIC_KEY` — **derselbe Schlüssel wie A1/A5** |

### Claims

| Claim | Pflicht | Wert |
|---|---|---|
| `iss` | ja | `https://flow.trust-group.ch` |
| `aud` | ja | `flow-stammdaten` (ein Ausweis einer anderen Route wird abgelehnt und umgekehrt) |
| `sub` | ja | UUID des Trust-flow-Profils, das abruft |
| `jti` | ja | UUID, für jeden Abruf neu (Einmal-Schutz) |
| `iat` | ja | Ausstellzeit in Sekunden (höchstens 5 s in der Zukunft) |
| `exp` | ja | `iat + 60` (höchstens 60 s gültig; 5 s Uhren-Spielraum) |
| `firma` | ja | `eventline` |
| `profile` | ja | 1–50 ERP-Profil-IDs (UUID, ohne Doppel; Gross-/Kleinschreibung egal) |
| `aal` | ja | `aal2` |
| `geraet` | ja | `true` |
| `jahr`, `monat`, `von`, `bis` | nein | dürfen fehlen; werden **ignoriert** (auch nicht protokolliert) |
| `nbf` | nein | falls gesetzt: nicht in der Zukunft |

Beispiel (erfunden):

```json
{
  "iss": "https://flow.trust-group.ch",
  "aud": "flow-stammdaten",
  "sub": "0f0e0d0c-0b0a-4908-8706-050403020100",
  "jti": "6b1f6a52-3c0e-4c55-9d0e-2f3a1b2c3d4e",
  "iat": 1793444400,
  "exp": 1793444460,
  "firma": "eventline",
  "profile": ["a0000000-0000-4000-8000-000000000011", "a0000000-0000-4000-8000-000000000018"],
  "aal": "aal2",
  "geraet": true
}
```

## 2. Antwort 200

Kopfzeilen: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`,
`X-Antwort-Sha256` = sha256 (hex) des Körpers, wie im ERP-Protokoll gespeichert.

Beispiel (erfundene Personen und Zahlen):

```json
{
  "personen": [
    {
      "erp_profil_id": "a0000000-0000-4000-8000-000000000011",
      "name": "Muster",
      "vorname": "Erika",
      "geburtsdatum": "1998-05-17",
      "anstellungen": [
        { "firma": "eventline", "eintritt": "2026-03-09", "austritt": null, "vertragsart": "stundenlohn" }
      ],
      "lohnzeilen": [
        { "gueltig_ab": "2026-03-09", "ansatz": 26.0, "standard": true,
          "quellensteuer_pct": null, "nbu_pct": null, "bvg_pct": null, "ansatz_art": "inkl_ferien", "ferien_pct": null },
        { "gueltig_ab": "2026-10-01", "ansatz": 27.5, "standard": true,
          "quellensteuer_pct": null, "nbu_pct": null, "bvg_pct": null, "ansatz_art": "inkl_ferien", "ferien_pct": 8.33 }
      ]
    },
    {
      "erp_profil_id": "a0000000-0000-4000-8000-000000000018",
      "name": "Beispiel",
      "vorname": "Max",
      "geburtsdatum": null,
      "anstellungen": [
        { "firma": "eventline", "eintritt": "2026-03-09", "austritt": "2026-06-30", "vertragsart": "stundenlohn" },
        { "firma": "eventline", "eintritt": "2026-10-01", "austritt": null, "vertragsart": null }
      ],
      "lohnzeilen": [
        { "gueltig_ab": "2026-10-01", "ansatz": 30.0, "standard": false,
          "quellensteuer_pct": 9.5, "nbu_pct": 1.2, "bvg_pct": 0, "ansatz_art": "inkl_ferien", "ferien_pct": null }
      ]
    }
  ]
}
```

### Felder

| Feld | Herkunft im ERP | Regel |
|---|---|---|
| `personen[]` | signierter Claim `profile` | **jedes interne ERP-Profil** daraus, in Anfrage-Reihenfolge — unabhängig von Anstellung und «aktiv» (auch Ausgetretene). Partner-/Lieferanten-Zugänge und unbekannte IDs **fallen weg** (kein Fehler; wie `/stempel`). Leere Liste möglich. |
| `erp_profil_id` | `profiles.id` | klein geschrieben |
| `name`, `vorname` | `profiles.full_name` | Das ERP führt nur **einen** Namen («Vorname Nachname»): erstes Wort = `vorname`, Rest = `name`. Ein einzelnes Wort → `name`, `vorname` = `""`. Doppelvornamen (z. B. «Anna Maria …») beim Bestätigen in Trust flow korrigieren. |
| `geburtsdatum` | `profiles.birthdate` | `YYYY-MM-DD` oder `null` |
| `anstellungen[]` | `lohn_anstellungen` | alle Zeilen der Person, nach `eintritt`; `[]`, wenn im ERP keine erfasst ist. Die Tabelle kennt kein Archiv (Zeilen werden nie gelöscht, Aufbewahrung) — es gibt nichts wegzulassen. |
| `.firma` | — | immer `eventline` (= Claim `firma`; das ERP hat nur eine Arbeitgeberin, eine Firmen-Spalte gibt es nicht) |
| `.eintritt`, `.austritt` | `eintritt`, `austritt` | `YYYY-MM-DD`; `austritt` `null` = offen |
| `.vertragsart` | `vertragsart` | Abbildung: `abruf_unecht` → `stundenlohn`, `abruf_echt` → `stundenlohn`, **`fest` → `null`** (Festanstellung sagt nichts über die Lohnform — beim Bestätigen wählen; im ERP selbst ist jede Lohnzeile ein Stundenlohn), unbekannt → `null` |
| `lohnzeilen[]` | `employee_compensation` | alle Zeilen der Person (die Tabelle kennt kein Archiv), nach `gueltig_ab` |
| `.gueltig_ab` | `effective_from` | `YYYY-MM-DD`. Ein Ende wird nicht geliefert (nicht Teil der Form): eine Zeile gilt bis zum Tag vor dem nächsten `gueltig_ab`, die letzte bis zum Austritt. |
| `.ansatz` | `hourly_wage_chf` | CHF je Stunde, Zahl; **`null` bei einer Zeile «kein Lohn»** (`wage_exempt`, z. B. Inhaber — der ERP-Kern bezahlt diese Minuten nicht) |
| `.standard` | `uses_standard_lohn` | `true` = Firmen-Standardsätze (Trust flow nimmt eigene Standardwerte) |
| `.quellensteuer_pct`, `.nbu_pct`, `.bvg_pct` | gleichnamige Spalten | in Prozent (z. B. `10.58`); **nur bei `standard: false` befüllt, sonst `null`**; `null` auch, wenn die Zeile keinen Wert hat. Den Quellensteuer-**Tarifcode** kennt das ERP nicht (beim Bestätigen erfassen). |
| `.ansatz_art` | — | **immer `inkl_ferien`**: Das ERP führt `hourly_wage_chf` immer inklusive Ferienzuschlag (Verträge «26.00 inkl. 8,33 % Ferien»). Der Rechenkern liest jede Zeile so (`src/lib/lohn/daten.ts`, `lohnzeileAusRoh` → `stundenlohnArt: "inkl_ferien"`) und rechnet Basislohn = Ansatz / (1 + Ferien-%), Ferien-% = `ferien_pct` der Zeile oder nach Alter (8,33 % bzw. 10,64 % bis 20). Eine Zeile mit Basislohn gibt es im ERP nicht; ein Unit-Test bindet den Wert an den Kern. |
| `.ferien_pct` | `ferienanteil_pct_override` | festes Ferien-% dieser Zeile laut Vertrag (z. B. `8.33`), **unabhängig von `standard`**; `null` = Ferien-% nach Alter |

**Nicht geliefert** (bewusst): AHV-Nr., IBAN, Adresse, Konfession, E-Mail, Telefon, AHV/IV/EO-, ALV-, KTG-Sätze,
alle Arbeitgebersätze, Pensum, ruhend/befristet, Notizen, Ersteller.

## 3. Fehler

Körper immer `{ "success": false, "code": "…", "error": "…" }` (Wartung zusätzlich `message`, `bereich: "lohn"`).

| HTTP | `code` | Wann | Ausweis verbraucht? |
|---|---|---|---|
| 401 | `ausweis_ungueltig` | Signatur, Aussteller, `aud`, Zeit, gemeinsame Felder (`firma`, `aal`, `geraet`, UUIDs) — ohne Details | nein |
| 409 | `ausweis_verwendet` | `jti` schon verwendet → neuen Ausweis ausstellen | — |
| 429 | `zu_viele` + `Retry-After` (s) | Gruppe «Abruf»: `/stempel`, `/personen`, `/vergleich` und `/stammdaten` **zusammen** höchstens 10 je Minute | nein |
| 400 | `profile_fehlen` / `profile_zu_viele` / `profile_ungueltig` / `profile_doppelt` | Claim `profile` leer/fehlt, > 50, keine UUID, doppelt | ja (Protokoll «abgelehnt») |
| 413 | `zu_gross` | Körper > 16 000 Zeichen | nein |
| 503 | `nicht_eingerichtet` | `FLOW_ABRUF_PUBLIC_KEY` fehlt (nie offen) | nein |
| 503 | `wartung` | Bereich «lohn» in Wartung | nein |
| 500 | `fehler` | unerwarteter Fehler (ohne Details) | ja (Protokoll «fehler») |

## 4. Protokoll im ERP

Je Aufruf mit gültigem Ausweis eine Zeile in `flow_abrufe`: `aud` `flow-stammdaten`, Gruppe `abruf`, `sub`,
`angefragt` (Anzahl IDs), `geliefert` (Anzahl Personen), Status, sha256 der Antwort, `iat`/`exp`; `jahr`/`monat` leer.
**Nie Personendaten.** Erst protokollieren, dann liefern.

## 5. Mitgeändert: `POST /api/flow/personen` (A1, `aud` `erp-personen`)

`{ "personen": [ { "erp_profil_id", "name", "aktiv" } ] }` — wie bisher alle **aktiven** internen Profile, dazu
**inaktive** interne Profile mit einer ERP-Anstellung (`lohn_anstellungen`), deren `austritt` leer oder ≥ `2026-12-01` ist
(`aktiv: false`). Bisherige Felder und Sortierung (nach Name) unverändert; `aktiv` ist neu und steht hinten.
