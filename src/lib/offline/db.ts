// IndexedDB-Wrapper fuer die Offline-Schicht (ohne Fremdbibliothek).
//
// DB "eventline-offline", Version 2:
//   stempel_ops    — Warteschlange der Stempel-Aktionen (op_id PK, Index user_seq
//                    auf [user_id, seq]). Wird strikt nach seq je user gesendet.
//   cache          — zuletzt online geladene Daten fuer die Auswahl ohne Netz
//                    (key PK = "<user_id>:<name>", Index user_id). Aufraeumen
//                    nach Alter braeuchte ein DB_VERSION-Upgrade mit Index stand_at.
//   rapport_drafts — Rapport-Entwurf je Auftrag (job_id PK, user_id): write-
//                    ahead fuer jede Eingabe, Sync-Zustand (base_updated_at,
//                    dirty, finalize_requested_at, status). Version 2.
//   blobs          — Fotos (komprimiert) und Unterschriften (PNG) eines
//                    Entwurfs bis zum erfolgreichen Upload (local_id PK,
//                    Index report_id). Version 2.
//
// Alle Stores tragen user_id: mehrere Nutzer auf demselben Geraet teilen
// sich die DB, sehen aber nur ihre eigenen Zeilen. Beim ersten Schreiben
// wird navigator.storage.persist() angefragt, damit der Browser die Daten
// nicht unter Speicherdruck wegwirft.
//
// Zeiten: client_ts / stand_at sind UTC-ISO-Strings. Anzeige immer ueber
// die format-Helfer (Europe/Zurich).

export const OFFLINE_DB_NAME = "eventline-offline";
const DB_VERSION = 2;

export type StempelOpKind = "clock_in" | "clock_out" | "switch_tier";
export type StempelOpStatus = "wartet" | "sendet" | "fehler" | "konflikt" | "abgelehnt";

export interface StempelOpPayload {
  job_id: string | null;
  project_id: string | null;
  description: string | null;
  rate_tier_id: string | null;
  /** clock_out: clock_in des zu schliessenden Eintrags (fuer die Sperr-
   *  Vorpruefung ohne Netz). switch_tier: clock_in des Vorgaengers. */
  clock_in?: string | null;
  /** switch_tier: id des Eintrags, der geschlossen wird. */
  prev_entry_id?: string | null;
}

export interface StempelOp {
  op_id: string;
  user_id: string;
  seq: number;
  kind: StempelOpKind;
  /** time_entries.id — vom Client vergeben (Idempotenz-Schluessel). */
  entry_id: string;
  payload: StempelOpPayload;
  /** Handy-Uhr zum Zeitpunkt der Aktion, UTC-ISO. */
  client_ts: string;
  device_id: string;
  attempts: number;
  status: StempelOpStatus;
  last_error: string | null;
}

export interface CacheEintrag<T = unknown> {
  key: string;
  user_id: string;
  name: string;
  data: T;
  /** UTC-ISO des Ladezeitpunkts («Stand 07:42»). */
  stand_at: string;
}

// ---------------------------------------------------------------------------
// Rapport-Entwurf (Version 2)
// ---------------------------------------------------------------------------

export type RapportDraftStatus =
  | "lokal"                 // auf dem Geraet, noch nicht (vollstaendig) am Server
  | "sendet"                // Sync-Lauf aktiv
  | "gesendet"              // Server hat den aktuellen Stand
  | "konflikt"              // Server wurde parallel geaendert — Nutzer entscheidet
  | "fehler"                // Server-Fehler (z. B. kein Schreibrecht) — Nutzer sieht Grund
  | "bereits_abgeschlossen" // am Server schon abgeschlossen — Nachtrag ans Buero
  | "abgeschlossen";        // Abschluss durch, PDF (sofern erzeugt) in pdf_url

export interface RapportDraftTimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  technician_id: string;
  not_billable?: boolean;
  not_billable_reason?: string;
  rate_tier_id?: string | null;
  quelle?: "stempel" | "termin";
}

export interface RapportDraftForm {
  work_description: string;
  equipment_used: string;
  issues: string;
  client_name: string;
  signer_type: "kunde" | "mieter";
  signer_role: string;
  client_absent: boolean;
  technician_id: string;
  technician_name: string;
  time_ranges: RapportDraftTimeRange[];
  /** Storage-Pfade bereits gespeicherter Unterschriften (Server-Stand). */
  signature_url: string | null;
  technician_signature_url: string | null;
}

export interface RapportDraft {
  /** Key: ein Entwurf je Auftrag und Geraet. */
  job_id: string;
  user_id: string;
  /** Client-UUID; Pfad fuer Blobs und (wenn der Insert durchging) die Server-ID. */
  report_id: string;
  /** service_reports.id, sobald eine Server-Zeile bekannt ist (eigene oder zusammengefuehrte). */
  server_id: string | null;
  /** service_reports.updated_at des zuletzt gelesenen/geschriebenen Server-Stands. */
  base_updated_at: string | null;
  form: RapportDraftForm;
  local_updated_at: string;
  dirty: boolean;
  finalize_requested_at: string | null;
  status: RapportDraftStatus;
  last_error: string | null;
  /** Name des anderen Technikers, mit dessen Entwurf zusammengefuehrt wurde (Hinweiszeile). */
  merged_with: string | null;
  /** Server-Stand im Konfliktfall (fuer «Server-Version uebernehmen»). */
  server_form: RapportDraftForm | null;
  pdf_url: string | null;
}

