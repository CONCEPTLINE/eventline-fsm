# Live-Gang Schnittstelle Trust flow (A1 Stunden-Abruf, A5 Lohnabrechnung aus Bexio)

Stand 30.10.2026, Branch `lohn` (auf Phase 4). **Vorbereitet, nicht ausgeführt.** Ausführen: Mischa (bzw. die Hauptsession),
abends, **nach dem Live-Gang Phase 4** (braucht 367: `lauf_bis`, `lohn_nach_lauf_bis`, Zustellung) und **bis 20.11.2026**
(A1; A5 geht im selben Schritt mit, Ziel Mitte Dezember ist damit erfüllt). Nie zwischen dem 5. und 7. eines Monats (Lohnlauf).
Vertrag: `_backoffice-uebergabe/10_Schnittstelle_Stunden.md` (A1), `07_Rueckfragen.md` (A5), Code `src/lib/flow/`, Routen `/api/flow/*`.

Lokal geprüft (30.10.): `pruefen-flow.mjs` 77 (Ausweis, Stempel, Probleme, nachträglich geändert, Einmal-Schutz, Protokoll,
Personen, Vergleich, Wartung, Höchstzahl, Lohnabrechnung aus Bexio, «Meine Lohndokumente», Statusspalte, Lohnlauf-Probe,
503 ohne Schlüssel), alle übrigen `pruefen*.mjs` auf frischen Testdaten, `npm test`, `tsc`, ESLint, `abgleich.mjs`
(0 unerwartete Unterschiede), Rückweg 369 → erneut einspielen → `pruefen-live.mjs nachher|app --lokal` ALLES OK.
Rückfragen an Trust flow beantwortet (07_Rueckfragen.md, 30.10. 01:50) und umgesetzt.

## Was sich auf Live ändert
| Teil | Inhalt |
|---|---|
| `369_flow_schnittstelle.sql` | `flow_abrufe` (Protokoll jedes Aufrufs mit gültigem Ausweis, Einmal-Schutz `jti`, Höchstzahl je Minute: Abruf 10, Ablage 30), `flow_abruf_beginnen/abschliessen`; `wage_documents.source` erlaubt zusätzlich `bexio`; `lohn_fassung_speichern` nimmt die Quelle an (sonst unverändert); `lohn_bexio_fassungen` + `lohn_bexio_fassung_speichern` (nur Lohnmonate nach `lauf_bis` und ab 12/2026). Alles nur Server, RLS an. Ändert keine bestehende Zeile. Idempotent. |
| Code | `POST /api/flow/stempel`, `/personen`, `/vergleich`, `/lohnabrechnung`; Statusspalte Dezember+ «Lohnabrechnung aus Bexio liegt bereit»; Lohndokumente zeigen «aus Bexio übernommen»; Altbestand-Skript überspringt Bexio-Dokumente. |
| Vercel-Env | `FLOW_ABRUF_PUBLIC_KEY` (öffentlicher Schlüssel von Trust flow, **nicht geheim**, kein «sensitive» nötig). Ohne ihn antworten alle `/api/flow/*` mit 503 — nie offen. |

Der Code darf mit dem Phase-4-Deploy mitgehen (er liegt auf demselben Branch): ohne Env-Schlüssel ist die Schnittstelle zu.
**Den Schlüssel erst nach Migration 369 setzen** (sonst 500 statt 503).

