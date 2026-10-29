# Live-Gang Wartungsmodus (Migration 363)

Wunsch Mischa, 29.10.2026. Branch `lohn`. **Standard = aus** — nach dem Live-Gang ändert sich für
niemanden etwas, bis jemand einen Bereich einschaltet.

> **Nummer beim Zusammenführen prüfen:** höchste Nummer auf `origin/main` UND allen Branches + 1
> (Stand 29.10.2026: 362 auf main, 359 auf lena-telefon). Bei Umnummerierung auch die Verweise
> «Migration 363» in Code und Skript anpassen.

## Was dazukommt

| Teil | Wo |
|---|---|
| Tabelle `public.wartung` (eine Zeile: Bereiche, Grund, seit, Ausnahmen), nur Server | Migration 363 |
| `wartung_setzen()` / `wartung_ausnahmen_setzen()` (nur service_role), protokolliert im Rechte-Protokoll (`wartung.an`, `wartung.aus`, `wartung.ausnahmen`) | Migration 363 |
| `lohn_lauf.status` kennt `pausiert` | Migration 363 |
| Prüfung zentral: `src/lib/wartung.ts` (Regeln, 10 s Cache), `src/lib/wartung-server.ts` (Laden, 503) | Code |
| API: `requirePermission` (lohn:manage → Lohn, finanzen:view → Finanzen, gilt auch für `requireTrustedDevice`/`requireFinanzen`); `requireUser/requireInternal/requireAdmin({ wartung })` für «Meine Lohndokumente», Rechte-Routen, Gerätefreigabe | `src/lib/api-auth.ts` |
| Seiten: `layout.tsx` von `/lohn`, `/finanzen`, `/geraet-freigabe`; Kontext in `/einstellungen` (Tabs Mitarbeiter, Rollen, Partner-/Lieferanten-Zugänge), `/antraege` (Reiter Rechte & Lohndaten; `/rechte-antraege` leitet seit 29.10. dorthin um) und `/sicherheit` (Tab Vertraute Geräte) | `src/components/wartung/` |
| Cron `auto-lohnabrechnung` pausiert (`lohn_lauf`: «pausiert (Wartung)») | Cron-Route |
| Schalter: Einstellungen › Sicherheit › «Wartung (Umbauten)»; Skript `scripts/wartung.mjs` | — |

## Reihenfolge

1. **Migration 363 VOR dem Code einspielen** (der Code liest `public.wartung`; ohne Tabelle läuft der
   Lohn-Cron absichtlich NICHT — er bricht mit 500 ab, statt im Zweifel zu laufen. Seiten und Routen
   behandeln eine fehlende Tabelle als «keine Wartung»).
   Einspielen wie gewohnt über die Management-API (`scripts/apply-migration.mjs` aus einem Ordner,
   dessen `.env.local` auf Live zeigt — **nicht** aus `eventline-fsm-lohn`, dort zeigt sie auf lokal).
2. Prüfen: `node scripts/wartung.mjs status` → «aus (kein Bereich in Wartung)», «Ausnahmen: keine».
3. Ausnahme(n) setzen — wer trotz Wartung arbeiten darf (Mischas Login-Mail bzw. Profil-ID):
   `node scripts/wartung.mjs ausnahmen <mischas-login-mail>` → Status zeigt den Namen.
4. Code deployen. Danach `/api/version` = neuer SHA.
5. Rauchtest (kurz, wenig Betroffene): `node scripts/wartung.mjs an finanzen --grund "Test Live-Gang"`,
   nach 10 s als Ausnahme `/finanzen` öffnen → Balken «Wartung aktiv»; als anderer Admin → Hinweisseite.
   Dann `node scripts/wartung.mjs aus` → Status «aus». Rechte-Protokoll zeigt beide Einträge.

## Bedienung

