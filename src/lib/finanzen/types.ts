// Finanzen Welle 1 — GETEILTE TYPEN UND KONSTANTEN (Vertragsdatei).
//
// Diese Datei ist der einzige Ort, an dem die vier Bauteile (B1 Datenbank,
// B2 Sicherheit, B3 Bexio-Spiegel, B4 Seite) ihre gemeinsamen Formen
// finden. Sie hat bewusst KEINE Imports: sie darf von Server-Routen,
// Client-Komponenten, Cron-Routen und Tests gleichermassen importiert
// werden, ohne irgendeinen Modulgraphen mitzuziehen (Isolations-Test in
// src/lib/finanzen/isolation.test.ts).
//
// Regeln (Spec «finanzen-spec.md», Abschnitt B):
//   • Beträge kommen aus Postgres als numeric → PostgREST liefert STRINGS.
//     Zeilen-Typen der Spiegel-Tabellen führen Beträge deshalb als string;
//     die Routen-Antworten (Kennzahlen, Posten …) führen sie als number,
//     weil die Route sie mit Number() wandelt. formatChf() nimmt beides.
//   • Datums-Spalten (date) sind "YYYY-MM-DD"-Strings, timestamptz sind
//     ISO-Strings. Anzeige IMMER mit timeZone Europe/Zurich (format.ts).
//   • Keine Beträge, Kundennamen oder Rechnungsnummern in logError-extra,
//     Mails, Push, Büro-Bildschirm oder Befehlspalette.

// =====================================================================
// 1. Fehler-Slugs, Konstanten
// =====================================================================

/** Fehler-Slugs im `error`-Feld von `{ success: false, error, message? }`.
 *  Bestehende Slugs der App (api-auth.ts) werden hier nur gespiegelt. */
export const FINANZEN_FEHLER = {
  /** 403 — requireTrustedDevice (bestehend, api-auth.ts:348/368). */
  DEVICE_NOT_TRUSTED: "device_not_trusted",
  /** 403 — Finanzen sind im «Ansicht als»-Modus (Impersonation) gesperrt. */
  IMPERSONATION: "impersonation",
  /** 503 — Lese-Protokoll (finanzen.zugriffe) nicht schreibbar → Finanzen
   *  FAIL-CLOSED gesperrt (keine Finanzdaten ohne Spur). Lohn-Routen bleiben
   *  fail-open (Mitarbeiter-Handy darf nicht brechen). */
  PROTOKOLL_NICHT_VERFUEGBAR: "protokoll_nicht_verfuegbar",
  /** 409 — ein Sync läuft bereits (sync_laeufe, status 'laeuft', < SYNC_SPERRE_MS). */
  SYNC_LAEUFT: "sync_laeuft",
  /** 409 — Bexio-Verbindung hat die Finanz-Scopes nicht (neu verbinden). */
  BEXIO_SCOPE: "bexio_scope",
  /** 409 — Bexio ist gar nicht verbunden. */
  BEXIO_NICHT_VERBUNDEN: "bexio_nicht_verbunden",
} as const;
export type FinanzenFehlerSlug = (typeof FINANZEN_FEHLER)[keyof typeof FINANZEN_FEHLER];

const ALLE_FEHLER_SLUGS = new Set<string>(Object.values(FINANZEN_FEHLER));

/** Type-Guard für `json.error` (string) → FinanzenFehlerSlug. Verbindlich in
 *  finanzenFetch() — kein eigener Cast. */
export function istFinanzenFehlerSlug(s: unknown): s is FinanzenFehlerSlug {
  return typeof s === "string" && ALLE_FEHLER_SLUGS.has(s);
}

/** Fixer Empfänger des Wochen-Digests (Muster APPROVAL_EMAIL_RECIPIENT in
 *  src/app/api/trust/devices/route.ts:20). */
export const ZUGRIFFE_DIGEST_EMPFAENGER = "admin@eventline-basel.com";

/** Rechte-Slug des Moduls (permissions.ts: { slug: "finanzen", actions: ["view"] }).
 *  Welle 1: das Recht ist Dokumentation — der Zugang ist zusätzlich
 *  admin-only (/finanzen in ADMIN_ONLY_PREFIXES, requireFinanzen =
 *  requireAdminTrustedDevice). Der Slug wirkt erst, wenn requireFinanzen auf
 *  requireTrustedDevice umgestellt wird. */
