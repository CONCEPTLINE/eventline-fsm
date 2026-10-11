# Probelauf — Trefferquote der Ablage-KI gegen das sortierte NAS (live-nah)

Misst, wie gut die lokale KI Dokumente in die bestehende Ordnerstruktur einsortieren
würde. Es wird nichts verschoben und nichts ans FSM gemeldet; die Dateien werden nur
gelesen (NAS ist read-only gemountet).

**Live-nah** heisst seit 2026-10-04 der Standard:
- Kontext = Ordnerliste **aller** aktiven Freigaben (wie sie das FSM schickt, `--ordner-von`
  ist standardmässig `/mnt/eventline-nas`; `ZZ_*` und `99_System` fallen weg);
- **Leave-one-out**: die Testdatei selbst und jede Datei mit gleichem sha256 sind beim Messen
  kein Vorbild im Archiv-Index (`ablage_analyse(..., ohne_vorbilder=…)`).

```bash
cd /srv/eventline-ki/repo/eventline-ki
C="docker compose --env-file /etc/eventline-ki/env -f docker-compose.yml"

# Referenzlauf (Seed 42, je Ordner 5, höchstens 80 je Freigabe)
$C exec dienst python /probelauf/probelauf.py --je-ordner 5 --max-dateien 80 \
    --freigabe 02_LOCATIONS 03_PROJEKTE_EVENTS 05_VERKAUF_MARKETING 08_SICHERHEIT_ASA 04_PARTNER

# anderes Sprachmodell für Texte (Bilder bleiben beim Bildmodell)
$C exec dienst python /probelauf/probelauf.py --freigabe 03_PROJEKTE_EVENTS --je-ordner 5 --modell qwen3:8b

# frischer Upload simulieren: statt des einsortierten Namens «dokument.<endung>»
$C exec dienst python /probelauf/probelauf.py --freigabe 03_PROJEKTE_EVENTS --je-ordner 5 --dateiname-neutral

# Personalakten-Regel prüfen: Mitarbeiterliste wie im FSM (ein voller Name je Zeile)
$C exec dienst python /probelauf/probelauf.py --freigabe 06_PERSONAL --je-ordner 5 --mitarbeiter-datei /pfad/namen.txt
```

Weitere Schalter: `--index-aufbauen` (vorher ein Indexlauf über das NAS, Dauer im Report),
`--ohne-archiv` (nur Regeln + Ordnernamen), `--nur <Präfix>` (Teilbaum einer Freigabe).

Der Report liegt danach unter `/srv/eventline-ki/data/dienst/probelauf/<Zeit>/` (`report.json`,
`report.md`) — **nur Kennzahlen**, je Freigabe und gesamt: Top-1 (Hauptvorschlag exakt), Top-3
(Ziel im Hauptvorschlag oder in `ordner_alternativen`), Kategorie (Freigabe + erste Ebene richtig),
leer, Fehler, Dauer (Median/Max), Herkunft des Entscheids (Regel, KI unter Kandidaten, KI «keiner»,
Rangliste bei Modellfehler), die Rangliste ohne KI (Top-1/3/5 — was Regeln + Vorbilder + Ordnernamen
allein schaffen) und welchen Rang das Modell gewählt hat. Je Ordner nur Zähler; keine Dateinamen,
keine Inhalte. Auf der Konsole erscheinen nur die Kennzahlen je Freigabe und gesamt.
`--ausfuehrlich` (relative Pfade je Datei auf der Konsole) bleibt für Messungen tabu.

Modell vergleichen ohne Umstellung des Dienstes: `--modell`. Gleicher `--seed` = gleiche
Dateiauswahl je Freigabe (wie vor 2026-10-04, damit die Zahlen vergleichbar bleiben). Achtung: bei
`--je-ordner 5` haben kaum Ordner mehr Dateien — Seed 42 und Seed 7 wählen fast dieselben Dateien, die
Abweichung zwischen zwei Läufen zeigt dann vor allem die Streuung des Modells.

**Referenzläufe Produktion 2026-10-11** (Produktionspfad, Build `20261011-1048`, Seed 42 und 7, je 126
Dateien): Top-1 60 % / 59 %, Top-3 80 % / 81 %, Kategorie 96 %, 0 Fehler, Median 5,1 / 4,8 s — Tabelle
je Freigabe in `../README.md` «Ordnerwahl»; Reports unter
`/srv/eventline-ki/data/dienst/probelauf/prod-20261011-seed42` und `…-seed7`.