export type RapportBlobKind = "photo" | "sig_tech" | "sig_client";
export type RapportBlobStatus = "wartet" | "sendet" | "fehler";

export interface RapportBlob {
  local_id: string;
  user_id: string;
  report_id: string;
  kind: RapportBlobKind;
  blob: Blob;
  caption: string | null;
  sort: number;
  upload_status: RapportBlobStatus;
}

const STORE_OPS = "stempel_ops";
const STORE_CACHE = "cache";
const STORE_DRAFTS = "rapport_drafts";
const STORE_BLOBS = "blobs";
const IDX_USER_SEQ = "user_seq";
const IDX_USER = "user_id";
const IDX_REPORT = "report_id";

export function istIdbVerfuegbar(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

/** QuotaExceededError (Chrome/Safari/Firefox nennen ihn unterschiedlich). */
export function istQuotaFehler(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  return e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB-Fehler"));
  });
}

function abschluss(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB-Transaktion abgebrochen"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB-Fehler"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!istIdbVerfuegbar()) return Promise.reject(new Error("IndexedDB nicht verfügbar"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        const ops = db.createObjectStore(STORE_OPS, { keyPath: "op_id" });
        ops.createIndex(IDX_USER_SEQ, ["user_id", "seq"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        const cache = db.createObjectStore(STORE_CACHE, { keyPath: "key" });
        cache.createIndex(IDX_USER, "user_id", { unique: false });
      }
      // Version 2: Rapport-Entwuerfe + Blobs. Bestehende Stores bleiben.
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        const drafts = db.createObjectStore(STORE_DRAFTS, { keyPath: "job_id" });
        drafts.createIndex(IDX_USER, "user_id", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        const blobs = db.createObjectStore(STORE_BLOBS, { keyPath: "local_id" });
        blobs.createIndex(IDX_REPORT, "report_id", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Ein anderer Tab will upgraden → schliessen, naechster Aufruf oeffnet neu.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("IndexedDB konnte nicht geöffnet werden"));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("IndexedDB blockiert (anderer Tab)"));
    };
  });
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Dauerhafter Speicher — einmal je Seitenlauf anfragen (beim ersten Schreiben).
// ---------------------------------------------------------------------------

let persistAngefragt = false;
export function persistAnfragen(): void {
  if (persistAngefragt) return;
  persistAngefragt = true;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Geraete-ID (stabil je Browser-Profil; Reihenfolge gilt nur je Geraet).
// ---------------------------------------------------------------------------

const DEVICE_KEY = "eventline-device-id";
let deviceIdSession: string | null = null;
export function deviceId(): string {
  if (deviceIdSession) return deviceIdSession;
  let id: string | null = null;
  try {
    if (typeof window !== "undefined") id = window.localStorage.getItem(DEVICE_KEY);
  } catch {
    id = null;
  }
  if (!id) {
    id = crypto.randomUUID();
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* privater Modus — ID gilt dann nur fuer diesen Seitenlauf */
    }
  }
  deviceIdSession = id;
  return id;
}

// ---------------------------------------------------------------------------
// stempel_ops
// ---------------------------------------------------------------------------

function userBereich(userId: string): IDBKeyRange {
  return IDBKeyRange.bound([userId, -Infinity], [userId, Infinity]);
}

/** Alle Aktionen eines Nutzers, aufsteigend nach seq. */
export async function ladeOps(userId: string): Promise<StempelOp[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_OPS, "readonly");
  const idx = tx.objectStore(STORE_OPS).index(IDX_USER_SEQ);
  const rows = await request(idx.getAll(userBereich(userId)));
  return (rows as StempelOp[]).sort((a, b) => a.seq - b.seq);
}

/**
 * Haengt eine Aktion ans Ende der Warteschlange des Nutzers. seq wird in
 * derselben Transaktion aus dem hoechsten vorhandenen Wert bestimmt — zwei
 * schnelle Aktionen bekommen so nie dieselbe Nummer. Wirft bei Quota-/IDB-
 * Fehlern (Aufrufer: write-ahead, erst nach Erfolg bestaetigen).
 */
export async function fuegeOpEin(
  op: Omit<StempelOp, "seq" | "attempts" | "status" | "last_error" | "device_id">,
): Promise<StempelOp> {
  persistAnfragen();
  const db = await openDb();
  const tx = db.transaction(STORE_OPS, "readwrite");
  const store = tx.objectStore(STORE_OPS);
  const cursor = await request(store.index(IDX_USER_SEQ).openCursor(userBereich(op.user_id), "prev"));
  const letzteSeq = cursor ? (cursor.value as StempelOp).seq : 0;
  const voll: StempelOp = {
    ...op,
    seq: letzteSeq + 1,
    device_id: deviceId(),
    attempts: 0,
    status: "wartet",
    last_error: null,
  };
  store.put(voll);
  await abschluss(tx);
  return voll;
}