export const FINANZEN_PERMISSION = "finanzen:view";

/** Pfad der Seite (Sidebar-Bereich «Finanzen», Label «Übersicht»). */
export const FINANZEN_PFAD = "/finanzen";

/** Header, den alle Finanz-Leserouten setzen (requireFinanzen/finanzenJson). */
export const FINANZEN_CACHE_CONTROL = "no-store";

// =====================================================================
// 2. Zugriffs-Protokoll (finanzen.zugriffe)
// =====================================================================

export type ZugriffBereich = "finanzen" | "lohn";

/** Aktions-Slugs. Neue Aktionen hier ergänzen — die Karte «Zugriffe auf
 *  Finanzen & Lohn» übersetzt sie via ZUGRIFF_AKTION_LABEL. */
export const ZUGRIFF_AKTION = {
  // --- Finanzen (jede Leseroute genau eine Aktion) ---
  FINANZEN_UEBERSICHT: "finanzen.uebersicht",
  FINANZEN_OFFENE_POSTEN: "finanzen.offene_posten",
  FINANZEN_KREDITOREN: "finanzen.kreditoren",
  FINANZEN_UMSATZ: "finanzen.umsatz",
  FINANZEN_BANKKONTEN: "finanzen.bankkonten",
  FINANZEN_SYNC_STATUS: "finanzen.sync_status",
  FINANZEN_SYNC_MANUELL: "finanzen.sync_manuell",
  // --- Lohn (bestehende Routen, siehe Spec C.B2 Schritt 9) ---
  LOHN_MONATSSTUNDEN: "lohn.monatsstunden",
  LOHN_EXPORT: "lohn.export",
  LOHN_STANDARDWERTE: "lohn.standardwerte",
  LOHN_STANDARDWERTE_AENDERN: "lohn.standardwerte_aendern",
  LOHN_MITARBEITER_UEBERSICHT: "lohn.mitarbeiter_uebersicht",
  LOHN_MITARBEITER_AENDERN: "lohn.mitarbeiter_aendern",
  LOHN_HISTORIE: "lohn.historie",
  LOHN_DETAIL: "lohn.detail",
  LOHN_DOKUMENTE_LISTE: "lohn.dokumente_liste",
  LOHN_DOKUMENT_LINK: "lohn.dokument_link",
  LOHN_DOSSIER: "lohn.dossier",
} as const;
export type ZugriffAktion = (typeof ZUGRIFF_AKTION)[keyof typeof ZUGRIFF_AKTION];

/** Anzeige-Texte der Karte (Einstellungen › Sicherheit). Keine Beträge,
 *  keine Dokumentnamen — nur «was wurde angesehen». */
export const ZUGRIFF_AKTION_LABEL: Record<ZugriffAktion, string> = {
  "finanzen.uebersicht": "Finanzen: Kennzahlen angesehen",
  "finanzen.offene_posten": "Finanzen: offene Debitoren angesehen",
  "finanzen.kreditoren": "Finanzen: offene Kreditoren angesehen",
  "finanzen.umsatz": "Finanzen: Umsatz pro Monat angesehen",
  "finanzen.bankkonten": "Finanzen: Bankkonten angesehen",
  "finanzen.sync_status": "Finanzen: Abgleich-Status angesehen",
  "finanzen.sync_manuell": "Finanzen: Bexio-Abgleich gestartet",
  "lohn.monatsstunden": "Lohn: Monatsstunden angesehen",
  "lohn.export": "Lohn: Stunden-Export erzeugt",
  "lohn.standardwerte": "Lohn: Standardwerte angesehen",
  "lohn.standardwerte_aendern": "Lohn: Standardwerte geändert",
  "lohn.mitarbeiter_uebersicht": "Lohn: Mitarbeiter-Löhne angesehen",
  "lohn.mitarbeiter_aendern": "Lohn: Mitarbeiter-Lohn geändert",
  "lohn.historie": "Lohn: Lohn-Historie angesehen",
  "lohn.detail": "Lohn: Lohn-Detail angesehen",
  "lohn.dokumente_liste": "Lohn: Lohndokumente aufgelistet",
  "lohn.dokument_link": "Lohn: Lohndokument-Link ausgegeben",
  "lohn.dossier": "Lohn: Personal-Dossier erstellt",
};

