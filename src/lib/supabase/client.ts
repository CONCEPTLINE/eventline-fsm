import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel, RealtimeChannelOptions, SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { IMPERSONATE_COOKIE } from "@/lib/impersonation";

// Browser-Client als Singleton — mehrere Hooks (useStempel, usePermissions,
// jede Page) wuerden sonst parallel Auth-Token-Locks anfordern, was zu
// "AbortError: Lock broken by another request" fuehrt. EIN Client pro Tab
// teilt sich den Auth-State sauber.
//
// Wir parken die Instanz auf dem window-Objekt damit Hot-Reload im Dev-
// Modus nicht jedes Mal einen neuen Client erzeugt (das wuerde dieselbe
// Lock-Kollision wieder ausloesen, wenn HMR Module-Variablen verliert).
declare global {
  interface Window {
    __eventlineSupabaseClient?: SupabaseClient;
  }
}

// -------------------------------------------------------------
// Read-only-Guard fuer Developer-Mode / View-As
// -------------------------------------------------------------
//
// Middleware (src/middleware.ts) blockt bereits POST/PUT/PATCH/DELETE auf
// /api/*, wenn IMPERSONATE_COOKIE gesetzt und WRITE_COOKIE != "1" ist.
// ABER: viele Aktionen im Frontend gehen direkt gegen Supabase's
// PostgREST-/Storage-Endpunkte (z. B. `supabase.from('todos').insert(...)`)
// — die laufen NICHT durch unsere Next-Middleware. Der Read-Only-Modus
// wuerde dort leaken.
//
// Deshalb wrappen wir den Browser-Client in einen Proxy, der bei jedem
// `.from(table).<mutate>(...)` und `.storage.from(bucket).<mutate>(...)`
// LIVE die Cookies prueft und im Read-Only-Fall eine synthetische Fehler-
// Antwort zurueckgibt — statt tatsaechlich zu schreiben.
//
// RPC bleibt bewusst UNGESCHUETZT — kann auch ein reiner Read-Call sein,
// das False-Positive-Risiko ist zu hoch.

const IMPERSONATE_WRITE_COOKIE = "eventline_impersonate_write";

const READ_ONLY_MESSAGE =
  "Nur-Lesen-Modus aktiv (Entwickler-Modus)";
const READ_ONLY_TOAST =
  "Änderung blockiert — Nur-Lesen-Modus. Bearbeitung im Overlay aktivieren.";

// Toast-Throttle: bei Batch-Inserts / Autosave-Loops feuert der Guard sonst
// pro Sekunde 10x — der User sieht dann nur noch Toast-Stacks. 3s reicht,
// die Meldung ist beim ersten Trigger sowieso klar.
let lastToastAt = 0;
const TOAST_THROTTLE_MS = 3000;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie;
  if (!raw) return null;
  const needle = name + "=";
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (p.startsWith(needle)) {
      try {
        return decodeURIComponent(p.slice(needle.length));
      } catch {
        return p.slice(needle.length);
      }
    }
  }
  return null;
}

function shouldBlockWrite(): boolean {
  // SSR-safe: auf dem Server nie blocken (Cookies liegen dort ohnehin
  // ueber requireImpersonation/route.ts, die den Guard woanders machen).
  if (typeof document === "undefined") return false;
  const impersonating = readCookie(IMPERSONATE_COOKIE);
  if (!impersonating) return false;
  const writeEnabled = readCookie(IMPERSONATE_WRITE_COOKIE) === "1";
  return !writeEnabled;
}

function emitBlockedToast(): void {
  const now = Date.now();
  if (now - lastToastAt < TOAST_THROTTLE_MS) return;
  lastToastAt = now;
  try {
    toast.error(READ_ONLY_TOAST);
  } catch {
    // sonner Toaster evtl. noch nicht gemountet — Fehler wird ohnehin
    // via error-Objekt an den Caller zurueckgegeben.
  }
}

function makeBlockedError() {
  return {
    message: READ_ONLY_MESSAGE,
    code: "developer_mode_read_only",
    details: null,
    hint: "Bearbeitung im View-As-Overlay aktivieren (5 Sekunden halten).",
  };
}

/**
 * Ein Thenable, das sich wie ein PostgrestFilterBuilder verhaelt:
 * jede weitere Chain-Methode (.eq, .select, .single, ...) gibt den Chain
 * selbst zurueck; beim `await` resolved er zu { data:null, error }.
 * Damit funktionieren typische Muster wie
 *   await supabase.from(t).insert(row).select().single()
 * ohne dass der Aufrufer eigens auf den Guard reagieren muss.
 */
