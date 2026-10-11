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

**V8-Export** (Messung des Claude-Entscheids): `--export /data/probelauf/<lauf>/export.jsonl` schreibt je Testdatei
eine JSON-Zeile `{ freigabe, soll, variante, einordnung, kandidaten, regel_ordner, lokal: { ordner, alternativen }, ms }`
(bei Fehler `{ freigabe, soll, variante, fehler: true, ms }`) — **nie** Beschrieb, Zusammenfassung, Text, Dateiname
oder Pfad der Testdatei. `--namen-alle-datei <datei>` (ein Profilname je Zeile) füllt `kontext.namen_alle` für die
Minimierung; die Mitarbeiterliste (Personen-Auswahl, Prompt) bleibt davon unberührt. Export nach der Übernahme im
Tresor löschen. Report und Konsole zeigen zusätzlich `v8`: Ziel unter den Kandidaten, Kandidat 1, regel_ordner
(richtig), Abdeckung der Einordnungsfelder.

**Produktionsgleich messen (Review V8, 2026-10-11):** `--ordner-datei <datei>` (JSON `{"ordner": [...]}`, Liste oder
Text je Zeile) = Ordnerliste, die das FSM wirklich schickt (aktive Ordner, Vererbung angewandt — dieselbe Filterlogik
wie `ladeAblageKontext` in `src/app/api/ki/sync/route.ts`). Dann werden Testdateien **nur aus Ordnern dieser Liste**
gezogen (sonst gäbe es kein erreichbares Soll); die NAS-Liste (Standard) enthält auch Ordner, die das FSM gar nicht
anbietet. Der Kontext trägt wie im FSM das Flag `person` je Dokumenttyp (lohnabrechnung, behoerde, zertifikat) —
ohne Flag setzte das Rig bei jedem Typ eine Person. Report und Konsole zeigen die Modell-Zähler **je Stufe**
(`modell_zaehler.je_stufe`: Aufrufe, Median Prompt-/Antwort-Tokens, Prompt-/Antwort-/Aufruf-ms) — V8 verlängert nur die
Ausgabe von Stufe 1, ein gemischter Median zeigt das nicht. `v8.profilname_in_was_betreff` zählt Einordnungen mit
«[Mitarbeiter/in]» in `was`/`betreff`.

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
**Achtung: diese Werte sind zu optimistisch** (Fast-Zwillinge im selben Ordner nicht ausgeschlossen).

**Gültige Referenz seit der Nachmessung 2026-10-11** (Build `20261011-1215`, Seed 42, 126 Dateien,
Zwillinge ausgeschlossen = Kosinus > 0,95 oder gleicher Namensstamm im selben Ordner):
Top-1 **55 %**, Top-3 **79 %**, Kategorie 96 %; mit `--dateiname-neutral` (roher Upload-Name) Top-1 **44 %**,
Top-3 **64 %**, Kategorie 83 %. Reports `/data/probelauf/review-20261011-seed42-ohne-zwillinge` und
`…-ohne-zwillinge-neutral` (im Dienst-Container). Künftige Messungen immer mit beiden Varianten berichten;
`--ordner-datei <export>` misst gegen die FSM-Ordnerliste statt gegen die NAS-Ordner. Achtung: diese Referenz lief
gegen die NAS-Liste (421 Pfade); das FSM bot am 2026-10-11 nur 363 aktive Ordner an (davon 2 von 63 in
03_PROJEKTE_EVENTS) — produktionsgleiche Werte: `../README.md` «V8 Rig-Seite».