/** Erlaubte Detail-Werte: nur Schlüssel ohne Geldbezug (jahr, monat, von,
 *  bis, doc_type, anzahl …). NIE total/betrag/amount/name. */
export type ZugriffDetails = Record<string, string | number | boolean | null>;

/** Whitelist der Detail-Schlüssel, die die Karte «Zugriffe» rendert — nie
 *  generisch alle Keys (Datenminimierung im Browser). */
export const ZUGRIFF_DETAILS_ANZEIGE: readonly string[] = ["jahr", "monat", "doc_type", "art", "von", "bis", "voll"];

/** Eingabe für protokolliereZugriff() (src/lib/finanzen/zugriffe.ts). */
export interface ZugriffEintrag {
  /** auth.user.id — der ECHTE eingeloggte User, nie effectiveUserId. */
  actorProfileId: string;
  bereich: ZugriffBereich;
  aktion: ZugriffAktion;
  /** Betroffene Person (z. B. Mitarbeiter, dessen Lohn angesehen wurde). */
  zielProfileId?: string | null;
  /** hashToken(trusted-device-Cookie) — null wenn kein Cookie. */
  geraetHash?: string | null;
  details?: ZugriffDetails;
}

/** Zeile in finanzen.zugriffe (append-only, occurred_at einzige Zeitspalte). */
export interface ZugriffRow {
  id: string;
  occurred_at: string;
  actor_profile_id: string | null;
  actor_label: string | null;
  bereich: ZugriffBereich;
  aktion: ZugriffAktion;
  ziel_profile_id: string | null;
  ziel_label: string | null;
  geraet_hash: string | null;
  details: ZugriffDetails;
}

/** Zeile, wie sie an den Browser geht (GET /api/einstellungen/zugriffe):
 *  OHNE geraet_hash (Bezeichner der Geräte-Tabelle) und ohne Profil-IDs —
 *  die Karte zeigt nur Labels. */
export type ZugriffAnzeigeRow = Pick<ZugriffRow, "id" | "occurred_at" | "actor_label" | "bereich" | "aktion" | "ziel_label" | "details">;

/** Antwort GET /api/einstellungen/zugriffe (requireAdmin). */
export interface ZugriffeAntwort {
  success: true;
  /** Neueste zuerst, max. 200. */
  eintraege: ZugriffAnzeigeRow[];
  /** Zeitfenster in Tagen, das die Route angewendet hat (Default 30, max 90). */
  tage: number;
}

/** Zeile von finanzen.zugriffe_zaehlung(p_von, p_bis) — Wochen-Digest zählt
 *  SERVER-SEITIG (PostgREST max_rows = 1000 würde JS-Gruppierung still
 *  unterzählen). Nur Zahlen, keine Beträge/Dokumentnamen. */
export interface ZugriffeZaehlungRow {
  actor_label: string;
  finanzen: number;
  lohn: number;
  /** Einträge mit ziel_profile_id ≠ actor_profile_id (fremde Person). */
  fremde: number;
}

// =====================================================================
// 3. Bexio-Status-Mapping (belegt in scratchpad/bexio/dump.txt Z.42, Z.503;
//    dump2.txt Z.13/37/172)
// =====================================================================

/** kb_invoice.kb_item_status_id: 7 Draft, 8 Pending, 9 Paid, 16 Partial,
 *  19 Canceled, 31 Unpaid. */
export type RechnungStatus =
  | "entwurf"       // 7
  | "offen"         // 8
  | "bezahlt"       // 9
  | "teilbezahlt"   // 16
  | "storniert"     // 19
  | "ueberfaellig"  // 31 (Bexio «Unpaid» — Annahme: offen nach Fälligkeit)
  | "unbekannt";

export const RECHNUNG_STATUS_VON_BEXIO: Readonly<Record<number, RechnungStatus>> = {
  7: "entwurf",
  8: "offen",
  9: "bezahlt",
  16: "teilbezahlt",
  19: "storniert",
  31: "ueberfaellig",
};

/** Bexio-Status-IDs, die als «offener Posten» gelten (Debitoren-Liste,
 *  täglicher Komplett-Reload inkl. Zahlungen + Mahnungen). NUR für diese
 *  läuft der N+1 (payment/kb_reminder) — nie für bezahlte/stornierte. */
