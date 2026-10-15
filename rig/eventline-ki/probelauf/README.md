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

**Hauptmodell messen (E2.4, Masterplan §6, seit Build `20261011-2326`, `--entladen-alle` seit `20261012-0023`):** ohne diese Schalter läuft alles wie bisher
(`chat_json` auf `KI_OLLAMA_URL`). Mit einem davon gehen die Sprachmodell-Aufrufe gestreamt (`chat_stream` mit `format`,
wie der Planer) an die gewählte Instanz; Einbettungen bleiben immer auf `schnell`, die GPU-Schleuse wird nie genommen.

```bash
# Gemma 4 26B auf «gruendlich» (Prozessor), Bilder wie heute an gemma3:4b auf der GPU, ohne Denkmodus
$C exec dienst python /probelauf/probelauf.py --freigabe 02_LOCATIONS 03_PROJEKTE_EVENTS 05_VERKAUF_MARKETING \
    08_SICHERHEIT_ASA 04_PARTNER --je-ordner 5 --seed 42 --max-dateien 14 \
    --modell gemma4:26b-a4b-it-qat --ollama-url http://ollama-gruendlich:11434 --bild-schnell --entladen-alle 3 \
    --use-mmap 0 --num-gpu 0 --num-thread 10 --num-ctx 16384
# zweiter Teil derselben Auswahl (geteilte Messung; Zähler der Reports addieren): --max-dateien 80 --ab 14
```

| Schalter | Wirkung |
|---|---|
| `--ollama-url` | Text- und Bild-Aufrufe an diese Instanz (z. B. `http://ollama-gruendlich:11434`) |
| `--modell-bild` | Bildmodell; mit `--ollama-url` Standard = `--modell` (sonst lüde «gruendlich» je Bild um) |
| `--bild-schnell` | Aufrufe mit Bild wie heute an `KI_MODELL_BILD` auf der GPU (Grund: Gemma 4 26B mit Bild bei `num_ctx` 16384 sprengte am 11.10. `mem_limit` 19g → OOM des Runners) |
| `--think`, `--denk-tokens` (2048) | Denkmodus; `num_predict` wird um `--denk-tokens` erhöht (Denken zählt mit). Denk-Text nie gespeichert, nur gezählt |
| `--use-mmap`, `--num-gpu`, `--num-thread`, `--num-ctx` | Ollama-Optionen wie der Planer (0 / 0 / 10 nachts, 6 tags / 16384) |
| `--keep-alive` (15m), `--timeout-s` (600) | wie der Planer bzw. `KI_HG_SCHRITT_MAX_S` |
| `--ab N` | die ersten N Dateien je Freigabe überspringen (zweiter Teil einer geteilten Messung) |
| `--entladen-alle N` | mit `--ollama-url`: Sprachmodell nach je N Dateien entladen. Grund: der Prompt-Cache von `llama-server` (Ollama 0.35.1 startet ihn mit 8192 MiB, ~0,45 GiB je Prompt, wegen Gemma-SWA ohne Nutzen über Dateien hinweg) trieb «gruendlich» am 11.10. zweimal über `mem_limit` 19g → OOM des Runners. E2.4 lief mit 3 |

Der Report trägt dann `hauptmodell` (Einstellungen, `fehl_aufrufe` nur als Zähler: Stufe, Grund, Denk-/Antwort-Tokens) und
`modell_zaehler.je_stufe_ohne_bild` (Zeiten nur des Hauptmodells). Ergebnisse: `../README.md` «Messung E2.4».

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

## Messnacht 15./16.10.2026 — Beschrieb + Fristen: gemma3:4b gegen Gemma 4 26B

Gemessen werden nur die zwei Aufgaben, die die lokale KI seit dem 15.10. hat (die Ordnerwahl macht Claude im FSM):
ausführlicher, gefilterter **Beschrieb** (`jobs/zz.zz_beschreiben`, ganzes Dokument in Teilen zu 10 000 Zeichen) und
**Fristen** aus allen Teilen (`jobs/fristen.fristen_pruefen`). Skript `beschrieb_fristen_vergleich.py`: eigener
Messprozess im Dienst-Container, Live-Code-Pfad unverändert, umgeschaltet wird nur das Sprachmodell bzw. die Instanz
(«gruendlich» gestreamt und abbrechbar wie der Planer: `use_mmap false`, `num_gpu 0`, `num_thread 10`, `num_ctx 16384`,
ohne Denkmodus — gleicher Prompt-Text). Nichts geht ans FSM, nichts in die Nachtarbeit-Tabellen; Ausgaben nur Zahlen und
gefilterte Beschriebe im Tresor (`data/dienst/probelauf/messnacht-2026-10-15/`), nie Dokumenttext.

