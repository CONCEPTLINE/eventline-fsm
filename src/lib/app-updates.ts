// Zentraler Katalog aller App-Neuerungen — die Datenquelle fuer
// /was-ist-neu (Tabs "Neu" + "Anleitung") und das Login-Popup.
//
// PFLEGE-REGEL (fuer jede kuenftige Session): Wird ein user-sichtbares
// Feature gebaut und gepusht, gehoert HIER ein Eintrag dazu (date = Push-
// Tag). Der "Neu"-Tab zeigt automatisch die Eintraege der letzten 7 Tage;
// das Login-Popup erscheint fuer alle Nicht-Admins, deren
// profiles.updates_seen_at aelter ist als der neueste Eintrag.
//
// KEINE Admin-Interna in diesem Katalog: keine CHF-Saetze, keine
// Lohn-Verwaltung, keine Verrechnungssatz-Pflege, keine Reports —
// die Seite ist fuer ALLE Mitarbeiter sichtbar.

export type UpdateAudience = "alle" | "teamleiter" | "projektleiter";

export interface AppUpdate {
  /** Stabile ID (kebab-case). */
  id: string;
  /** Push-Datum YYYY-MM-DD (Zurich-Kalender). Steuert den "Neu"-Tab (7 Tage). */
  date: string;
  audience: UpdateAudience;
  title: string;
  /** 1-2 Saetze fuer Popup + "Neu"-Tab. */
  summary: string;
  /** Ausfuehrliche Anleitung als Absaetze — der "Anleitung"-Tab. */
  anleitung: string[];
  /** Suchbegriffe (zusaetzlich zu Titel/Text, klein). */
  keywords: string[];
}