export const RECHNUNG_STATUS_OFFEN: readonly number[] = [8, 16, 31];
/** Offerten-Status, die als «offen» gelten (Verwaisten-Prüfung). */
export const OFFERTE_STATUS_OFFEN: readonly number[] = [2];
/** Status-IDs, die in Umsatz-Auswertungen zählen (keine Entwürfe, keine Storni). */
export const RECHNUNG_STATUS_GUELTIG: readonly number[] = [8, 9, 16, 31];

export const RECHNUNG_STATUS_LABEL: Record<RechnungStatus, string> = {
  entwurf: "Entwurf",
  offen: "Offen",
  bezahlt: "Bezahlt",
  teilbezahlt: "Teilbezahlt",
  storniert: "Storniert",
  ueberfaellig: "Überfällig",
  unbekannt: "Unbekannt",
};

/** kb_offer.kb_item_status_id: 1 Draft, 2 Pending, 3 Confirmed, 4 Declined. */
export type OfferteStatus = "entwurf" | "offen" | "bestaetigt" | "abgelehnt" | "unbekannt";
export const OFFERTE_STATUS_VON_BEXIO: Readonly<Record<number, OfferteStatus>> = {
  1: "entwurf",
  2: "offen",
  3: "bestaetigt",
  4: "abgelehnt",
};

/** /4.0/purchase/bills status (dump2.txt Z.37). Wird 1:1 gespeichert. */
export type BillStatus =
  | "DRAFT"
  | "BOOKED"
  | "PARTIALLY_CREATED"
  | "CREATED"
  | "PARTIALLY_SENT"
  | "SENT"
  | "PARTIALLY_DOWNLOADED"
  | "DOWNLOADED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_FAILED"
  | "FAILED";

/** Bill-Status, die NICHT als offener Kreditor zählen. */
export const BILL_STATUS_NICHT_OFFEN: readonly BillStatus[] = ["DRAFT", "PAID"];

export const BILL_STATUS_LABEL: Record<BillStatus, string> = {
  DRAFT: "Entwurf",
  BOOKED: "Verbucht",
  PARTIALLY_CREATED: "Zahlung teilweise erstellt",
  CREATED: "Zahlung erstellt",
  PARTIALLY_SENT: "Teilweise übermittelt",
  SENT: "Übermittelt",
  PARTIALLY_DOWNLOADED: "Teilweise heruntergeladen",
  DOWNLOADED: "Heruntergeladen",
  PARTIALLY_PAID: "Teilbezahlt",
  PAID: "Bezahlt",
  PARTIALLY_FAILED: "Teilweise fehlgeschlagen",
  FAILED: "Fehlgeschlagen",
};

/** /4.0/purchase/outgoing-payments (dump2.txt Z.171-172). */
export type LieferantenZahlungTyp = "IBAN" | "MANUAL" | "CASH_DISCOUNT" | "RECONCILED" | "QR";
export type LieferantenZahlungStatus = "PENDING" | "TRANSFERRED" | "DOWNLOADED" | "ERROR" | "PAID" | "DISCOUNTED";

/** /2.0/accounts account_type (dump2.txt Z.362): 1 Ertrag, 2 Aufwand,
 *  3 Aktiv, 4 Passiv, 5 Abschluss. Saldo-Vorzeichen: Aktiv/Aufwand = Soll−Haben,
 *  Passiv/Ertrag = Haben−Soll. */
export const KONTO_TYP_LABEL: Readonly<Record<number, string>> = {
  1: "Ertrag",
  2: "Aufwand",
  3: "Aktiv",
  4: "Passiv",
  5: "Abschluss",
};

// =====================================================================
// 4. Spiegel-Tabellen (Schema finanzen) — Zeilen-Typen
//    numeric-Spalten kommen als string aus PostgREST.
// =====================================================================

/** Gemeinsame Spalten jeder Spiegel-Zeile. `raw` = komplettes Bexio-Objekt
 *  (unbekannte Felder gehen nicht verloren — Bexio ergänzt Felder ohne
 *  Versionswechsel). */
interface SpiegelBasis {
  /** Komplettes Bexio-Objekt, so wie geliefert. */
  raw: Record<string, unknown>;
  /** Wann der Spiegel diese Zeile zuletzt geschrieben hat (timestamptz). */
  synced_at: string;
}

