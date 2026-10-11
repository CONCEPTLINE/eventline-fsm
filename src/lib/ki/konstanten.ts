// Feste Werte der lokalen KI (docs/lokale-ki/SPEC.md). Rig und FSM teilen
// sich diese Festlegungen — wer etwas aendert, traegt es zuerst in der
// SPEC ein, sonst laufen Dienst und Warteschlange auseinander.

export const KI_ARTEN = [
  "ablage_analyse",
  "beleg_analyse",
  "warenkorb_analyse",
  "diktat",
  "archiv_index",
  "zz_einsortieren",
  "fristen_scan",
] as const;

/** Arten, die eine Datei aus dem Uebergabe-Bucket verarbeiten
 *  (payload.storage_path unter ki-tmp/, die Abhol-API haengt eine signierte
 *  `url` an). */
export const KI_DATEI_ARTEN = ["ablage_analyse", "beleg_analyse", "warenkorb_analyse", "diktat"] as const;

/** Uebergabe-Bucket (derselbe wie die NAS-Ablage) und Praefix der
 *  Tmp-Objekte, die nur bis zur Verarbeitung dort liegen. */
export const KI_BUCKET = "nas-ablage";
export const KI_TMP_PREFIX = "ki-tmp/";

/** Herzschlag: letzter_poll juenger als 90 s = online. */
export const KI_ONLINE_FENSTER_MS = 90_000;
/** Lebensdauer der signierten Download-URLs fuer das Rig (Sekunden). */
export const KI_SIGNED_URL_S = 3600;
/** Auftraege pro Abholung — der Dienst arbeitet seriell (ein Modell im
 *  Speicher); ein zweiter beanspruchter Auftrag laege nur herum und
 *  wuerde ein Diktat, das danach kommt, hinter sich warten lassen. */
export const KI_SYNC_BATCH = 1;
/** `laeuft` ohne Rueckmeldung laenger als 20 min = haengt -> wieder offen.
 *  20 min = Summe der Timeouts auf dem Rig (Download, OCR, Modell), damit
 *  ein langes Dokument nie als haengend gilt, solange das Rig noch daran
 *  arbeitet. */
export const KI_HAENGT_NACH_MS = 20 * 60_000;
/** Nach so vielen Zustellversuchen wird ein haengender Auftrag zu `fehler`. */
export const KI_MAX_VERSUCHE = 2;

/** Housekeeping (Datenschutz — Ergebnisse enthalten Inhalte vertraulicher
 *  Dokumente). Laeuft gedrosselt im Abhol-Pfad und taeglich aus dem Cron
 *  /api/cron/db-retention:
 *   - Tmp-Objekte und nie abgeholte Auftraege aelter als 24 h,
 *   - Ergebnisse fertiger/fehlgeschlagener Auftraege aelter als 1 h,
 *   - Auftragszeilen aelter als 30 Tage. */
export const KI_TMP_MAX_ALTER_MS = 24 * 60 * 60_000;
export const KI_ERGEBNIS_MAX_ALTER_MS = 60 * 60_000;
export const KI_AUFTRAG_MAX_ALTER_MS = 30 * 24 * 60 * 60_000;
/** Housekeeping im Abhol-Pfad hoechstens alle 15 min pro Instanz — der
 *  Dienst pollt alle 2 s. */
export const KI_AUFRAEUMEN_ALLE_MS = 15 * 60_000;

/** Wartezeiten der FSM-Seite auf ein Ergebnis. Beleg: Kaltstart des
 *  Bildmodells auf dem Rig (Laden ab LUKS-Platte) dauert 20–50 s, dazu die
 *  Analyse — darum 90 s; die Route braucht ein passendes maxDuration. */
export const KI_TIMEOUT_BELEG_MS = 90_000;
export const KI_TIMEOUT_ABLAGE_MS = 180_000;
/** Diktat: wird vor allen anderen Arten abgeholt, Whisper braucht fuer
 *  ein paar Minuten Audio nur Sekunden — 60 s. Die Route (maxDuration
 *  120) kappt die Wartezeit zusaetzlich auf ihre Restlaufzeit abzueglich
 *  KI_ROUTE_RESERVE_MS, damit Antwort und Aufraeumen noch laufen. */