export async function aktualisiereOp(opId: string, patch: Partial<Omit<StempelOp, "op_id" | "user_id">>): Promise<StempelOp | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_OPS, "readwrite");
  const store = tx.objectStore(STORE_OPS);
  const row = (await request(store.get(opId))) as StempelOp | undefined;
  if (!row) return null;
  const neu = { ...row, ...patch };
  store.put(neu);
  await abschluss(tx);
  return neu;
}

export async function loescheOps(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_OPS, "readwrite");
  const store = tx.objectStore(STORE_OPS);
  for (const id of opIds) store.delete(id);
  await abschluss(tx);
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

function cacheKey(userId: string, name: string): string {
  return `${userId}:${name}`;
}

export async function cacheSchreiben<T>(userId: string, name: string, data: T): Promise<void> {
  persistAnfragen();
  const db = await openDb();
  const tx = db.transaction(STORE_CACHE, "readwrite");
  const eintrag: CacheEintrag<T> = {
    key: cacheKey(userId, name),
    user_id: userId,
    name,
    data,
    stand_at: new Date().toISOString(),
  };
  tx.objectStore(STORE_CACHE).put(eintrag);
  await abschluss(tx);
}

export async function cacheLesen<T>(userId: string, name: string): Promise<CacheEintrag<T> | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_CACHE, "readonly");
  const row = await request(tx.objectStore(STORE_CACHE).get(cacheKey(userId, name)));
  return (row as CacheEintrag<T> | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// rapport_drafts
// ---------------------------------------------------------------------------

/** Entwurf eines Auftrags — nur wenn er dem Nutzer gehoert (user_id). */
export async function ladeRapportDraft(jobId: string, userId: string): Promise<RapportDraft | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_DRAFTS, "readonly");
  const row = (await request(tx.objectStore(STORE_DRAFTS).get(jobId))) as RapportDraft | undefined;
  if (!row || row.user_id !== userId) return null;
  return row;
}

/** Alle Entwuerfe des Nutzers (fuer den Sync aller wartenden Rapporte). */
export async function ladeRapportDrafts(userId: string): Promise<RapportDraft[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_DRAFTS, "readonly");
  const rows = await request(tx.objectStore(STORE_DRAFTS).index(IDX_USER).getAll(userId));
  return rows as RapportDraft[];
}

/** Schreibt den Entwurf vollstaendig (write-ahead). Wirft bei Quota-/IDB-Fehlern. */
export async function speichereRapportDraft(draft: RapportDraft): Promise<void> {
  persistAnfragen();
  const db = await openDb();
  const tx = db.transaction(STORE_DRAFTS, "readwrite");
  tx.objectStore(STORE_DRAFTS).put(draft);
  await abschluss(tx);
}

/** Teil-Update in einer Transaktion (Lesen + Schreiben atomar). null = kein Entwurf. */
export async function aktualisiereRapportDraft(
  jobId: string,
  patch: Partial<Omit<RapportDraft, "job_id" | "user_id">>,
): Promise<RapportDraft | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_DRAFTS, "readwrite");
  const store = tx.objectStore(STORE_DRAFTS);
  const row = (await request(store.get(jobId))) as RapportDraft | undefined;
  if (!row) return null;
  const neu = { ...row, ...patch };
  store.put(neu);
  await abschluss(tx);
  return neu;
}

/** Entwurf samt seiner Blobs entfernen. */
export async function loescheRapportDraft(jobId: string, reportId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_DRAFTS, STORE_BLOBS], "readwrite");
  tx.objectStore(STORE_DRAFTS).delete(jobId);
  const idx = tx.objectStore(STORE_BLOBS).index(IDX_REPORT);
  const keys = await request(idx.getAllKeys(reportId));
  for (const k of keys) tx.objectStore(STORE_BLOBS).delete(k);
  await abschluss(tx);
}

// ---------------------------------------------------------------------------
// blobs
// ---------------------------------------------------------------------------

export async function ladeBlobs(reportId: string): Promise<RapportBlob[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readonly");
  const rows = await request(tx.objectStore(STORE_BLOBS).index(IDX_REPORT).getAll(reportId));
  return (rows as RapportBlob[]).sort((a, b) => a.sort - b.sort);
}

/** Schreibt einen Blob (write-ahead). Wirft bei Quota-/IDB-Fehlern. */
export async function speichereBlob(blob: RapportBlob): Promise<void> {
  persistAnfragen();
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readwrite");
  tx.objectStore(STORE_BLOBS).put(blob);
  await abschluss(tx);
}

export async function aktualisiereBlob(localId: string, patch: Partial<Pick<RapportBlob, "upload_status" | "caption" | "report_id">>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readwrite");
  const store = tx.objectStore(STORE_BLOBS);
  const row = (await request(store.get(localId))) as RapportBlob | undefined;
  if (!row) return;
  store.put({ ...row, ...patch });
  await abschluss(tx);
}

export async function loescheBlob(localId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readwrite");
  tx.objectStore(STORE_BLOBS).delete(localId);
  await abschluss(tx);
}