export interface KontaktRow extends SpiegelBasis {
  id: number;
  nr: string | null;
  name_1: string;
  name_2: string | null;
  /** 1 Firma, 2 Person. */
  contact_type_id: number | null;
  /** Bexio updated_at ('YYYY-MM-DD HH:MM:SS', Zürich) als timestamptz. */
  bexio_updated_at: string | null;
}

export interface RechnungRow extends SpiegelBasis {
  id: number;
  document_nr: string;
  title: string | null;
  contact_id: number | null;
  contact_sub_id: number | null;
  project_id: number | null;
  user_id: number | null;
  currency_id: number | null;
  kb_item_status_id: number;
  status: RechnungStatus;
  total_gross: string | null;
  total_net: string | null;
  total_taxes: string | null;
  total: string | null;
  total_received_payments: string | null;
  total_credit_vouchers: string | null;
  total_remaining_payments: string | null;
  /** Rechnungsdatum (date). */
  is_valid_from: string;
  /** Fälligkeit (date). */
  is_valid_to: string | null;
  reference: string | null;
  api_reference: string | null;
  /** Höchste reminder_level aus finanzen.mahnungen; 0 = keine Mahnung. */
  mahnstufe: number;
  bexio_updated_at: string | null;
}

export interface RechnungZahlungRow extends SpiegelBasis {
  id: number;
  rechnung_id: number;
  datum: string | null;
  betrag: string | null;
  bank_account_id: number | null;
  /** Bexio deklariert integer, liefert Text — tolerant als string. */
  title: string | null;
  payment_service_id: number | null;
  is_cash_discount: boolean;
}

export interface MahnungRow extends SpiegelBasis {
  id: number;
  rechnung_id: number;
  title: string | null;
  is_valid_from: string | null;
  is_valid_to: string | null;
  reminder_level: number;
  is_sent: boolean;
  remaining_price: string | null;
  received_total: string | null;
}

export interface OfferteRow extends SpiegelBasis {
  id: number;
  document_nr: string;
  title: string | null;
  contact_id: number | null;
  contact_sub_id: number | null;
  project_id: number | null;
  user_id: number | null;
  currency_id: number | null;
  kb_item_status_id: number;
  status: OfferteStatus;
  total_gross: string | null;
  total_net: string | null;
  total: string | null;
  is_valid_from: string | null;
  is_valid_until: string | null;
  /** kb_offer liefert KEIN `reference` (nur api_reference) — Spalte gestrichen. */
  api_reference: string | null;
  bexio_updated_at: string | null;
}

export interface LieferantenrechnungRow extends SpiegelBasis {
  /** Bexio-UUID. */
  id: string;
  document_no: string | null;
  title: string | null;
  status: BillStatus;
  vendor: string | null;
  firstname_suffix: string | null;
  lastname_company: string | null;
  supplier_id: number | null;
  vendor_ref: string | null;
  currency_code: string | null;
  net: string | null;
  gross: string | null;
  pending_amount: string | null;
  bill_date: string | null;
  due_date: string | null;
  overdue: boolean;
  /** Bexio created_at (timestamptz). */
  created_at_bexio: string | null;
}

export interface LieferantenZahlungRow extends SpiegelBasis {
  id: string;
  bill_id: string;
  payment_type: LieferantenZahlungTyp | null;
  status: LieferantenZahlungStatus | null;
  execution_date: string | null;
  amount: string | null;
  /** outgoing-payments liefern KEIN currency_code — Spalte gestrichen;
   *  Währung = die der Bill. */
  sender_bank_account_id: number | null;
}

/** Spiegel /3.0/currencies (security: null — jeder gültige Token). Bexio
 *  hat KEIN /2.0/currency. Brücke für rechnungen.currency_id → ISO-Code. */
export interface WaehrungRow extends SpiegelBasis {
  id: number;
  /** ISO 4217, z. B. "CHF". */
  name: string;
  round_factor: string | null;
}

/** Basiswährung der Auswertungen: Kennzahlen/Umsatz summieren NUR diese;
 *  Fremdwährungs-Posten werden gezählt (fremdwaehrung_anzahl), nie blind addiert. */
export const BASIS_WAEHRUNG = "CHF";

export interface KontoRow extends SpiegelBasis {
  id: number;
  uuid: string | null;
  account_no: string | null;
  name: string | null;
  account_type: number | null;
  tax_id: number | null;
  fibu_account_group_id: number | null;
  is_active: boolean;
  is_locked: boolean;
}

