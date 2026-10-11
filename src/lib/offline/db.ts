// IndexedDB-Wrapper fuer die Offline-Schicht (ohne Fremdbibliothek).
//
// DB "eventline-offline", Version 1:
//   stempel_ops  — Warteschlange der Stempel-Aktionen (op_id PK, Index user_seq
//                  auf [user_id, seq]). Wird strikt nach seq je user gesendet.
//   cache        — zuletzt online geladene Daten fuer die Auswahl ohne Netz
//                  (key PK = "<user_id>:<name>", Index user_id, stand_at).
//
// Alle Stores tragen user_id: mehrere Nutzer auf demselben Geraet teilen
// sich die DB, sehen aber nur ihre eigenen Zeilen. Beim ersten Schreiben
// wird navigator.storage.persist() angefragt, damit der Browser die Daten
// nicht unter Speicherdruck wegwirft.
//
// Zeiten: client_ts / stand_at sind UTC-ISO-Strings. Anzeige immer ueber
// die format-Helfer (Europe/Zurich).

export const OFFLINE_DB_NAME = "eventline-offline";
const DB_VERSION = 1;

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

const STORE_OPS = "stempel_ops";
const STORE_CACHE = "cache";
const IDX_USER_SEQ = "user_seq";
const IDX_USER = "user_id";

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

export async function ladeOp(opId: string): Promise<StempelOp | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_OPS, "readonly");
  const row = await request(tx.objectStore(STORE_OPS).get(opId));
  return (row as StempelOp | undefined) ?? null;
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