export const KI_TIMEOUT_DIKTAT_MS = 60_000;
/** Reserve am Ende einer Routen-Laufzeit (maxDuration) fuer Antwort und
 *  Aufraeumen (Tmp-Objekt und Auftragszeile loeschen). */
export const KI_ROUTE_RESERVE_MS = 10_000;
/** Abstand zwischen zwei DB-Abfragen beim Warten auf ein Ergebnis. */
export const KI_WARTE_POLL_MS = 1_000;

/** Tickets fuer die Direkt-API (Browser -> Rig, nur Archiv): 10 Minuten gueltig. */
export const KI_TICKET_GUELTIG_S = 600;

/** V8 Ablage-Entscheid durch Claude (SPEC 3.1 / §7 V8): Wartezeit auf die
 *  Antwort EINES Entscheids. Das Rig wartet bis 90 s auf die POST-Antwort
 *  von /api/ki/sync — nach dieser Frist gilt das lokale Ergebnis, der
 *  Auftrag scheitert nie. */
export const KI_ENTSCHEID_TIMEOUT_MS = 25_000;
/** Zeitbudget von POST /api/ki/sync ueber ALLE Ergebnisse eines Batches
 *  (maxDuration 60; der Rest ist fuer DB-Updates und Antwort). Die
 *  Claude-Entscheide eines Batches laufen parallel, jeder wartet hoechstens
 *  min(KI_ENTSCHEID_TIMEOUT_MS, Restbudget) — sonst spraengte ein Batch mit
 *  mehreren ablage_analyse-Ergebnissen die Laufzeit, das Rig bekaeme keinen
 *  200 und schickte den Batch endlos erneut. */
export const KI_SYNC_POST_BUDGET_MS = 45_000;
/** Unter diesem Restbudget wird Claude gar nicht mehr gefragt (Quelle «lokal»). */
export const KI_ENTSCHEID_MIN_REST_MS = 5_000;
/** Dokumenttypen mit betroffener Person: nur hier darf die lokale KI eine
 *  Person vorschlagen (GET-Kontext `dok_typen[].person`), und V8 fragt bei
 *  diesen Typen nie Claude (personenbezogen, SPEC 3.1). */
export const KI_PERSON_TYPEN: ReadonlySet<string> = new Set(["lohnabrechnung", "behoerde", "zertifikat"]);
/** Hoechstens so viele Kandidaten (Vorbild/Regel) aus dem Rig-Ergebnis. */
export const KI_ENTSCHEID_MAX_KANDIDATEN = 8;
/** Naechstbeste Zielordner im Ergebnis (wie ordner_alternativen bisher). */
export const KI_ENTSCHEID_MAX_ALTERNATIVEN = 2;
/** Begruendung von Claude — ein kurzer Satz, Tooltip am Chip. */
export const KI_ENTSCHEID_BEGRUENDUNG_MAX = 120;
/** Laengste minimierte Einordnung (`was`), die Richtung Claude geht. */
export const KI_EINORDNUNG_WAS_MAX = 400;

/** Diktat-Grenzen: Aufnahme hoechstens 10 MB, erkannter Text hoechstens
 *  20 000 Zeichen (Rig und FSM kappen gleich). */
export const DIKTAT_MAX_BYTES = 10 * 1024 * 1024;
export const DIKTAT_TEXT_MAX = 20_000;

/** Datei-Grenzen der Ablage — gelten fuer /api/ablage/upload und
 *  /api/ablage/ki-upload gleichermassen (eine Quelle, kein Auseinanderlaufen). */
export const ABLAGE_MAX_BYTES = 50 * 1024 * 1024;
export const ABLAGE_MIME_PREFIXES = [
  "image/",
  "application/pdf",
  "application/vnd.",
  "application/msword",
  "text/plain",
  "text/csv",
  "application/zip",
];