export interface KontengruppeRow extends SpiegelBasis {
  id: number;
  uuid: string | null;
  account_no: string | null;
  name: string | null;
  parent_fibu_account_group_id: number | null;
  is_active: boolean;
  is_locked: boolean;
}

export interface JournalBuchungRow extends SpiegelBasis {
  id: number;
  ref_id: number | null;
  ref_uuid: string | null;
  ref_class: string | null;
  /** Buchungsdatum (date) — aus Bexio-ISO per Regex ^\d{4}-\d{2}-\d{2}. */
  datum: string;
  debit_account_id: number | null;
  credit_account_id: number | null;
  description: string | null;
  amount: string | null;
  currency_id: number | null;
  currency_factor: string | null;
  base_currency_id: number | null;
  base_currency_amount: string | null;
}

export interface BankkontoRow extends SpiegelBasis {
  id: number;
  uuid: string | null;
  name: string | null;
  owner: string | null;
  bank_name: string | null;
  iban_nr: string | null;
  currency_id: number | null;
  /** Fibu-Konto (finanzen.konten.id) — Brücke zum Journal-Saldo. */
  account_id: number | null;
  type: string | null;
}

// =====================================================================
// 5. Sync (finanzen.sync_laeufe, finanzen.sync_stand)
// =====================================================================

/** Entitäten des Spiegels — feste Reihenfolge = Abarbeitung im Lauf
 *  (waehrungen VOR rechnungen: die Views joinen darauf). */
export const SYNC_ENTITAETEN = [
  "kontakte",
  "waehrungen",
  "konten",
  "kontengruppen",
  "bankkonten",
  "rechnungen",
  "offerten",
  "lieferantenrechnungen",
  "journal",
] as const;
export type SyncEntitaet = (typeof SYNC_ENTITAETEN)[number];

export type SyncArt = "cron" | "manuell";

/** Doppelstart-Sperre: ein 'laeuft'-Eintrag jünger als das gilt als aktiv
 *  (409). DB-Garantie zusätzlich: unique index sync_laeufe_ein_laufender. */
export const SYNC_SPERRE_MS = 15 * 60 * 1000;
/** Ab diesem Alter eines 'laeuft'-Eintrags zeigt die Seite «Abgleich
 *  abgebrochen — nächster Versuch ab hh:mm» statt Spinner (maxDuration 300 s
 *  → nach 5 min ist die Lambda sicher tot). */
export const SYNC_TOT_NACH_MS = 6 * 60 * 1000;
/** Zeitbudget eines Laufs (Lambda maxDuration 300 s): jede Entität prüft vor
 *  jedem Bexio-Call `Date.now() < ctx.frist` (= gestartet + Budget) und
 *  bricht sonst sauber als 'teilweise' ab — nie Lambda-Kill. */
export const SYNC_ZEITBUDGET_MS = 240 * 1000;
/** Delta-Überlappung: Wasserzeichen − 26 h. Deckt jede Zeitzonen-/DST-
 *  Fehlinterpretation des Bexio-Suchwerts ab (Upsert ist idempotent, das
 *  Delta-Volumen bleibt bei täglichem Lauf winzig). */
export const DELTA_UEBERLAPPUNG_MS = 26 * 60 * 60 * 1000;
/** Verwaisten-Prüfung (Spiegel «offen», von Bexio nicht mehr geliefert):
 *  höchstens so viele Einzel-GETs pro Lauf, Rest im nächsten Lauf. */
export const SYNC_VERWAIST_MAX_PRO_LAUF = 200;
/** Journal: Startdatum (Gründung 2026-03-09, keine älteren Buchungen). */
export const JOURNAL_AB = "2026-01-01";
/** Lieferantenrechnungen: Vollabgleich-Fenster bill_date_start (≈ 15 Monate). */
export const BILLS_FENSTER_TAGE = 456;

/** Body POST /api/finanzen/sync. `voll: true` ignoriert alle Wasserzeichen
 *  (Neuaufbau nach scripts/finanzen-neuaufbau.sql). */
export interface SyncStartBody {
  voll?: boolean;
}
/** 'laeuft' → beim Abschluss 'ok' | 'teilweise' (mind. eine Entität mit
 *  Fehler) | 'fehler' (Lauf als Ganzes abgebrochen) | 'abgebrochen'
 *  (veralteter 'laeuft'-Eintrag > 15 min, vom nächsten Lauf markiert). */