export const APP_UPDATES: AppUpdate[] = [
  {
    id: "partner-termin-zeitfenster",
    date: "2026-09-26",
    audience: "alle",
    title: "Partner-Termine: drei Zeitfenster-Arten + Bearbeiten im Portal",
    summary:
      "Partner können ihre Termine jetzt direkt bearbeiten und pro Termin festlegen, wie hart die Zeit ist: fix, nach Absprache verschiebbar oder nur «fertig bis». Verschieben wir einen verschiebbaren Termin, wird der Partner automatisch informiert.",
    anleitung: [
      "Jeder Partner-Termin trägt eine Zeitfenster-Art: «Fixe Zeiten» (muss genau dann stattfinden), «Nach Absprache verschiebbar» (dürfen wir nach Rücksprache mit den Mieter:innen schieben) oder «Fertig bis» (nur Deadline — wir planen frei davor).",
      "Im Auftrag und im Termin-Fenster siehst du die Art als blauen Chip bzw. Hinweis-Kasten. Kein Chip = fixe Zeiten.",
      "Termine lassen sich jetzt auch intern direkt bearbeiten: Stift-Symbol an der Termin-Karte im Auftrag (gleiches Fenster wie im Kalender).",
      "Wichtig bei «Nach Absprache verschiebbar»: Wenn du die Zeit eines solchen Termins änderst, bekommt der Partner automatisch eine Mitteilung mit alt → neu — so entstehen keine Doppelbuchungen. Die Absprache mit den Mieter:innen führst du vorher selbst.",
      "Bei «Fertig bis»-Terminen zählt nur der Endzeitpunkt — die Arbeit kann irgendwann davor erledigt werden, muss aber sicher fertig sein.",
      "Partner können ihre Termine im Portal jetzt auch bearbeiten (Stift-Symbol), solange die Anfrage bei ihnen in Bearbeitung ist.",
    ],
    keywords: ["partner", "termin", "zeitfenster", "verschiebbar", "deadline", "fertig bis", "barakuba", "portal"],
  },
  {
    id: "rapport-mobil-stunden",
    date: "2026-09-26",
    audience: "alle",
    title: "Einsatzrapport: Stunden werden vorgeschlagen, Ausfüllen aufs Handy optimiert",
    summary:
      "Beim Öffnen des Rapports sind die Einsatzzeiten schon ausgefüllt — aus der Stempeluhr oder den zugeteilten Terminen. Auf dem Handy gibt es grosse Felder, Pausen-Chips und «+ Person» / «+ Tag» statt leerer Zeilen.",
    anleitung: [
      "Rapport öffnen — die Einsatzzeiten stehen schon da: pro Person und Tag eine Zeile aus der Stempeluhr (vom ersten Einstempeln bis zum letzten Ausstempeln, Lücken dazwischen als Pause). Gibt es keine Stempel, kommen die Zeiten aus den zugeteilten Terminen.",
      "Vorgeschlagene Zeilen tragen ein blaues «Vorschlag»-Badge — bitte kurz prüfen. Sobald du etwas an der Zeile änderst, verschwindet das Badge.",
      "Die Pause wählst du mit einem Tipp (keine / 15 / 30 / 45 / 60 Minuten), krumme Werte gehen weiter übers Zahlenfeld daneben.",
      "«+ Person» fügt eine Zeile mit gleichem Tag und gleichen Zeiten hinzu (nur den Namen wählen), «+ Tag» springt auf den Folgetag mit gleicher Besetzung — nichts mehr doppelt abtippen.",
      "Niemand da zum Unterschreiben? Bei den Unterschriften «Nicht vor Ort» wählen — der Rapport wird ohne Kundenunterschrift abgeschlossen und im PDF genau so ausgewiesen.",
    ],
    keywords: ["rapport", "einsatzrapport", "stunden", "handy", "mobil", "pause", "stempeluhr", "vorschlag"],
  },
  {
    id: "auftrag-technik-plan",
    date: "2026-09-26",
    audience: "alle",
    title: "Aufträge: neuer Tab «Technik & Plan»",
    summary:
      "Die technische Planung eines Auftrags läuft jetzt in einem Tab: Kundenwünsche, Technikpositionen, Aufbauplan auf dem echten Saalplan — und der Techniklieferant prüft alles direkt im neuen Lieferantenportal.",
    anleitung: [
      "Im Auftrag ersetzt «Technik & Plan» den bisherigen Material-Tab. Links der Technikplan (Positionen aus dem Lieferanten-Katalog oder frei erfasst), rechts Kundenwünsche, Punkte des Lieferanten und Aktivität.",
      "Lieferant zuweisen, Positionen erfassen, «Anfrage senden» — der Lieferant bestätigt im Portal Position für Position, gibt Empfehlungen ab (mit einem Klick übernehmbar), meldet Probleme oder stellt Fragen. Er kann auch sein Angebot als PDF hochladen (Ordner «Angebote»).",
      "Der Aufbauplan (eingeklappte Sektion) zeigt den kalibrierten Saalplan der Location: Positionen platzieren, Objekte setzen, mit «Messen» Distanzen in Metern abgreifen (z.B. Kabellängen), als Bild exportieren.",
      "Ampel an jeder Position: grün = bestätigt, gelb = Empfehlung offen, rot = Problem, blau = Frage. Der Kopf zeigt den Stand («2/4 bestätigt · 1 Frage»).",
    ],
    keywords: ["technik", "plan", "lieferant", "aufbauplan", "material", "positionen", "messen"],
  },
  {
    id: "auftrag-erfassen-uebersicht",
    date: "2026-09-26",
    audience: "alle",
    title: "Aufträge: ein Erfassen-Feld statt Eingang-Tab",
    summary:
      "Der Eingang-Tab ist weg — oben auf der Auftrags-Übersicht gibt es jetzt EIN Feld für alles: Notiz, Mail-Text, Abmachung oder Datei. Die KI sortiert automatisch ein.",
    anleitung: [
      "Alles, was zum Auftrag reinkommt, oben auf der Übersicht erfassen (tippen, diktieren oder Datei anhängen) — die KI macht daraus Zusagen, Technik-Positionen und Terminvorschläge.",
      "Der eingeklappte «Verlauf» darunter zeigt alle erfassten Elemente mit Verarbeitungsstatus; Mails an auftrag@in.eventline-basel.com landen weiterhin automatisch dort.",
      "Das separate Zusagen-Eingabefeld gibt es nicht mehr — Zusagen entstehen aus dem Erfassen-Feld und werden als Häkchen-Liste abgehakt.",
    ],
    keywords: ["eingang", "erfassen", "übersicht", "zusagen", "ki", "diktieren"],
  },
  {
    id: "partner-aenderungen",
    date: "2026-09-26",
    audience: "alle",
    title: "Partnerportal: Partner können bestätigte Anfragen ändern",
    summary:
      "Ändert sich bei einer bestätigten Partner-Anfrage etwas (z.B. Zeiten), passt der Partner sie jetzt direkt im Portal an — ihr werdet sofort benachrichtigt und bestätigt die Änderung neu.",
    anleitung: [
      "Der Partner klickt in seiner bestätigten Anfrage auf «Änderungen vornehmen», passt Termine und Angaben an — die Anfrage gilt ab dann wieder als ausstehend.",
      "Alle Zuständigen bekommen sofort eine Benachrichtigung und eine E-Mail; bereits zugeteilte Mitarbeiter werden ebenfalls informiert.",
      "Im Auftrag erscheint oben der orange Kasten «Partner-Änderung» mit dem Vorher/Nachher-Vergleich (z.B. «Aufbau: 14:00 → 11:00»). «Änderung bestätigen» setzt die Anfrage zurück auf bestätigt.",
      "Ablehnen gibt es bei Änderungen bewusst nicht — bei Unklarheiten den Partner direkt kontaktieren; bis zur Bestätigung bleibt die Anfrage ausstehend.",
    ],
    keywords: ["partner", "anfrage", "änderung", "bestätigt", "termine"],
  },
  {
    id: "kunden-alle-laender",
    date: "2026-09-24",
    audience: "alle",
    title: "Kunden: alle Länder wählbar",
    summary:
      "Beim Kunden lässt sich jetzt jedes Land der Welt auswählen — vorher waren es nur die Schweiz und die Nachbarländer.",
    anleitung: [
      "Im Land-Feld (neuer Kunde oder Kunden-Detail) einfach tippen — z.B. «grie» für Griechenland — und den Treffer wählen. Schweiz und Nachbarländer stehen weiterhin zuoberst.",
      "Beim «In Bexio anlegen» wird das Land automatisch mitgegeben; fehlt es in Bexio noch, legt das System es dort gleich an.",
    ],
    keywords: ["kunde", "land", "länder", "adresse", "griechenland"],
  },
  {
    id: "auftrag-bexio-offerten",
    date: "2026-09-23",
    audience: "alle",
    title: "Aufträge: Bexio-Offerten automatisch in den Dokumenten",
    summary:
      "In Bexio gestellte Offerten landen jetzt von selbst als PDF in den Dokumenten des passenden Auftrags — Ordner «Offerten», ohne manuelles Hochladen.",
    anleitung: [
      "Offerte in Bexio wie gewohnt erstellen und die Auftragsnummer (z.B. «INT-26262») in den Titel oder die Referenz schreiben — daran erkennt das System den Auftrag.",
      "Sobald die Offerte versendet oder bestätigt ist (kein Entwurf mehr), holt das System stündlich das PDF und legt es im Auftrag unter Dokumente im Ordner «Offerten» ab.",
      "Jede Offerte landet nur einmal im Auftrag — auch wenn der Abgleich mehrfach läuft. Mehrere Offerten zum gleichen Auftrag sind möglich, jede mit ihrer eigenen Nummer.",
    ],
    keywords: ["offerte", "bexio", "auftrag", "dokumente", "pdf"],
  },
  {
    id: "abrechnung-bexio-rechnungen",
    date: "2026-09-23",
    audience: "alle",
    title: "Abrechnung: Bexio-Rechnungen automatisch erkannt",
    summary:
      "Die Abrechnung erkennt jetzt selbst, wenn in Bexio eine Rechnung zum Auftrag gestellt wurde — Nummer und PDF werden vorgeschlagen, du bestätigst nur noch. Das manuelle Eintippen der Rechnungsnummer gibt es nicht mehr.",
    anleitung: [
      "Auf der Abrechnungs-Seite sucht das System im Hintergrund die neuesten Bexio-Rechnungen und ordnet sie den offenen Aufträgen zu — am sichersten über die Auftragsnummer im Rechnungstitel (z.B. «INT-26262»), sonst über den Kunden (nur wenn das Rechnungsdatum zum Auftragszeitraum passt).",
      "Gefundene Rechnungen erscheinen als blauer Hinweis direkt auf der Auftragskarte (Nummer, Betrag, Datum). Bei einem reinen Kunden-Treffer steht «bitte prüfen» dabei. Mit dem Augen-Button daneben siehst du das Rechnungs-PDF an, bevor du übernimmst.",
      "«Übernehmen» + Bestätigen trägt die Rechnungsnummer ein, markiert den Auftrag als abgerechnet und legt das Rechnungs-PDF automatisch in die Auftrags-Dokumente (Ordner «Rechnungen»).",
      "Der manuelle Weg («Rechnung gestellt» mit selbst eingetippter Nummer) ist weg — damit können keine falschen Nummern mehr eingetragen werden. Einfach die Rechnung in Bexio mit der INT-Nummer im Titel stellen, dann erscheint sie hier automatisch. «Keine Rechnung stellen» bleibt wie bisher im ···-Menü.",
    ],
    keywords: ["abrechnung", "bexio", "rechnung", "rechnungsnummer", "pdf"],
  },
  {
    id: "anwesenheit-abwesenheiten",
    date: "2026-09-23",
    audience: "alle",
    title: "Dashboard: Abwesenheiten im Anwesenheitskalender",
    summary:
      "Der Anwesenheitskalender auf dem Dashboard zeigt jetzt direkt, wer Ferien oder Militär hat — genehmigte Abwesenheiten erscheinen als oranger Hinweis in der Wochenübersicht.",
    anleitung: [
      "Im Anwesenheitskalender auf dem Dashboard steht bei genehmigten Abwesenheiten neu «Ferien» bzw. «Militär» direkt in der Tageszelle der Person.",
      "Deine eigene Zeile behält daneben ein kleines «+» — falls du trotz eingetragener Abwesenheit doch im Büro bist, kannst du dich normal eintragen.",
    ],
    keywords: ["anwesenheit", "abwesenheit", "ferien", "militär", "dashboard", "kalender"],
  },
  {
    id: "bexio-abgleich-flow",
    date: "2026-09-23",
    audience: "alle",
    title: "Kunden: Geführter Bexio-Abgleich",
    summary:
      "Auf der Kunden-Liste erscheint ein Banner, sobald Kunden noch nicht mit Bexio verknüpft sind oder Daten abweichen. Ein Klick startet den Abgleich — Kunde für Kunde bestätigen statt einzeln suchen.",
    anleitung: [
      "Öffne die Kunden-Liste. Gibt es Kunden ohne Bexio-Verknüpfung oder mit abweichenden Stammdaten, erscheint oben das Banner «X Kunden mit Bexio abgleichen».",
      "«Jetzt abgleichen» startet den Durchlauf: Pro Kunde siehst du den gefundenen Bexio-Kontakt (Nummer, Name, E-Mail) und bestätigst mit «Verknüpfen» — oder überspringst.",
      "Weichen Daten ab, zeigt eine Tabelle beide Werte nebeneinander. «Übernehmen» ersetzt nur die abweichenden Felder durch die Bexio-Werte, «Behalten» lässt alles unverändert — nichts wird ohne deinen Klick überschrieben.",
      "Ausserdem klappt das Verknüpfen jetzt auch bei Kunden ohne hinterlegte Adresse (vorher blockierten die Pflichtfelder das Verknüpfen-Fenster).",
    ],
    keywords: ["bexio", "abgleich", "synchronisieren", "verknüpfen", "kunden"],
  },
  {
    id: "standorte-archiv",
    date: "2026-09-23",
    audience: "alle",
    title: "Standorte: Archivieren mit Begründung",
    summary:
      "Standorte lassen sich neu ins Archiv verschieben — mit Pflicht-Begründung, wie beim Stornieren eines Auftrags. Archivierte Standorte verschwinden aus allen Auswahllisten und können jederzeit reaktiviert werden.",
    anleitung: [
      "Öffne den Standort und klicke oben rechts auf «Archivieren». Bestätige und gib einen Grund an — ohne Grund lässt sich das Archivieren nicht abschliessen.",
      "Der Standort verschwindet danach aus allen Auswahllisten (z.B. beim Anlegen von Aufträgen). Bestehende Aufträge und Dokumente bleiben unverändert erhalten.",
      "In der Locations-Liste zeigt der Knopf «Archiv» alle archivierten Verwaltungen samt Begründung. Über «Reaktivieren» auf der Standort-Seite wird der Standort wieder aktiv.",
      "Wer archivieren darf, steuert das neue Recht «Archivieren» im Bereich Locations der Rollen-Verwaltung.",
    ],
    keywords: ["standort", "location", "archiv", "archivieren", "reaktivieren", "begründung"],
  },
  {
    id: "eingang-dokumente-termine",
    date: "2026-09-19",
    audience: "alle",
    title: "Eingang: Dateien im Dokumente-Tab, Termin-Vorschläge, kompaktere Übersicht",
    summary:
      "Dateien aus dem Eingang (auch Mail-Anhänge) liegen neu automatisch im Dokumente-Tab. Nennt eine Mail Termine wie Aufbau/Abbau, fragt die KI, ob sie den Termin erstellen oder anpassen soll.",
    anleitung: [
      "Jede Datei, die im Eingang landet — hochgeladen oder als Mail-Anhang —, erscheint automatisch auch unter «Dokumente & Historie».",
      "Erwähnt ein Eingang-Element konkrete Termine (Aufbau, Abbau, Probe, Lieferung), erscheint auf der Übersicht ein Vorschlags-Banner: «Termin erstellen» bzw. «Termin anpassen» oder «Verwerfen» — die KI legt nie selbst Termine an.",
      "Die Zusammenfassungs-Kacheln sind kompakter: Jeder Punkt zeigt nur sein Schlagwort, Klick klappt den Text auf. Offene Punkte bleiben immer voll sichtbar.",
      "Bei weitergeleiteten Mail-Verläufen zählt neu das Sendedatum: Neuere Infos ersetzen ältere — egal in welcher Reihenfolge die Mails weitergeleitet werden.",
    ],
    keywords: ["eingang", "dokumente", "anhang", "termin", "vorschlag", "aufbau", "abbau", "zusammenfassung", "kompakt"],
  },
  {
    id: "auftrag-eingang-zusagen",
    date: "2026-09-19",
    audience: "alle",
    title: "Der Auftrag dokumentiert sich selbst",
    summary:
      "Jeder Auftrag hat neu einen «Eingang»: Notiz diktieren, Kunden-Mail einfügen oder Foto hochladen — die KI pflegt daraus Zusammenfassung und Zusagen an den Kunden.",
    anleitung: [
      "Öffne im Auftrag den neuen Tab «Eingang» und lege dort alles ab: Notiz nach dem Telefonat diktieren oder tippen, weitergeleitete Kunden-Mail einfügen, Screenshot/Foto/PDF hochladen.",
      "Die KI liest jedes abgelegte Element und hält auf der Übersicht die Zusammenfassung und die «Zusagen an den Kunden» aktuell (offen/erledigt).",
      "Zusagen kannst du auch von Hand erfassen, abhaken oder als hinfällig markieren — und bei KI-Zusagen die Quelle ansehen.",
      "Im Feld «Frage zum Auftrag» bekommst du Antworten aus dem gesamten Auftragswissen — z.B. «Was wurde zum Aufbau abgemacht?».",
      "Beim Erstellen eines Auftrags: «Aus Text ausfüllen» — Kunden-Mail einfügen, die KI füllt das Formular vor, du kontrollierst nur noch.",
    ],
    keywords: ["auftrag", "eingang", "zusagen", "ki", "diktieren", "mail", "frage", "abmachung"],
  },
  {
    id: "projekte-live-dokumente",
    date: "2026-09-17",
    audience: "alle",
    title: "Live-Dokumente in Projekten",
    summary:
      "Projekte haben neu gemeinsame Dokumente wie in Word — alle Eingeloggten schreiben gleichzeitig, ohne Dateien hin- und herzuschicken.",
    anleitung: [
      "Öffne im Projekt den Tab «Dokumente & Historie» und drücke oben «+ Live-Dokument».",
      "Es öffnet sich ein Word-ähnliches Blatt: Schriftarten, Farben, Textmarker, Listen, Checklisten, Tabellen — alles in der Leiste oben.",
      "Alle, die beim Projekt eingeloggt sind, können gleichzeitig schreiben — du siehst ihre Cursor farbig mit Namen. Gespeichert wird automatisch.",
      "Über «Verlauf» siehst du frühere Stände und kannst sie wiederherstellen; «PDF» druckt das Blatt oder speichert es als PDF.",
      "Wer nicht beim Projekt eingeloggt ist, kann das Dokument nur lesen.",
    ],
    keywords: ["projekte", "live-dokument", "word", "gemeinsam", "gleichzeitig", "dokumente", "pdf", "verlauf"],
  },
  {
    id: "projekte-bearbeiten-alle",
    date: "2026-09-17",
    audience: "alle",
    title: "Projekte: Eingeloggte bearbeiten mit",
    summary:
      "Wer bei einem Projekt eingeloggt ist, kann es jetzt auch bearbeiten — Beschreibung, Details und Termine, nicht mehr nur der Projektleiter.",
    anleitung: [
      "Öffne das Projekt und drücke «Einloggen» — derselbe Schritt wie vor dem Stempeln.",
      "Danach kannst du Beschreibung, Details und Termine bearbeiten und siehst alle Projekt-Termine.",
      "Genehmigen, Abschliessen und Löschen bleiben weiterhin Admin-Sache.",
    ],
    keywords: ["projekte", "bearbeiten", "einloggen", "mitglied", "projektleiter", "termine", "rechte"],
  },
  {
    id: "dokumente-ordner",
    date: "2026-09-08",
    audience: "alle",
    title: "Ordner für Dokumente",
    summary:
      "Dokumente bei Aufträgen, Projekten und Standorten kannst du neu in Ordner sortieren — Ordner anlegen, hochladen, fertig.",
    anleitung: [
      "Über der Dokumentenliste (Auftrag, Projekt oder Standort) siehst du neu Ordner-Chips: «Alle», «Hauptordner» und deine Ordner mit Anzahl.",
      "Mit «+ Ordner» legst du einen neuen Ordner an — Namen eintippen, z.B. Pläne oder Verträge. Der neue Ordner ist gleich ausgewählt.",
      "Was du hochlädst, landet im gerade gewählten Ordner. Steht die Ansicht auf «Alle», landet es im Hauptordner.",
      "Zum Verschieben tippst du in der Dokument-Zeile auf das Ordner-Symbol mit dem Pfeil und wählst den Zielordner.",
      "Ein leerer Ordner verschwindet von selbst — aufräumen oder löschen musst du nichts.",
    ],
    keywords: ["dokumente", "ordner", "upload", "verschieben", "hauptordner", "ablage", "sortieren"],
  },
  {
    id: "suche-aktionen",
    date: "2026-09-08",
    audience: "alle",
    title: "Die Suche findet jetzt auch Aktionen",
    summary:
      "Ctrl+K drücken und einfach tippen, was du willst: «krank» führt direkt zu Abwesenheit melden, «stempeln» zu deinen Stempelzeiten.",
    anleitung: [
      "Drück Ctrl+K (Mac: ⌘K) oder klick in der Seitenleiste auf «Suche…».",
      "Tipp, was du machen willst — z.B. «krank», «stempeln», «ticket» oder «dashboard». Passende Aktionen erscheinen zuoberst als eigene Gruppe.",
      "Mit Enter öffnest du den obersten Treffer, mit ↑/↓ wechselst du die Auswahl. Umlaute sind egal — die Suche versteht beide Schreibweisen.",
    ],
    keywords: ["suche", "ctrl+k", "cmd+k", "aktionen", "krank", "schnellzugriff", "command"],
  },
  {
    id: "einsatz-modus-stempeln",
    date: "2026-09-08",
    audience: "alle",
    title: "Beim Einstempeln: «Was für ein Einsatz?»",
    summary:
      "Beim Einstempeln auf einen Auftrag wählst du neu die Einsatzart (Normal, Pikett, …). Der Standard ist vorgewählt — normaler Einsatz heisst: nichts anklicken.",
    anleitung: [
      "Wenn du auf einen Auftrag einstempelst, zeigt die App Kacheln zur Einsatzart — je nach Standort z.B. Normal, Pikett, Administration oder Aufbau/Abbau.",
      "Der Standard ist schon vorgewählt. Nur bei einem Pikett- oder Admin-Einsatz tippst du vorher kurz auf die passende Kachel.",
      "Während du eingestempelt bist, kannst du den Modus über kleine Chips wechseln — z.B. tagsüber Aufbau, in der Nacht Pikett. Die Zeit wird automatisch sauber getrennt.",
      "Hat ein Standort nur eine Einsatzart, erscheint gar keine Auswahl — dann bleibt für dich alles wie bisher.",
    ],
    keywords: ["stempeln", "einstempeln", "modus", "pikett", "einsatzart", "aufbau", "administration"],
  },
  {
    id: "rapport-modus",
    date: "2026-09-08",
    audience: "alle",
    title: "Einsatzrapport: Modus pro Einsatzzeit",
    summary:
      "Jede Einsatzzeit-Zeile im Rapport hat neu die Modus-Auswahl als Chips — Standard ist vorgewählt, nur Ausnahmen umstellen.",
    anleitung: [
      "Im Einsatzrapport hat jede Einsatzzeit-Zeile die Modus-Auswahl als Chips (bei Standorten mit mehreren Einsatzarten).",
      "Der Standard ist gesetzt — ändere ihn nur, wenn diese Stunden ein anderer Einsatz waren (z.B. Pikett statt Normal).",
      "Ein gemischter Einsatz (tags Aufbau, nachts Pikett) wird als mehrere Zeilen mit dem jeweiligen Modus erfasst.",
      "«Nicht verrechnen» pro Zeile funktioniert wie bisher — dort braucht es keinen Modus.",
    ],
    keywords: ["rapport", "einsatzrapport", "modus", "einsatzzeit", "chips"],
  },
  {
    id: "standort-tabs",
    date: "2026-09-08",
    audience: "alle",
    title: "Standort-Seiten aufgeräumt",
    summary:
      "Statt einer langen Scroll-Seite gibt es Tabs — und wichtige Notizen (Türcode, WLAN) stehen gepinnt zuoberst.",
    anleitung: [
      "Jede Standort-Seite hat jetzt Tabs: «Übersicht» und «Notizen & Dokumente».",
      "Wichtige Notizen — etwa Türcode oder WLAN — sind gepinnt und stehen sofort zuoberst auf der Übersicht. Kein Suchen mehr vor Ort.",
      "Kontakte haben direkt Anrufen- und Mailen-Knöpfe — ein Tipp aufs Handy genügt.",
    ],
    keywords: ["standort", "location", "notizen", "gepinnt", "türcode", "wlan", "kontakte", "dokumente"],
  },
  {
    id: "dashboard-anpassen",
    date: "2026-09-08",
    audience: "alle",
    title: "Dein Dashboard, deine Anordnung",
    summary:
      "Übers Zahnrad oben rechts kannst du die Dashboard-Kacheln anordnen, ihre Grösse ändern und ein-/ausblenden.",
    anleitung: [
      "Klick auf dem Dashboard oben rechts aufs Zahnrad.",
      "Dann kannst du die Kacheln (Widgets) per Ziehen anordnen, ihre Breite ändern und einzelne ein- oder ausblenden.",
      "Deine Einstellung bleibt gespeichert — beim nächsten Öffnen siehst du zuerst, was für dich wichtig ist.",
    ],
    keywords: ["dashboard", "widgets", "anpassen", "zahnrad", "anordnen", "konfigurieren"],
  },
  {
    id: "passkey-login",
    date: "2026-09-08",
    audience: "alle",
    title: "Einloggen mit Fingerabdruck oder Gesicht",
    summary:
      "Melde dich ohne Passwort an — mit Fingerabdruck, Face ID oder Windows Hello. Einmal selbst aktivieren unter Mein Konto → Sicherheit.",
    anleitung: [
      "Geh zu Mein Konto → Sicherheit → «Passkey einrichten».",
      "Dein Gerät fragt einmal nach Fingerabdruck oder Gesicht — das dauert eine halbe Minute.",
      "Beim nächsten Login tippst du nur noch auf «Mit Passkey anmelden». Dein Passwort funktioniert weiterhin — der Passkey ist ein zusätzlicher, schnellerer Weg.",
    ],
    keywords: ["passkey", "biometrisch", "fingerabdruck", "face id", "windows hello", "login", "anmelden", "sicherheit"],
  },
  {
    id: "abwesenheiten-uebersicht",
    date: "2026-09-08",
    audience: "alle",
    title: "Abwesenheiten-Seite übersichtlicher",
    summary:
      "Aktuelle und kommende Abwesenheiten stehen zuoberst, Vergangenes ist separat.",
    anleitung: [
      "Auf der Abwesenheiten-Seite stehen aktuelle und kommende Abwesenheiten zuoberst — Vergangenes findest du separat weiter unten.",
      "Abwesenheit melden geht wie bisher über den Knopf auf der Seite — oder tipp «krank» in die Ctrl+K-Suche.",
    ],
    keywords: ["abwesenheit", "ferien", "krank", "urlaub", "absenz"],
  },
  {
    id: "stempel-aenderung-einfacher",
    date: "2026-09-08",
    audience: "alle",
    title: "Stempel-Änderung einfacher anfragen",
    summary:
      "Falsch oder vergessen gestempelt? Ticket-Knopf direkt neben der Stempeluhr, kurz beschreiben, fertig.",
    anleitung: [
      "Neben der Stempeluhr sitzt ein Ticket-Knopf — er öffnet direkt die Stempel-Änderungs-Anfrage.",
      "Zeiten angeben, kurz beschreiben, absenden. Nach der Genehmigung wird dein Eintrag automatisch korrigiert oder angelegt.",
      "In den Stempelzeiten kannst du bei einem eigenen Eintrag auch aufs Stift-Symbol tippen — dann sind die Zeiten schon vorausgefüllt.",
    ],
    keywords: ["stempel", "korrektur", "ticket", "vergessen", "änderung", "nachtragen"],
  },
  {
    id: "mein-team-widget",
    date: "2026-09-08",
    audience: "teamleiter",
    title: "«Mein Team»-Widget: dein Team auf einen Blick",
    summary:
      "Das Dashboard-Widget zeigt jede Person deines Teams mit Live-Status: wer eingestempelt ist (und worauf), wer heute abwesend ist.",
    anleitung: [
      "Auf dem Dashboard zeigt das Widget «Mein Team» jede Person deines Teams als Zeile.",
      "Grüner Punkt = gerade eingestempelt, mit «seit wann» und worauf (Auftrag, Projekt oder andere Arbeit). Amber = heute abwesend (Ferien, Krank, …). Grau = offline.",
      "Klick auf eine Person öffnet direkt ihre Stempelzeiten.",
    ],
    keywords: ["team", "widget", "mein team", "überblick", "eingestempelt", "teamleiter"],
  },
  {
    id: "team-scope",
    date: "2026-09-08",
    audience: "teamleiter",
    title: "Team-Sicht: Daten deiner Mitarbeiter einsehen",
    summary:
      "Als Teamleiter siehst du Stempelzeiten, Abwesenheiten, Todos, Tickets und Einsatz-Termine der Mitarbeiter, die dir zugeteilt sind.",
    anleitung: [
      "Stempelzeiten: auf der Stempelzeiten-Seite oben im Auswahlfeld das Team-Mitglied wählen — so siehst du, ob alle sauber gestempelt haben.",
      "Abwesenheiten deines Teams siehst du auf der Abwesenheiten-Seite — du weisst vor dem Planen, wer wann fehlt. (Genehmigen läuft weiterhin über die Ferien-Verantwortlichen.)",
      "Todos, Tickets und Einsatz-Termine deines Teams erscheinen in den jeweiligen Listen mit drin.",
    ],
    keywords: ["teamleiter", "team", "stempelzeiten", "abwesenheiten", "sicht"],
  },
  {
    id: "projekte-guide",
    date: "2026-09-08",
    audience: "projektleiter",
    title: "Projekte: anfragen, stempeln, nachtragen",
    summary:
      "So laufen interne Projekte — vom Antrag über das Stempeln bis zum Nachtragen vergessener Zeiten.",
    anleitung: [
      "Projekt anfragen: Unter «Projekte» ein neues Projekt beantragen — Ziel und geschätzter Aufwand rein. Es steht dann auf «Zur Genehmigung»; das Büro genehmigt und setzt das Stunden-Budget. Erst ab «Genehmigt» kann darauf gestempelt werden.",
      "Zeit stempeln: Stempeluhr → «Auf ein Projekt» → Projekt wählen — oder direkt im Projekt im Tab «Zeit & Stempel». Wer noch nicht im Projekt-Team ist, tritt beim ersten Einstempeln automatisch bei.",
      "Budget im Blick: Der Fortschrittsbalken im Projekt zeigt verbrauchte gegen genehmigte Stunden — grün, ab 80% amber, ab 100% rot. Wird es knapp: früh melden.",
      "Nachstempeln (vergessen oder falsch gestempelt): Ticket-Knopf neben der Stempeluhr → Stempel-Änderung → als Kontext das Projekt wählen und die richtigen Zeiten angeben. Nach der Genehmigung wird der Eintrag automatisch angelegt bzw. korrigiert.",
      "Gestempelte Projektzeit fliesst wie Auftragszeit in deine Monatsstunden und den Lohn. Abgeschlossene oder stornierte Projekte wandern automatisch ins Archiv.",
    ],
    keywords: ["projekt", "projekte", "budget", "nachstempeln", "projektleiter", "genehmigung"],
  },
];

/** Neuester Eintrags-Zeitstempel (fuer Popup-Vergleich gegen
 *  profiles.updates_seen_at). Zurich-Datum als Mitternacht-UTC-Anker
 *  reicht — verglichen wird nur "gibt es Neueres als zuletzt gesehen". */
export function latestUpdateDate(): string {
  return APP_UPDATES.reduce((max, u) => (u.date > max ? u.date : max), "");
}

/** Eintraege der letzten `days` Tage (fuer den "Neu"-Tab + Popup). */
export function recentUpdates(todayIso: string, days = 7): AppUpdate[] {
  const cutoff = new Date(new Date(todayIso + "T12:00:00Z").getTime() - days * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return APP_UPDATES.filter((u) => u.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
}

const AUDIENCE_LABEL: Record<UpdateAudience, string> = {
  alle: "Alle",
  teamleiter: "Teamleiter",
  projektleiter: "Projektleiter",
};
export function audienceLabel(a: UpdateAudience): string {
  return AUDIENCE_LABEL[a];
}
