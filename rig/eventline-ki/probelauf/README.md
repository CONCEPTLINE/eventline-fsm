# Probelauf (Phase 1) — Trefferquote gegen das sortierte NAS

Misst, wie gut die lokale KI Dokumente in die bestehende Ordnerstruktur
einsortieren würde. Es wird nichts verschoben und nichts ans FSM gemeldet;
die Dateien werden nur gelesen (NAS ist read-only gemountet).

**Voraussetzung:** NAS-Mount `/mnt/eventline-nas/<Freigabe>` auf dem Rig
(Zugangsdaten noch offen, siehe SPEC §2.1) und laufender Stack.

```bash
cd /srv/eventline-ki/repo/eventline-ki
C="docker compose --env-file /etc/eventline-ki/env -f docker-compose.yml"

# 3 Dateien je Ordner, ganze Freigabe
$C exec dienst python /probelauf/probelauf.py --freigabe <Freigabe> --je-ordner 3

# nur ein Teilbaum, Mitarbeiternamen wie im FSM (für das Feld «person»)
$C exec dienst python /probelauf/probelauf.py --freigabe <Freigabe> --nur 03_PERSONAL \
    --mitarbeiter "Vorname Nachname,Vorname Nachname"
```

Der Report liegt danach unter `/srv/eventline-ki/data/dienst/probelauf/<Zeit>/`
(`report.json`, `report.md`) — **nur Kennzahlen**: Trefferquote je Ordner
(exakt / oberste Ebene), Dauer (Median, Mittel, Max), OCR-Anteil, erkannte
Typen, Fehlerarten, Modell. Keine Dateinamen, keine Inhalte. Mit
`--ausfuehrlich` erscheinen die relativen Pfade nur auf der Konsole.

Modell vergleichen: `KI_MODELL_TEXT` in `/etc/eventline-ki/env` ändern, Modell
laden (`$C --profile modelle run --rm ollama-modelle`), `$C up -d dienst`,
Probelauf wiederholen — gleicher `--seed` = gleiche Dateiauswahl.