export type SyncStatus = "laeuft" | "ok" | "teilweise" | "fehler" | "abgebrochen";

/** Ergebnis je Entität — landet in sync_laeufe.ergebnis[entitaet].
 *  `fehler` ist ein KURZTEXT ohne Beträge/Namen (z. B. "HTTP 403", "Timeout",
 *  "Zeitbudget: 12 von 40 Rechnungen ohne Zahlungen/Mahnungen"). */
export interface SyncEntitaetErgebnis {
  entitaet: SyncEntitaet;
  /** Geschriebene Zeilen (Upserts) in diesem Lauf. */
  anzahl: number;
  fehler: string | null;
  /** false = Bexio liefert 403/404 für diese Entität (z. B. Journal). */
  verfuegbar: boolean;
  /** Neues Wasserzeichen (timestamptz ISO) oder null = unverändert. Regel:
   *  nur setzen, wenn die KOPFDATEN der Entität vollständig durchliefen
   *  (alle Seiten geladen). Ein Zeitbudget-Abbruch im N+1 (Zahlungen/
   *  Mahnungen) setzt es trotzdem — der nächste Lauf lädt alle offenen
   *  Rechnungen ohnehin komplett neu. */
  wasserzeichen: string | null;
}

export interface SyncLaufRow {
  id: string;
  gestartet: string;
  beendet: string | null;
  art: SyncArt;
  status: SyncStatus;
  /** profiles.id bei 'manuell', null bei 'cron'. */
  ausgeloest_von: string | null;
  /** { [entitaet]: SyncEntitaetErgebnis } — ohne Beträge. */
  ergebnis: Partial<Record<SyncEntitaet, SyncEntitaetErgebnis>>;
  /** Kurztext bei status 'fehler' (ohne Beträge/Namen). */
  fehler: string | null;
}

export interface SyncStandRow {
  entitaet: SyncEntitaet;
  /** Delta-Wasserzeichen (timestamptz) — null = noch nie vollständig geladen. */
  wasserzeichen: string | null;
  letzter_erfolg: string | null;
  /** false = Bexio liefert diese Entität nicht (Scope/Modul/Endpunkt). */
  verfuegbar: boolean;
  /** Hinweis für die Seite, z. B. "Bexio antwortet 404 — Journal nicht verfügbar". */
  hinweis: string | null;
  updated_at: string;
}

/** Rückgabe von finanzenSyncAusfuehren() (src/lib/finanzen/spiegel/index.ts). */
export interface SyncLaufErgebnis {
  lauf: SyncLaufRow;
  entitaeten: SyncEntitaetErgebnis[];
}

/** Antwort GET /api/finanzen/sync-status. */
export interface SyncStatusAntwort {
  success: true;
  verbunden: boolean;
  /** Alle Pflicht-Scopes (FINANZ_SCOPES in bexio.ts) in bexio_connection.scope vorhanden. */
  scopesOk: boolean;
  /** Welche Pflicht-Scopes fehlen (leer wenn scopesOk) — für die amber-Box. */
  scopesFehlend: string[];
  /** 'laeuft'-Eintrag jünger als SYNC_SPERRE_MS vorhanden. */
  laeuft: boolean;
  letzterLauf: SyncLaufRow | null;
  stand: SyncStandRow[];
}

/** Antwort POST /api/finanzen/sync (200) — bei 409 FINANZEN_FEHLER.SYNC_LAEUFT. */
export interface SyncStartAntwort {
  success: true;
  lauf: SyncLaufRow;
}

/** Antwort des Crons /api/cron/finanzen-sync. */
export type SyncCronAntwort =
  | { success: true; skipped: "nicht verbunden" | "scope" | "laeuft" }
  | { success: true; lauf: SyncLaufRow }
  | { success: false; error: string };

// =====================================================================
// 6. Seite /finanzen — Routen-Antworten (Beträge als number, Daten als
//    "YYYY-MM-DD"; die Route wandelt numeric-Strings mit Number()).
// =====================================================================