```bash
D="docker exec eventline-ki-dienst python /probelauf/beschrieb_fristen_vergleich.py"
$D auswahl                                    # feste Stichprobe (Seed 20261015, geschichtet), Kontext eingefroren
$D lauf --name g3 --modell gemma3:4b          # Live-Weg auf «ollama» (GPU)
G=$(docker inspect -f '{{.Id}}' eventline-ki-ollama-gruendlich); S=$(docker inspect -f '{{.Id}}' eventline-ki-ollama)
docker exec -d eventline-ki-dienst sh -c "python /probelauf/beschrieb_fristen_vergleich.py lauf --name g4 \
    --modell gemma4:26b-a4b-it-qat --gruendlich --gruendlich-id $G --schnell-id $S \
    >> /data/probelauf/messnacht-2026-10-15/g4.log 2>&1"  # fortsetzbar: fertige Dokumente werden übersprungen
$D auswerten                                  # bericht.json/.md, Blind-Paare blind/paare.jsonl + schluessel.json
$D paare                                      # gefilterte Beschriebe A/B + Dateiname → Urteile in blind/urteile.json
$D urteil
```

Betrieb: vor jedem Dokument und zwischen den Teilen Vorrang für EVENTLINE (Warteschlange, laufender Auftrag, Nachtarbeit,
Tiefen-/Vorbilder-Index → warten, 20 s Ruhe), Sperrfenster 05:25–05:50 (Selbsttest). Hauptmodell: Speicher-Tor (Bedarf
17 GB, Puffer 2 GB) 60 s offen; Wächter alle 2 s strenger als der Planer (MemAvailable < 3 GiB, Slice-Luft < 1,5 GiB, PSI
full > 10, Slice-Swap +256 MiB, anon «gruendlich» > 18 GiB) → trennen, entladen, 10 min Pause, Dokument wiederholen;
Entladen, sobald anon 1,5 GiB über dem Stand nach dem Laden liegt (Prompt-Cache, E2.4).

**Stichprobe:** 40 von 395 Dokumenten mit Text (14 Fristen-Kandidaten, 6 lange mit 2–22 Teilen, 5 Scans, 4 Personal,
3 Rechnungen, 4 Locations, 4 Rest) = 80 Teile, 21 mit Fristen-Vorfilter, 18 aus ZZ, 9 OCR. gemma3:4b 15.10.
18:41–18:48, Gemma 4 26B 18:49 (1 Dokument, Pause) und 19:01–23:09. Beide 40/40 ohne Fehler.

| | gemma3:4b (GPU) | Gemma 4 26B (Prozessor) |
|---|---:|---:|
| Beschrieb je Dokument, Median / P90 / Max | 4,2 s / 11 s / 97 s | 92 s / 317 s / 52,5 min |
| je Seite (Median, 25 PDF) · je Teil (Median) | 1,8 s · 4,1 s | 39 s · 92 s |
| Fristen je Dokument mit Vorfilter, Median / Max | 2,0 s / 3,6 s | 41 s / 111 s |
| Dokument gesamt (Beschrieb + Fristen), Median | 5,9 s | 112 s |
| Modellzeit 40 Dokumente | 6,8 min | 3 h 5 min, dazu 56 min Pausen (Wächter, Tor) |
| Tokens/s Prompt / Antwort | 5677 / 98 | 46 / 7,7 |
| Laden | warm | 14 × ~44 s (13 × entladen: 8 Cache, 5 Wächter) |
| Speicher | VRAM ≥ 3,1 GB frei; Prompt-Cache 8,7 GiB RAM in «ollama» | anon 16,7 (Median) bis 18,0 GiB, Slice bis 20,8 von 22 GiB |
| Abbrüche | 0 | 5 Wächter «Slice-Luft < 1,5 GiB», alle wiederholt; 0 OOM; kein Swap |
| Vollständigkeit (Art, Unterart, Zweck, Beteiligte, Bezug/Status, Datum/Zeitraum) | 5,20 von 6 | 5,65 von 6 |
| Erfindungsquote roh (vor dem Filter, gegen Text/Dateiname/Ablageort) | 32,7 % — Namen 21 % | 16,0 % — Namen 1,7 % |
| Sensibel-Filter musste eingreifen | 10 × (7,5 % der Teile) | 3 × (2,5 %) |
| Fristen roh / angenommen / erfunden verworfen | 23 / 4 / 14 | 13 / 4 / 0 (5 unvollständig) |
| Blind-Urteil «nützlicher für Ordner-/Namenswahl» (40 Paare) | 2 (5 %) | **36 (90 %)**, 2 gleich |

