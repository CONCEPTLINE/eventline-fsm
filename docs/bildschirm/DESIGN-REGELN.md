# Büro-Bildschirm — Grund-Designregeln

Gilt für **jede Ansicht** des Wand-Bildschirms (`/bildschirm/dashboard`): heute
**Firma** (Mischa, Oktober 2026) und **Vertrieb** (Leo, 30.10.2026), und für jede
künftige Ansicht. Beschlossen von Leo am 30.10.2026. Vorbild ist das Firmen-Board.
Wer eine Ansicht baut oder ändert, liest diese Datei zuerst.

Dateien: `src/app/bildschirm/dashboard/` (`page.tsx`, `board.css`,
`vertrieb-ansicht.tsx`, `todos-panel.tsx`, `zuletzt-panel.tsx`, `zeilen-passen.ts`,
`format.ts`), Daten über `src/app/api/bildschirm/*`.

## 1. Grundhaltung

- **Ein Blick genügt.** Der Bildschirm hängt an der Wand und wird aus Distanz
  gelesen. Keine Bedienung, keine Tooltips, keine Klickziele (ausser «Bildschirm trennen»).
- **Ruhig statt laut.** Wenig Elemente, viel Luft, klare Hierarchie. Lieber ein
  Panel weniger als ein überladenes.
- **Gleiche Bedeutung = gleiche Darstellung** über alle Ansichten. Eine neue
  Ansicht nutzt die bestehenden Klassen und ergänzt nur, was fehlt.

## 2. Aufbau (fest)

- **Kopf:** Logo links · Datum mittig, darunter der Ansichts-Umschalter
  («Firma · Vertrieb» mit rotem Fortschrittsbalken) · Uhr rechts mit «live»-Punkt.
- **Mitte:** zwei Spalten **58 : 42**.
  - **Links:** oben das Hauptelement (füllt den Platz: Agenda oder grosses
    Diagramm), unten ein niedriges Panel (Wochen-Balken oder Kampagnen).
  - **Rechts:** oben «Zuletzt …» (fest 3 Zeilen), Mitte eine Liste, die den Rest
    füllt, unten **«Braucht Aufmerksamkeit»** (immer an derselben Stelle).
- **Wechsel:** jede Ansicht steht **2 Minuten**, dann ein weicher Übergang
  (alte Ansicht unscharf ausblenden, Panels der neuen gestaffelt von unten).
  Ohne Inhalt für eine Ansicht (z. B. keine laufende Kampagne) bleibt die
  Firmen-Ansicht stehen.

## 3. Farben — nur mit Bedeutung

Immer dunkel, unabhängig vom Theme des Browsers. Tokens in `board.css` (`.board`):

| Token | Wert | Bedeutung |
|---|---|---|
| `--bg` | `#0b0b0c` | Hintergrund |
| `--panel` / `--panel2` | `#141416` / `#1c1c20` | Panel / Fläche im Panel |
| `--border` / `--linie` | `#27272b` / 7 % Weiss | Rahmen / Haarlinie zwischen Zeilen |
| `--text` / `--muted` | `#f3f3f1` / `#8d8d96` | Text / Nebeninfo, Titel |
| `--rot` | `#f53c3a` | **jetzt / dringend / aktuelle Woche**, EVENTLINE-Akzent |
| `--amber` | `#fbbf24` | **wartet / Achtung** (Anfrage, Antwort offen, anrufen) |
| `--gruen` | `#34d399` | **erledigt / positiv** (Antwort erhalten, zugeteilte Personen, «alles gut») |
| `--blau` | `#60a5fa` | **Information** (Hinweise, angeschrieben/geplant in Diagrammen) |

- Keine Deko-Farben, keine Verläufe, kein Leuchten, keine bunten Avatare.
- Farbe nie allein: immer mit Text (Chip-Label, Legende, Zahl).
- Diagramm-Balken neutral `#3f3f48`, nur die aktuelle Woche rot.

## 4. Schrift und Grössen

- **Helvetica** für alles. **Comfortaa** nur für Uhr, Tageszahlen der Agenda,
  grosse Kennzahlen und die Zahl in der Kreismitte.
- **Alle Masse in `em`.** Die Grundgrösse hängt an der Bildschirmbreite
  (`max(10px, min(1vw, 1.78vh))`), damit 1080p und 4K gleich aussehen.
  `px` nur für Haarlinien und 2-px-Lücken.
- Zahlen tabellarisch (`font-variant-numeric: tabular-nums`), damit nichts springt.

## 5. Panels

- Jedes Panel: `.b-panel` (abgerundet, `--panel`, feiner Rahmen).
- Titel `.b-titel`: links **KLEIN, GRAU, VERSALIEN** mit Zeichenabstand, rechts
  die wichtigste Zahl des Panels fett in Weiss (z. B. «12 geplant»,
  «6 im Gespräch»). Kennzahlen gehören in den Titel, nicht in eigene Kacheln.
- Gruppen in Listen mit `.b-monat` (Versalien-Zeile mit Anzahl rechts).

## 6. Listen

- Zeilen mit **Haarlinien**, keine Kästchen pro Zeile.
- Agenda-Zeile (`.b-auftrag`): Datum gross links (Tag + Wochentag), Titel fett
  plus graue Unterzeile, rechts Chips und relative Zeit («heute», «seit 3 Tagen»).
- Dringendes: ganze Zeile rot hinterlegt mit rotem Strich links (`.laeuft`).
- **Nie halb abgeschnitten:** Listen werden gemessen (`useZeilenPassen`) und
  enden mit «+n weitere». Lange Listen rechts laufen als Diashow (Todos).
- Leere Listen sagen etwas Freundliches («Alles im grünen Bereich»,
  «Gerade keine offenen Gespräche»). Beim Laden Skeletons, nie leere Panels.

## 7. Diagramme

- **Ein Diagramm, eine Aussage.** Keine zwei Achsen.
- **Balken** (pro Woche): neutral grau, aktuelle Woche rot, Wert über dem Balken,
  KW und Datum darunter.
- **Kreise:** leere Spur (6 % Weiss) = «noch nicht», Segmente in den
  Bedeutungsfarben, kleine Lücke zwischen Segmenten, Zahl in der Mitte mit
  grauer Versalien-Beschriftung. Ein Kreis hat immer eine **Legende mit Anzahl
  und Prozent** daneben.
- Diagramme bauen sich beim Einblenden auf (Bögen zeichnen, Balken wachsen).

## 8. Bewegung

- Sanft und selten: Ansichtswechsel alle 2 Minuten, Diashow, blinkender
  Doppelpunkt der Uhr, pulsierender «live»-Punkt. Sonst steht alles still.
- `prefers-reduced-motion` wird immer respektiert.

## 9. Datenschutz (Pflicht)

Der Bildschirm ist für alle im Büro sichtbar, auch für Besucher.

- **Keine Geldbeträge**, keine Rechnungsnummern, keine Dokumentnamen.
- **Keine Mailadressen, Ansprechpersonen, Betreffs oder Mailinhalte.** Im
  Vertrieb nur Firmenname, Ort, Status, Zähler und Zeitpunkte.
- Partner-Personen nie mit Namen; interne Personen nur mit Vornamen.
- Daten nur lesend über das Bildschirm-Cookie (`/api/bildschirm/*`), keine App-Session.

## 10. Technik

- Daten alle 30 s still nachladen; neue Builds laden sich selbst (10 Min.).
- Zeit immer `Europe/Zurich`.
- Vertriebsdaten per Keyset-Paginierung laden (nie Offset).