/** finanzen.kennzahlen() → GET /api/finanzen/uebersicht */
export interface Kennzahlen {
  jahr: number;
  /** Stichtag Zürich (YYYY-MM-DD) — Basis für «überfällig» und Vorjahres-Zeitraum. */
  stichtag: string;
  debitoren: {
    offen_summe: number;
    offen_anzahl: number;
    ueberfaellig_summe: number;
    ueberfaellig_anzahl: number;
  };
  kreditoren: {
    offen_summe: number;
    offen_anzahl: number;
    ueberfaellig_summe: number;
    ueberfaellig_anzahl: number;
  };
  umsatz: {
    /** 1.1. des laufenden Jahres bis Stichtag, total_net gültiger CHF-Rechnungen. */
    jahr_summe: number;
    /** 1.1. des Vorjahres bis Stichtag minus 1 Jahr. */
    vorjahr_gleicher_zeitraum_summe: number;
  };
  /** Offene Debitoren + Kreditoren in Fremdwährung (≠ BASIS_WAEHRUNG) — sie
   *  fehlen in allen Summen; die Seite zeigt «n Posten in Fremdwährung». */
  fremdwaehrung_anzahl: number;
}
export interface UebersichtAntwort {
  success: true;
  kennzahlen: Kennzahlen;
}

/** finanzen.v_offene_debitoren → GET /api/finanzen/offene-posten */
export interface OffenerDebitor {
  rechnung_id: number;
  document_nr: string;
  /** kontakte.name_1 (+ " " + name_2) — "Unbekannt (#id)" wenn Kontakt fehlt. */
  kunde: string;
  contact_id: number | null;
  datum: string;
  faellig: string | null;
  /** 0 wenn nicht fällig/kein Datum. */
  tage_ueberfaellig: number;
  betrag_offen: number;
  betrag_total: number;
  status: RechnungStatus;
  mahnstufe: number;
  /** ISO-Code aus finanzen.waehrungen (null = unbekannt → als CHF anzeigen). */
  waehrung: string | null;
  /** bexioInvoiceUrl(rechnung_id) — gesetzt von der Route. */
  bexio_url: string;
}
export interface OffenePostenAntwort {
  success: true;
  posten: OffenerDebitor[];
}

/** finanzen.v_offene_kreditoren → GET /api/finanzen/kreditoren */
export interface OffenerKreditor {
  bill_id: string;
  document_no: string | null;
  lieferant: string;
  datum: string | null;
  faellig: string | null;
  tage_ueberfaellig: number;
  betrag_offen: number;
  betrag_total: number;
  status: BillStatus;
  waehrung: string | null;
}
export interface KreditorenAntwort {
  success: true;
  posten: OffenerKreditor[];
}

/** finanzen.umsatz_monate(p_jahr) → GET /api/finanzen/umsatz?jahr=YYYY — 12 Zeilen.
 *  Nur CHF-Rechnungen, netto, ohne Gutschriften (Welle 2). */
export interface UmsatzMonat {
  /** 1..12 */
  monat: number;
  umsatz: number;
  umsatz_vorjahr: number;
}
export interface UmsatzAntwort {
  success: true;
  jahr: number;
  monate: UmsatzMonat[];
}

/** finanzen.v_bankkonten_saldo → GET /api/finanzen/bankkonten */
export interface BankkontoSaldo {
  bankkonto_id: number;
  name: string | null;
  bank_name: string | null;
  iban_nr: string | null;
  account_id: number | null;
  account_no: string | null;
  /** Σ Soll − Σ Haben in base_currency_amount über alle gespiegelten Buchungen. */
  saldo: number;
  buchungen_anzahl: number;
  letzte_buchung: string | null;
}
export interface BankkontenAntwort {
  success: true;
  /** false = Journal nicht verfügbar → Seite zeigt Hinweis statt Salden. */
  verfuegbar: boolean;
  hinweis: string | null;
  konten: BankkontoSaldo[];
}

// =====================================================================
// 7. Fehler-Antwort (gemeinsame Form, wie api-auth.ts)
// =====================================================================

export interface FinanzenFehlerAntwort {
  success: false;
  /** Slug (FinanzenFehlerSlug) oder freier Text bei 5xx. */
  error: string;
  message?: string;
}

/** Ergebnis von finanzenFetch() im Client (src/components/finanzen/finanzen-fetch.ts).
 *  `slug` via istFinanzenFehlerSlug(json.error), sonst "andere". */
export type FinanzenFetchErgebnis<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; slug: FinanzenFehlerSlug | "andere"; message: string };
