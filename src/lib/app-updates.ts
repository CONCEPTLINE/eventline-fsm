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
    id: "abrechnung-bexio-rechnungen",
    date: "2026-09-23",
    audience: "alle",
    title: "Abrechnung: Bexio-Rechnungen automatisch erkannt",
    summary:
      "Die Abrechnung erkennt jetzt selbst, wenn in Bexio eine Rechnung zum Auftrag gestellt wurde — Nummer und PDF werden vorgeschlagen, du bestätigst nur noch. Das manuelle Eintippen der Rechnungsnummer gibt es nicht mehr.",
    anleitung: [
      "Auf der Abrechnungs-Seite sucht das System im Hintergrund die neuesten Bexio-Rechnungen und ordnet sie den offenen Aufträgen zu — am sichersten über die Auftragsnummer im Rechnungstitel (z.B. «INT-26262»), sonst über den Kunden (nur wenn das Rechnungsdatum zum Auftragszeitraum passt).",
      "Gefundene Rechnungen erscheinen als blauer Hinweis direkt auf der Auftragskarte (Nummer, Betrag, Datum). Bei einem reinen Kunden-Treffer steht «bitte prüfen» dabei.",
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