```bash
node scripts/wartung.mjs status
node scripts/wartung.mjs an lohn rechte --grund "Lohn-Umbau Phase 2"   # oder: an alle
node scripts/wartung.mjs aus lohn                                    # ohne Bereich = alle aus
node scripts/wartung.mjs ausnahmen mischa@… [weitere …]              # ersetzt die Liste; --keine leert sie
# … --lokal für die Testumgebung, --durch "Name" für das Protokoll
```

- Ziel ist fest Live `uxtotpniwbwyoznwkygd` (Management-API, Token aus `SUPABASE_ACCESS_TOKEN` bzw.
  `_secrets\supabase-access-token.txt`). Umlaute im Grund: aus PowerShell aufrufen (Git Bash kann sie
  verstümmeln; das Skript bricht dann ab).
- In der App: Einstellungen › Sicherheit › «Wartung (Umbauten)» — Schalter je Bereich mit Bestätigung,
  nur Admins auf einem vertrauten Gerät (nicht in «Ansicht als»). Grund und Ausnahmen nur per Skript.
- Wirkung: nach spätestens 10 s überall (Cache je Server-Instanz); wer in der App schaltet, sieht es sofort.

## Bereiche

| Bereich | Seiten / Tabs → Hinweis | Routen → 503 |
|---|---|---|
| Lohn | `/lohn` (Meine + Team) | alle mit `lohn:manage` (Lohndokumente, Monatsstunden, Generieren, Lohn-Editor, Standardwerte, Lauf-Status, Stundensätze, Job-Kosten, BVG-Prognose, Dossier), eigene Lohndokumente + Digital-Einwilligung; Cron pausiert |
| Rechte | Anträge › Rechte & Lohndaten (`/antraege?tab=rechte`); Einstellungen › Mitarbeiter, Rollen, Partner-/Lieferanten-Zugänge | `/api/admin/users/**` (ohne Dossier = Lohn), `/api/admin/roles/**`, `/api/admin/rechte-antraege` (inkl. `/zaehler`), Partner-/Lieferanten-Konten anlegen |
| Geräte | `/geraet-freigabe`; Sicherheit › Vertraute Geräte | `/api/trust/freigabe`, neue Geräte-Anfrage (`POST /api/trust/devices`). Widerrufen und die Gerätesperre selbst laufen weiter |
| Finanzen | `/finanzen` | alle mit `finanzen:view` |

Bewusst nicht in Wartung: `/api/wartung` selbst (Ausschalten geht immer), Lesen der Vertretung
(`GET /api/hr/lohn-einstellungen`, ändern ist Lohn), Finanzen-Sync-Cron, Abrechnung (`/abrechnung`).
Wer ein Recht gar nicht hat, bekommt weiter 403 (kein 503) — Job-Kosten/BVG-Ampel bleiben dort still.
Wer Lohnrecht hat, sieht während «Lohn» in Wartung auf Projekt- und Kalenderseiten einen Toast mit der
Meldung (Stundensätze bzw. BVG-Prognose laden dort über Lohn-Routen); die Seiten selbst laufen weiter.

## Rückweg

- Code zurücksetzen genügt; Tabelle und Funktionen sind additiv und stören alten Code nicht.
- Vorher `node scripts/wartung.mjs aus`, damit nach einem späteren Wieder-Deploy nichts überrascht.
- Die Status-Erweiterung `pausiert` und die Protokoll-Aktionen `wartung.*` bleiben stehen
  (bestehende Einträge würden sonst die alten Prüfregeln verletzen).

## Lokal geprüft (29.10.2026)

`bash supabase/lokal/aufbauen.sh` (363 spielt sauber ein, auch zweimal hintereinander) →
`node supabase/lokal/pruefen-phase1.mjs` 208/208 OK → `node supabase/lokal/pruefen-wartung.mjs` 100/100 OK
(Seiten-Hinweis, 503 je Bereich, Cron pausiert, Ausnahme arbeitet, App-Schalter, Protokoll, aus = wie vorher).