## Befehlsfolge (keine Wartung nötig)
| # | Befehl | Erfolg = | Rückweg |
|---|---|---|---|
| 0 | `git fetch --all`; höchste Migrationsnummer auf allen Branches (wie Phase 2, Schritt 0). Stand 30.10.: 368 auf `lohn`, 365/366 auf `origin/vertrieb-kampagnen` | 369 frei — sonst umnummerieren (Datei, Verweise hier, `abgleich.mjs`, Rückweg) | — |
| 1 | `node supabase/lokal/live-gang-flow/pruefen-live.mjs vorher` | `ALLES OK` (Phase 4 live, 369 fehlt, Quelle nur manual/auto) | — |
| 2 | Migration 369 über die Management API (wie Phase 4, Schritt 4; im Worktree zeigt `apply-migration.mjs` auf lokal) | keine Fehlermeldung | `369_rueckweg.sql` |
| 3 | `node supabase/lokal/live-gang-flow/pruefen-live.mjs nachher` | `ALLES OK` | wie 2 |
| 4 | Vercel → Projekt `eventline-fsm-usyk` → Settings → Environment Variables → **Production**: `FLOW_ABRUF_PUBLIC_KEY` = `MCowBQYDK2VwAyEAgYnAq76J/sQiWiQso20hbp7UXhUM1qyAedjEdheA60U=` (aus `06_Aenderungen.md`, 30.10.; vorher dort prüfen, ob Trust flow einen neueren gemeldet hat). Nie `vercel env pull` im Worktree. | Variable gespeichert | Variable löschen |
| 5 | Neu deployen (Env wirkt erst im neuen Build): Push nach CLAUDE.md B1 bzw. «Redeploy» des aktuellen Production-Deploys; `/api/version` = SHA | Vercel fertig | Vercel «Promote» auf den vorherigen Deploy |
| 6 | `node supabase/lokal/live-gang-flow/pruefen-live.mjs app` | alle vier Routen 401 auf einen ungültigen Ausweis (503 = Schlüssel fehlt) | — |
| 7 | Mischa in Trust flow: «Stunden holen» für Oktober 2026 (gesperrt), Personal bearbeiten → ERP-Person aus der Auswahl (Route `/personen`) | Trust flow zeigt die Stempel; im ERP eine Zeile `flow_abrufe` mit Status `ok` (read-only: `select aud, status, geliefert, empfangen_at from flow_abrufe order by empfangen_at desc limit 5`) | — |
| 8 | In `_backoffice-uebergabe/06_Aenderungen.md` eintragen: ERP-Routen live (URL `https://eventline-fsm-usyk.vercel.app/api/flow/…`) | — | — |

## Rückweg
- **Schnell, ohne Datenbank:** `FLOW_ABRUF_PUBLIC_KEY` in Vercel löschen + Redeploy → alle Routen 503, nichts fliesst.
- **Datenbank:** `369_rueckweg.sql` — Funktionen der Schnittstelle weg, `lohn_fassung_speichern` wie 360; Protokoll,
  abgelegte Lohnabrechnungen (Zeilen und PDF) und die erweiterte Quellen-Regel bleiben. Erneut einspielen stellt alles her.
- **Code:** Vercel «Promote» auf den vorherigen Deploy (der Phase-4-Code läuft mit 369; die erweiterte Funktion hat dieselbe Signatur).
- Lokal getestet: `369_rueckweg.sql` → Funktionen weg, Quelle «bexio» abgelehnt → 369 erneut → `pruefen-flow.mjs` ALLES OK.

## Gut zu wissen (Betrieb)
- **Änderung an A1 mit dem A6-Deploy** (`supabase/lokal/live-gang-a6/`): `/personen` liefert zusätzlich inaktive interne
  Profile mit ERP-Anstellung (Austritt offen oder ≥ 2026-12-01) und je Person das Feld `aktiv`.
- **Personen** (Entscheid Backoffice 30.10.): `/stempel` und `/lohnabrechnung` nehmen jedes **interne** ERP-Profil aus dem
  signierten Ausweis — unabhängig von `lohn_anstellungen` und «aktiv» (Anstellungen führt Trust flow; Ausgetretene mit Stempeln
  kommen mit). Partner-/Lieferanten-Zugänge und unbekannte IDs fallen weg bzw. → 422 `person_unbekannt`. Nur `/vergleich`
  (≤ 2026-11) filtert weiter auf eine ERP-Anstellung im Stempel-Bereich.
- Ein Ausweis gilt 60 s und genau einmal (`jti`); Wiederholen mit demselben Ausweis → 409, ein neuer Abruf braucht einen neuen.
- Höchstzahl: 10 Abrufe (Stempel/Personen/Vergleich) bzw. 30 Ablagen (Lohnabrechnungen) je Minute → 429 mit `Retry-After`.
- Wartung «lohn» (`node scripts/wartung.mjs an lohn`) schliesst auch die Schnittstelle (503 mit Hinweis); der Ausweis bleibt unverbraucht.
- `/vergleich` nur bis Lohnmonat 2026-11; `/lohnabrechnung` nur ab 2026-12 und nach `lauf_bis`. Gleiche Fassung + gleiche PDF
  nochmals = «vorhanden» (Wiederholen ist sicher), gleiche Fassung mit anderer PDF bzw. ältere Fassung = 409.
- Protokoll lesen (nur lesend): `flow_abrufe` (wer laut `sub`, Monat, angefragte/gelieferte Personen, sha256 der Antwort),
  Ablagen zusätzlich in `lohn_bexio_fassungen` und `lohn_dokument_protokoll` (Aktion «hochgeladen», Quelle bexio).