function makeBlockedPostgrestChain(): unknown {
  const result = {
    data: null,
    error: makeBlockedError(),
    count: null,
    status: 423,
    statusText: "Locked",
  };
  // Reviewer C2: throwOnError() in supabase-js soll den Promise REJECTEN
  // statt {data, error} zu resolven. Der Guard muss dieses Verhalten
  // spiegeln, sonst schluckt ein Caller mit throwOnError den Block-Fehler
  // still (data:null bleibt, aber kein Exception → try/catch greift nicht).
  let throwFlag = false;
  const chain: Record<string | symbol, unknown> = {};
  chain.then = ((onFulfilled: (v: unknown) => unknown, onRejected: (r: unknown) => unknown) => {
    if (throwFlag) return Promise.reject(makeBlockedError()).then(onFulfilled, onRejected);
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }) as unknown;
  chain.catch = ((onRejected: (r: unknown) => unknown) => (chain.then as (a: unknown, b: unknown) => unknown)(undefined, onRejected)) as unknown;
  chain.finally = ((cb: () => void) => Promise.resolve(result).finally(cb)) as unknown;
  // Alle bekannten Chain-Methoden auf sich selbst zurueckmappen.
  const passthroughMethods = [
    "select", "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike",
    "is", "in", "contains", "containedBy", "rangeGt", "rangeGte",
    "rangeLt", "rangeLte", "rangeAdjacent", "overlaps", "textSearch",
    "match", "not", "or", "filter", "order", "limit", "range",
    "abortSignal", "single", "maybeSingle", "csv", "geojson", "explain",
    "rollback", "returns", "setHeader",
  ];
  for (const m of passthroughMethods) {
    (chain as Record<string, unknown>)[m] = () => chain;
  }
  (chain as Record<string, unknown>).throwOnError = () => {
    throwFlag = true;
    return chain;
  };
  return chain;
}

// Mutations auf Tabellenebene (PostgREST).
const BLOCKED_TABLE_METHODS = new Set([
  "insert",
  "update",
  "delete",
  "upsert",
]);

// Mutations auf Storage-Ebene. `list`, `download`, `getPublicUrl`,
// `createSignedUrl` bleiben erlaubt (rein lesend).
const BLOCKED_STORAGE_FILE_METHODS = new Set([
  "upload",
  "uploadToSignedUrl",
  "createSignedUploadUrl",
  "remove",
  "move",
  "copy",
  "update",
]);

// Mutations auf Storage-Root (Bucket-Verwaltung).
const BLOCKED_STORAGE_ROOT_METHODS = new Set([
  "createBucket",
  "updateBucket",
  "deleteBucket",
  "emptyBucket",
]);