- **Unbelegt vor dem Filter** (der Filter entfernt es, im Ergebnis steht davon nichts): Datum 50/80 (4b) und 42/76 (26B),
  Status 58/67 und 44/77, Namen 80/379 und 6/344 (streng, ganzer Name wörtlich: 26 % / 4 %).
- **4b kopiert Beispiele aus dem Prompt:** «Verwaltungsvertrag Location» 7×, «Dieser Vertrag …» 9×, «zu Veranstaltung X» 2×,
  «Verein EVENTLINE 2025» 2×, «Beilage zum Arbeitsvertrag» 1×, EVENTLINE als «Arbeitgeber» 22× (26B: 6×). Typ-Feld:
  4b setzt 20/40 «vertrag» (auch Tarifblatt, Konzepte, Strategiepapier, Handelsregisteranmeldung), 26B 23/40 «sonstiges»
  und trägt die Art in dokumentart/unterart; Übereinstimmung beim Typ nur 25 %, bei der Dokumentart 50 %.
  `personenbezogen`: 4b 16/40 (oft falsch, z. B. Partnerschaftsvertrag, Statuten), 26B 8/40.
- **Fristen:** gleich viele angenommen (4/4), das 26B ohne Erfindungen (4b: 14 von 23 roh verworfen). In den 2 Dokumenten,
  in denen beide eine Frist fanden, sind End-/Fälligkeitsdatum und Kündigungsfrist gleich, nur die Art unterscheidet sich
  (4b «Kündigung»/«Ablauf», 26B «Vertragsende»); je 2 Dokumente nur bei einem Modell. Von Menschen bestätigte Fristen gab
  es keine (FSM: 6 KI-Vorschläge, alle offen) — kein Abgleich möglich.
- **Speicher:** Ursache der 5 Wächter-Pausen war das 26B selbst (anon 17,0–17,7 GiB + übrige KI ~3 GiB = 20,5–20,7 GiB
  nicht rückgewinnbar); «ollama» lag dabei unter 0,4 GiB. Mit dem Planer-Puffer 3 GB wäre das Tor nie aufgegangen
  (gemessen mit 2 GB). Slice-Swap unverändert 0,61 GiB, MemAvailable ≥ 11,5 GiB, PSI memory full ≤ 1,2, Trust one
  12,3–14,7 GiB mit unverändertem Swap. Nach dem 4b-Lauf hielt «ollama» 8,7 GiB Prompt-Cache bis zum Entladen; seit Build
  20261015-2318 läuft «ollama» mit `LLAMA_ARG_CACHE_RAM=0` (wirkt, `../README.md` «Speicher der GPU-Instanz: Prompt-Cache
  aus»), «gruendlich» noch ohne.
- **Filter-Lücke:** eine Strassenadresse mit Bindestrich-Namen («…-Strasse 6») kam in einem 4b-Beschrieb als «Beteiligter»
  durch `ablageregeln._INHALT` (die Strassen-Regel verlangt Buchstaben direkt vor «strasse»).

**Empfehlung:** Gemma 4 26B als nächtlicher «zweiter Blick» für den Beschrieb (und die Fristen) neuer Dokumente — ja, unter
Bedingungen. Der Beschrieb ist seit dem 15.10. die Grundlage für Claudes Ordner- und Namenswahl, und dort ist das 26B klar
besser (blind 36:2, kaum erfundene Namen, keine kopierten Prompt-Beispiele, keine «Verwaltungsvertrag Location»-Etiketten —
das Muster hinter dem SCALA-Sammelbecken vom 14.10.). Kosten: ~2 min je normales Dokument statt 6 s, 10–50 min für lange
(9 Teile 33 min, 22 Teile 53 min), 45 s Laden je Sitzung; 20 neue Dokumente ≈ 40 min je Nacht, der ZZ-Rückstau (282) ≈ zwei
Nächte. Bedingungen: Prompt-Cache auch auf «gruendlich» abschalten (`LLAMA_ARG_CACHE_RAM=0` wie auf «ollama»; danach anon messen) oder
nach ≤ 3 Aufrufen entladen; Puffer/Tor nachts auf 2 GB
(sonst lädt es nie) und die Wächter-Grenzen des Planers beibehalten; Dokumente mit mehr als 5 Teilen (0,5 % des Bestands)
beim 4b lassen oder auf mehrere Nächte verteilen; der Sofort-Beschrieb für Wartende bleibt beim 4b.
