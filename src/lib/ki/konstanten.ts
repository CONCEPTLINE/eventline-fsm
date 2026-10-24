// Feste Werte der lokalen KI im Buero-Rig. Das ERP nutzt sie fuer Diktat, Beleg- und Warenkorb-Erkennung (und den
// Sicherheits-Rapport, /api/ki/sicherheit). Die Ablage-Arten (ablage_analyse, vorschau, nas_suche, archiv_frage)
// leben seit 24.10.2026 in Trust one — Vertrag und Rig-Code: Trust-one-Repo, docs/lokale-ki/SPEC.md und
// rig/eventline-ki/. Rig und ERP teilen sich diese Festlegungen — wer etwas aendert, traegt es zuerst in der SPEC ein,
// sonst laufen Dienst und Warteschlange auseinander.

/** Auftragsarten des ERP. Nur diese gibt die Abhol-API (/api/ki/sync) heraus. */
export const KI_ARTEN = ["beleg_analyse", "warenkorb_analyse", "diktat"] as const;

/** Abhol-Reihenfolge: hoeher zuerst, sonst FIFO. Diktat vor allem (jemand wartet live am Mikrofon). */
export const KI_PRIORITAET: Readonly<Record<(typeof KI_ARTEN)[number], number>> = {
  diktat: 100,
  beleg_analyse: 50,
  warenkorb_analyse: 50,
};

/** Arten, die eine Datei aus dem Uebergabe-Bucket verarbeiten
 *  (payload.storage_path unter ki-tmp/, die Abhol-API haengt eine signierte
 *  `url` an). */
export const KI_DATEI_ARTEN = ["beleg_analyse", "warenkorb_analyse", "diktat"] as const;

/** Uebergabe-Bucket und Praefix der Tmp-Objekte, die nur bis zur Verarbeitung dort liegen. Der Bucket heisst aus
 *  historischen Gruenden «nas-ablage» (die NAS-Ablage selbst ist nach Trust one gezogen, der Bucket dient nur noch
 *  der Uebergabe ki-tmp/). */
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

/** Wartezeiten der ERP-Seite auf ein Ergebnis. Beleg: Kaltstart des
 *  Bildmodells auf dem Rig (Laden ab LUKS-Platte) dauert 20–50 s, dazu die
 *  Analyse — darum 90 s; die Route braucht ein passendes maxDuration. */
export const KI_TIMEOUT_BELEG_MS = 90_000;
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

/** Diktat-Grenzen: Aufnahme hoechstens 10 MB, erkannter Text hoechstens
 *  20 000 Zeichen (Rig und ERP kappen gleich). */
export const DIKTAT_MAX_BYTES = 10 * 1024 * 1024;
export const DIKTAT_TEXT_MAX = 20_000;