function wrapTableBuilder<T extends object>(builder: T): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (
        typeof prop === "string" &&
        BLOCKED_TABLE_METHODS.has(prop) &&
        shouldBlockWrite()
      ) {
        return (..._args: unknown[]) => {
          emitBlockedToast();
          return makeBlockedPostgrestChain();
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

function wrapStorageFileApi<T extends object>(fileApi: T): T {
  return new Proxy(fileApi, {
    get(target, prop, receiver) {
      if (
        typeof prop === "string" &&
        BLOCKED_STORAGE_FILE_METHODS.has(prop) &&
        shouldBlockWrite()
      ) {
        return async (..._args: unknown[]) => {
          emitBlockedToast();
          return { data: null, error: makeBlockedError() };
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

function wrapStorage<T extends object>(storage: T): T {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "from") {
        const originalFrom = (target as unknown as {
          from: (bucket: string) => object;
        }).from.bind(target);
        return (bucket: string) => wrapStorageFileApi(originalFrom(bucket));
      }
      if (
        typeof prop === "string" &&
        BLOCKED_STORAGE_ROOT_METHODS.has(prop) &&
        shouldBlockWrite()
      ) {
        return async (..._args: unknown[]) => {
          emitBlockedToast();
          return { data: null, error: makeBlockedError() };
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

// -------------------------------------------------------------
// Realtime: Login-Token VOR jedem Beitritt
// -------------------------------------------------------------
//
// realtime-js (2.103, unveraendert bis 2.118) friert beim subscribe() den
// Beitritt sofort ein — mit dem Token, das in diesem Moment in
// realtime.accessTokenValue steht. Direkt nach einem Seitenaufruf ist das oft
// noch leer (auth-js liest die Sitzung asynchron): der Kanal tritt dann als
// «anon» bei, die RLS liefert keine Ereignisse, und weil das Token zwischen
// Beitritt und Antwort eintrifft, schickt realtime-js es auch nie nach — still,
// bis zur naechsten Token-Erneuerung (~1 h). Gemessen 2026-10-15 am Kanal der
// Antraege (time_off) nach F5.
//
// Darum tritt jeder Kanal dieses Clients erst bei, wenn das Login-Token
// gesetzt ist (Postgres-Aenderungen, Presence, Broadcast — alle Aufrufer, ohne
// dass sie daran denken muessen). Ist es schon da, laeuft subscribe() wie
// immer synchron. Erneuerte Tokens reicht supabase-js selbst an alle Kanaele
// weiter (TOKEN_REFRESHED → realtime.setAuth(token)).

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function realtimeTokenGesetzt(raw: SupabaseClient): boolean {
  const token = raw.realtime.accessTokenValue;
  return !!token && token !== ANON_KEY;
}

// Ein gemeinsamer Lauf fuer alle Kanaele, die beim Seitenstart gleichzeitig
// beitreten wollen (eine Sitzungsabfrage statt einer je Kanal).
let tokenLauf: Promise<void> | null = null;
function realtimeTokenSetzen(raw: SupabaseClient): Promise<void> {
  tokenLauf ??= (async () => {
    try {
      const { data } = await raw.auth.getSession();
      const token = data.session?.access_token;
      if (token && raw.realtime.accessTokenValue !== token) await raw.realtime.setAuth(token);
    } catch {
      // Ohne Sitzung/Netz: Beitritt wie bisher; supabase-js reicht das Token
      // bei SIGNED_IN/TOKEN_REFRESHED an die beigetretenen Kanaele nach.
    }
  })().finally(() => {
    tokenLauf = null;
  });
  return tokenLauf;
}

const abgesicherteKanaele = new WeakSet<RealtimeChannel>();
function kanalAbsichern(raw: SupabaseClient, kanal: RealtimeChannel): RealtimeChannel {
  // channel() liefert bei gleichem Topic denselben Kanal — nur einmal absichern.
  if (abgesicherteKanaele.has(kanal)) return kanal;
  abgesicherteKanaele.add(kanal);
  const beitreten = kanal.subscribe.bind(kanal);
  kanal.subscribe = ((...args: Parameters<RealtimeChannel["subscribe"]>) => {
    if (realtimeTokenGesetzt(raw)) return beitreten(...args);
    void realtimeTokenSetzen(raw).then(() => {
      // Inzwischen abgemeldet (removeChannel/unsubscribe) → nicht mehr beitreten.
      if (!raw.realtime.getChannels().includes(kanal)) return;
      beitreten(...args);
    });
    return kanal;
  }) as RealtimeChannel["subscribe"];
  return kanal;
}

function wrapClientWithGuard(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "channel") {
        const originalChannel = target.channel.bind(target);
        return (name: string, opts?: RealtimeChannelOptions) =>
          kanalAbsichern(target, originalChannel(name, opts));
      }
      if (prop === "from") {
        const originalFrom = target.from.bind(target);
        return (relation: string) =>
          wrapTableBuilder(
            originalFrom(relation) as unknown as object,
          );
      }
      if (prop === "storage") {
        // Storage wird bei jedem Zugriff frisch gewrapped — der interne
        // Storage-Client ist stabil, aber wir wollen nicht cachen falls
        // supabase-js irgendwann getter-basiert refreshed.
        const originalStorage = Reflect.get(target, prop, target) as object;
        return wrapStorage(originalStorage);
      }
      // functions.invoke ist quasi immer ein write-Aktion (Server-side
      // Aktion via Edge Function). Blocken wenn Read-Only.
      if (prop === "functions") {
        const originalFunctions = Reflect.get(target, prop, target) as unknown as object;
        return new Proxy(originalFunctions, {
          get(innerTarget, innerProp) {
            if (innerProp === "invoke" && shouldBlockWrite()) {
              return async (..._args: unknown[]) => {
                emitBlockedToast();
                return { data: null, error: makeBlockedError() };
              };
            }
            const v = Reflect.get(innerTarget, innerProp);
            return typeof v === "function" ? v.bind(innerTarget) : v;
          },
        });
      }
      // auth.updateUser: veraendert User-Konto → blocken.
      if (prop === "auth") {
        const originalAuth = Reflect.get(target, prop, target) as unknown as object;
        return new Proxy(originalAuth, {
          get(innerTarget, innerProp) {
            if (innerProp === "updateUser" && shouldBlockWrite()) {
              return async (..._args: unknown[]) => {
                emitBlockedToast();
                return { data: null, error: makeBlockedError() };
              };
            }
            const v = Reflect.get(innerTarget, innerProp);
            return typeof v === "function" ? v.bind(innerTarget) : v;
          },
        });
      }
      // RPC bleibt bewusst UNGESCHUETZT — SQL-Funktionen koennen read ODER
      // write sein, und ein pauschaler Block wuerde legitime Read-RPCs
      // (has_permission, get_dashboard_data etc.) sperren. Server-seitige
      // RLS + explizite Auth-Checks in den RPCs sind die richtige
      // Verteidigung. Der Client-Guard ist ohnehin nur UI-Schutz gegen
      // versehentliches Klicken, kein echtes Security-Boundary (S2 im
      // Adversarial-Review).
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as SupabaseClient;
}

export function createClient(): SupabaseClient {
  if (typeof window === "undefined") {
    // SSR: jeder Aufruf bekommt einen eigenen Client (ueblicher Server-Pfad).
    // Guard nicht noetig — kein document, keine Cookies via document.cookie.
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  if (window.__eventlineSupabaseClient) return window.__eventlineSupabaseClient;
  const raw = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  window.__eventlineSupabaseClient = wrapClientWithGuard(raw);
  return window.__eventlineSupabaseClient;
}
