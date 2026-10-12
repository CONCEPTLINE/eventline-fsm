"use client";

// Stempel-Provider + useStempel-Hook.
//
// Provider laedt einmal, alle Konsumenten (Sidebar, Widget, JobButton,
// Modal, Sheet) teilen sich den State. Layout wraps die App damit der
// Provider immer verfuegbar ist (innerhalb des PermissionsProviders).
//
// Seit dem Mobile-Overhaul liegt eine Offline-Warteschlange dahinter
// (src/lib/offline/*). Die Schnittstelle fuer die Konsumenten ist gleich
// geblieben; neu dazu: ausstehend, nachsendbar, queue, online, jetztSenden,
// verwerfen, serverKonfliktBehalten, erneutVersuchen (Uebertragungen-Sheet).
//
//   * Warteschlange nur am Handy (< 768 px): dort wird jede Aktion zuerst in
//     IndexedDB geschrieben (write-ahead) und erst nach erfolgreichem Commit
//     bestaetigt; online + leere Reihe → direkt senden, sonst einreihen und
//     nachsenden lassen. Am Desktop (oder bei noch unbekannter Breite) mit
//     leerer Reihe gilt das alte Verhalten: direkt senden ohne Reihe, ein
//     Netzfehler ist ein Fehler. Eine bestehende Reihe (Geraet war vorher
//     schmal) geht auch am Desktop den Reihen-Pfad, damit die Reihenfolge
//     gewahrt bleibt; die Sync-Trigger laufen auf allen Breiten.
//   * active = Server-Stand + wartende Aktionen darueber gelegt. Ein
//     wartender clock_in erzeugt ein lokales active (id = entry_id,
//     clock_in = client_ts), ein wartender clock_out versteckt active.
//   * Der letzte bestaetigte Server-Stand wird je Nutzer in IndexedDB
//     gemerkt (cache "stempel_active") und beim Start gelesen — so zeigt die
//     App nach einem Kaltstart ohne Netz «eingestempelt seit …» und das
//     Ausstempeln kann in die Reihe. refresh() setzt active bei Netzfehler
//     NIE auf null.
//   * meId kommt aus usePermissions() (bei «Ansicht als» der angesehene
//     User). In «Ansicht als» wird nur angezeigt: Stempeln, «Jetzt senden»/
//     «Erneut versuchen» und die Sync-Trigger sind gesperrt (Inserts liefen sonst mit dem JWT des Admins auf die user_id
//     des Angesehenen → RLS-Ablehnung bzw. halb ausgefuehrte Tarifwechsel).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { readImpersonationCookie } from "@/lib/impersonation";
import { useIsMobile } from "@/lib/use-is-mobile";
import type { TimeEntry } from "@/types";
import {
  cacheLesen,
  cacheSchreiben,
  deviceId,
  istIdbVerfuegbar,
  istQuotaFehler,
  ladeOps,
  type CacheEintrag,
  type StempelOp,
  type StempelOpKind,
  type StempelOpPayload,
} from "@/lib/offline/db";
import {
  OUTBOX_EVENT,
  SESSION_ABGELAUFEN,
  backoffZuruecksetzen,
  erneutVersuchen as outboxErneutVersuchen,
  jetztSenden as outboxJetztSenden,
  reiheEin,
  sendeAlle,
  sendeDirekt,
  sendeOhneReihe,
  verwerfeOp,
  type OpErgebnis,
} from "@/lib/offline/stempel-outbox";
import { registriereSyncTrigger, useOnline } from "@/lib/offline/sync-trigger";

interface ClockInOpts {
  jobId?: string | null;
  projectId?: string | null;
  description?: string | null;
  rateTierId?: string | null;
}

export interface StempelErgebnis {
  success: boolean;
  error?: string;
  /** true = gespeichert, aber noch nicht am Server (wird gesendet, sobald
   *  Netz da ist bzw. die Reihe durch ist). */
  wartet?: boolean;
}

interface StempelState {
  active: TimeEntry | null;
  loading: boolean;
  clockIn: (opts: ClockInOpts) => Promise<StempelErgebnis>;
  clockOut: () => Promise<StempelErgebnis>;
  /**
   * Wechselt den Verrechnungssatz-Modus waehrend laufender Stempelung:
   * beendet den aktuellen Eintrag (clock_out=jetzt) und startet einen
   * neuen mit demselben job/project/description aber neuem rate_tier_id.
   * So bekommt der Report zwei saubere Zeit-Bloecke mit je einem Tarif.
   */
  switchRateTier: (rateTierId: string) => Promise<StempelErgebnis>;
  refresh: () => Promise<void>;
  /** Zahl der Aktionen in der Warteschlange (alle Stati). */
  ausstehend: number;
  /** Aktionen, die noch von selbst gesendet werden (wartet/sendet/fehler) —
   *  ohne konflikt/abgelehnt, die auf eine Entscheidung warten. */
  nachsendbar: number;
  /** Warteschlange des Nutzers, nach seq — fuer das Uebertragungen-Sheet. */
  queue: StempelOp[];
  online: boolean;
  jetztSenden: () => Promise<void>;
  /** Aktion samt abhaengigen Folgeaktionen entfernen. */
  verwerfen: (opId: string) => Promise<void>;
  /** Konflikt: Server-Eintrag gilt, eigene Aktion wird verworfen. */
  serverKonfliktBehalten: (opId: string) => Promise<void>;
  /** Konflikt/Fehler zuruecksetzen und sofort erneut senden. */
  erneutVersuchen: (opId: string) => Promise<void>;
}

const StempelContext = createContext<StempelState | null>(null);

const ANSICHT_ALS_GESPERRT = "Stempeln ist in «Ansicht als» nicht möglich";
/** cache-Name in IndexedDB fuer den letzten bestaetigten Server-Stand (je uid). */
const CACHE_STEMPEL_ACTIVE = "stempel_active";

/**
 * Erfolgs-Toast-Text fuer alle Stempel-Einstiege: ohne `wartet` nur der Text,
 * sonst mit Hinweis, dass die Aktion erst noch gesendet wird.
 */
export function stempelErfolgText(res: { wartet?: boolean }, text: string, online: boolean): string {
  if (!res.wartet) return text;
  return online ? `${text} — wird übertragen` : `${text} — gespeichert, wird gesendet, sobald Netz da ist`;
}

/** Lokaler Eintrag aus einer wartenden clock_in-/switch_tier-Aktion. */
function lokalerEintrag(op: StempelOp): TimeEntry {
  return {
    id: op.entry_id,
    user_id: op.user_id,
    job_id: op.payload.job_id,
    project_id: op.payload.project_id,
    clock_in: op.client_ts,
    clock_out: null,
    description: op.payload.description,
    notes: null,
    rate_tier_id: op.payload.rate_tier_id,
    created_at: op.client_ts,
    updated_at: op.client_ts,
  };
}

/** Server-Stand + Reihe darueber gelegt. Stoppt an der ersten blockierten
 *  Aktion (Konflikt/abgelehnt) — alles danach ist noch nicht entschieden. */
function ueberlagern(server: TimeEntry | null, queue: StempelOp[]): TimeEntry | null {
  let a = server;
  for (const op of queue) {
    if (op.status === "konflikt" || op.status === "abgelehnt") break;
    if (op.kind === "clock_in" || op.kind === "switch_tier") a = lokalerEintrag(op);
    else if (op.kind === "clock_out" && a && a.id === op.entry_id) a = null;
  }
  return a;
}

export function StempelProvider({ children }: { children: ReactNode }) {
  const supabase = createClient();
  const { meId } = usePermissions();
  const online = useOnline();
  const isMobile = useIsMobile();
  const [serverActive, setServerActive] = useState<TimeEntry | null>(null);
  const [queue, setQueue] = useState<StempelOp[]>([]);
  const [loading, setLoading] = useState(true);
  // Fallback, wenn /api/me (noch) nicht geantwortet hat: lokale Sitzung
  // (getSession braucht kein Netz).
  const [sessionUid, setSessionUid] = useState<string | null>(null);
  const uid = meId ?? sessionUid;
  // uid, fuer die bereits ein bestaetigter Server-Stand vorliegt — ein aelterer
  // Stand aus dem Cache darf eine frische Server-Antwort nicht ueberschreiben.
  const serverGeantwortetFuer = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const id = data.session?.user.id ?? null;
      setSessionUid(id);
      if (!id && !meId) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, meId]);

  /** Bestaetigten Server-Stand uebernehmen und je Nutzer in IndexedDB merken. */
  const setzeServerStand = useCallback((eintrag: TimeEntry | null) => {
    if (!uid) return;
    serverGeantwortetFuer.current = uid;
    setServerActive(eintrag);
    void cacheSchreiben(uid, CACHE_STEMPEL_ACTIVE, eintrag).catch(() => {});
  }, [uid]);

  const refresh = useCallback(async () => {
    if (!uid) return;
    const { data, error } = await supabase
      .from("time_entries")
      .select("*")
      .eq("user_id", uid)
      .is("clock_out", null)
      .maybeSingle();
    // Netz-/Serverfehler: letzten bekannten Stand behalten.
    if (error) {
      setLoading(false);
      return;
    }
    setzeServerStand((data as TimeEntry | null) ?? null);
    setLoading(false);
  }, [supabase, uid, setzeServerStand]);

  const ladeQueue = useCallback(async () => {
    if (!uid) return;
    try {
      setQueue(await ladeOps(uid));
    } catch {
      // IndexedDB nicht verfuegbar → leere Reihe, Aktionen laufen direkt.
      setQueue([]);
    }
  }, [uid]);

  // Kaltstart: letzten bestaetigten Server-Stand aus IndexedDB lesen, noch
  // bevor bzw. waehrend der Server antwortet. Gilt nur, solange der Server
  // fuer diese uid noch nicht geantwortet hat.
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      let eintrag: CacheEintrag<TimeEntry | null> | null;
      try {
        eintrag = await cacheLesen<TimeEntry | null>(uid, CACHE_STEMPEL_ACTIVE);
      } catch {
        return;
      }
      if (cancelled || !eintrag || serverGeantwortetFuer.current === uid) return;
      setServerActive(eintrag.data ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [uid]);

  // Reihe und Server-Stand parallel laden: IndexedDB ist lokal und schnell,
  // die Reihe steht damit sofort, auch wenn der Server-Request haengt.
  useEffect(() => {
    (async () => {
      await Promise.all([ladeQueue(), refresh()]);
    })();
  }, [refresh, ladeQueue]);

  // Aenderungen der Reihe (eigener Tab oder Sync-Lauf): erst Server-Stand,
  // dann Reihe neu lesen — so entsteht beim Entfernen einer gesendeten Aktion
  // kein Flackern (Server hat den Eintrag schon, bevor die Ueberlagerung faellt).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ serverNeuLaden?: boolean }>).detail;
      (async () => {
        if (detail?.serverNeuLaden) await refresh();
        await ladeQueue();
      })();
    };
    window.addEventListener(OUTBOX_EVENT, handler);
    return () => window.removeEventListener(OUTBOX_EVENT, handler);
  }, [refresh, ladeQueue]);

  // Sync-Trigger: App-Start, online, Tab sichtbar, Realtime wieder da. Auf
  // allen Breiten (eine alte Reihe fliesst auch am Desktop ab), aber nicht
  // in «Ansicht als» — die Reihe des Angesehenen wuerde mit dem JWT des
  // Admins gesendet. Jeder Ausloeser holt auch den Server-Stand neu: nach
  // einem Offline-Start (Realtime-Kanal steht dann evtl. noch nicht) sonst
  // bliebe bis zum Neuladen der Cache-Stand stehen, auch wenn am Computer
  // inzwischen aus- oder eingestempelt wurde.
  useEffect(() => {
    if (!uid) return;
    if (readImpersonationCookie()) return;
    const abmelden = registriereSyncTrigger(() => { void refresh(); void sendeAlle(supabase, uid); });
    return () => {
      abmelden();
      // Backoff-Timer gehoert zu dieser uid — bei Logout/Nutzerwechsel sofort
      // stoppen (der Timer ist modul-global und ueberlebt sonst den Provider).
      backoffZuruecksetzen();
    };
  }, [supabase, uid, refresh]);

  // Konsumiert das `realtime:time_entries`-Event vom globalen Channel im
  // (app)/layout.tsx — kein eigener WebSocket noetig.
  // COALESCED (leading + trailing, 2.5s-Fenster — Muster aus
  // use-nav-counts): Leading edge = die eigene Stempel-Aktion refresht
  // SOFORT (unveraendertes Gefuehl); Event-Bursts (z.B. Rate-Tier-Wechsel
  // = clock_out + insert, oder Admin-Korrekturen) werden auf 1 Refresh je
  // 2.5s gedeckelt, der trailing Lauf nimmt den letzten Stand mit.
  useEffect(() => {
    const WINDOW_MS = 2500;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trailingPending = false;
    const openWindow = () => {
      timer = setTimeout(() => {
        timer = null;
        if (trailingPending) {
          trailingPending = false;
          refresh();
          openWindow();
        }
      }, WINDOW_MS);
    };
    const handler = () => {
      if (timer) {
        trailingPending = true;
        return;
      }
      refresh();
      openWindow();
    };
    window.addEventListener("realtime:time_entries", handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:time_entries", handler);
    };
  }, [refresh]);

  const active = useMemo(() => ueberlagern(serverActive, queue), [serverActive, queue]);
  const nachsendbar = useMemo(
    () => queue.filter((o) => o.status === "wartet" || o.status === "sendet" || o.status === "fehler").length,
    [queue],
  );

  /**
   * Gemeinsamer Weg aller Aktionen. Handy: write-ahead in die Reihe, dann
   * direkt senden (online + leere Reihe) oder nachsenden lassen. Desktop mit
   * leerer Reihe: ohne Reihe direkt senden (altes Verhalten).
   */
  const ausfuehren = useCallback(async (
    kind: StempelOpKind,
    entryId: string,
    payload: StempelOpPayload,
  ): Promise<StempelErgebnis> => {
    if (readImpersonationCookie()) return { success: false, error: ANSICHT_ALS_GESPERRT };
    if (!uid) return { success: false, error: "Nicht eingeloggt" };
    const clientTs = new Date().toISOString();

    const uebernehmen = (r: OpErgebnis) => {
      if (r.art !== "ok") return;
      if (kind === "clock_out") setzeServerStand(null);
      else if (r.entry) setzeServerStand(r.entry);
      else void refresh();
    };

    // Ohne Reihe senden: nichts wird persistiert, ein Netzfehler ist ein
    // Fehler (kein «wartet»), genau wie vor der Warteschlange. Darum auch
    // keine «wird gesendet»-Texte aus der Reihe durchreichen — hier wird
    // nichts nachgesendet.
    const ohneReihe = async (): Promise<StempelErgebnis> => {
      const r = await sendeOhneReihe(supabase, {
        op_id: crypto.randomUUID(), user_id: uid, seq: 0, kind, entry_id: entryId, payload,
        client_ts: clientTs, device_id: deviceId(), attempts: 0, status: "sendet", last_error: null,
      });
      uebernehmen(r);
      if (r.art === "ok") return { success: true };
      if (r.art === "wartet") {
        return {
          success: false,
          error: r.fehler === SESSION_ABGELAUFEN
            ? "Sitzung abgelaufen — bitte neu anmelden und nochmals stempeln"
            : "Kein Netz — nicht gespeichert, bitte nochmals versuchen",
        };
      }
      return { success: false, error: r.fehler };
    };

    // Kein IndexedDB (privater Modus o. ae.): wie frueher direkt senden.
    if (!istIdbVerfuegbar()) {
      if (!online) return { success: false, error: "Ohne Netz nicht möglich — dieses Gerät hat keinen Offline-Speicher" };
      return ohneReihe();
    }

    // Reihe frisch aus IndexedDB lesen, nicht aus dem React-State: der kann
    // veraltet sein (haengender Server-Request beim Start, zweiter Tab).
    let ops: StempelOp[];
    try {
      ops = await ladeOps(uid);
    } catch {
      ops = queue;
    }
    if (ops.some((o) => o.status === "konflikt" || o.status === "abgelehnt")) {
      return { success: false, error: "Zuerst die wartenden Übertragungen prüfen" };
    }
    const reiheLeer = ops.length === 0;

    // Warteschlange nur am Handy. Desktop (oder Breite noch unbekannt) mit
    // leerer Reihe: altes Verhalten. Eine bestehende Reihe geht auch am
    // Desktop den Reihen-Pfad, damit die Reihenfolge gewahrt bleibt.
    if (reiheLeer && isMobile !== true) return ohneReihe();

    const direkt = online && reiheLeer;
    let op: StempelOp;
    try {
      op = await reiheEin({ user_id: uid, kind, entry_id: entryId, payload, client_ts: clientTs });
    } catch (e) {
      // IndexedDB vorhanden, aber nicht nutzbar (Oeffnen scheitert, Speicher
      // voll): mit Netz und leerer Reihe wie frueher ohne Reihe senden, statt
      // das Stempeln ganz zu verhindern.
      if (direkt) {
        const r = await ohneReihe();
        if (r.success) toast.message("Direkt gesendet — Offline-Speicher auf diesem Gerät nicht verfügbar");
        return r;
      }
      const msg = istQuotaFehler(e)
        ? "Speicher auf dem Gerät voll — Aktion nicht gespeichert"
        : `Konnte nicht gespeichert werden: ${e instanceof Error ? e.message : String(e)}`;
      toast.error(msg);
      return { success: false, error: msg };
    }

    if (direkt) {
      const r = await sendeDirekt(supabase, op);
      uebernehmen(r);
      await ladeQueue();
      if (r.art === "ok") return { success: true };
      if (r.art === "wartet") return { success: true, wartet: true };
      return { success: false, error: r.fehler };
    }

    await ladeQueue();
    if (online) void sendeAlle(supabase, uid);
    return { success: true, wartet: true };
  }, [uid, online, isMobile, queue, supabase, refresh, ladeQueue, setzeServerStand]);

  const clockIn = useCallback(async (opts: ClockInOpts): Promise<StempelErgebnis> => {
    if (active) return { success: false, error: "Du bist schon eingestempelt" };
    return ausfuehren("clock_in", crypto.randomUUID(), {
      job_id: opts.jobId ?? null,
      project_id: opts.projectId ?? null,
      description: opts.description?.trim() || null,
      rate_tier_id: opts.rateTierId ?? null,
    });
  }, [active, ausfuehren]);

  const clockOut = useCallback(async (): Promise<StempelErgebnis> => {
    if (!active) return { success: false, error: "Nicht eingestempelt" };
    return ausfuehren("clock_out", active.id, {
      job_id: active.job_id,
      project_id: active.project_id ?? null,
      description: active.description,
      rate_tier_id: active.rate_tier_id ?? null,
      clock_in: active.clock_in,
    });
  }, [active, ausfuehren]);

  const switchRateTier = useCallback(async (rateTierId: string): Promise<StempelErgebnis> => {
    if (!active) return { success: false, error: "Nicht eingestempelt" };
    if (active.rate_tier_id === rateTierId) return { success: true }; // no-op
    return ausfuehren("switch_tier", crypto.randomUUID(), {
      job_id: active.job_id,
      project_id: active.project_id ?? null,
      description: active.description,
      rate_tier_id: rateTierId,
      prev_entry_id: active.id,
      clock_in: active.clock_in,
    });
  }, [active, ausfuehren]);

  const jetztSenden = useCallback(async () => {
    if (!uid) return;
    if (readImpersonationCookie()) {
      toast.error(ANSICHT_ALS_GESPERRT);
      return;
    }
    await outboxJetztSenden(supabase, uid);
  }, [supabase, uid]);

  const verwerfen = useCallback(async (opId: string) => {
    if (!uid) return;
    await verwerfeOp(uid, opId);
    await refresh();
    await ladeQueue();
  }, [uid, refresh, ladeQueue]);

  const erneutVersuchen = useCallback(async (opId: string) => {
    if (!uid) return;
    if (readImpersonationCookie()) {
      toast.error(ANSICHT_ALS_GESPERRT);
      return;
    }
    await outboxErneutVersuchen(supabase, uid, opId);
  }, [supabase, uid]);

  const value = useMemo<StempelState>(
    () => ({
      active, loading, clockIn, clockOut, switchRateTier, refresh,
      ausstehend: queue.length, nachsendbar, queue, online,
      jetztSenden, verwerfen, serverKonfliktBehalten: verwerfen, erneutVersuchen,
    }),
    [active, loading, clockIn, clockOut, switchRateTier, refresh, queue, nachsendbar, online, jetztSenden, verwerfen, erneutVersuchen],
  );

  return <StempelContext.Provider value={value}>{children}</StempelContext.Provider>;
}

export function useStempel(): StempelState {
  const ctx = useContext(StempelContext);
  if (!ctx) {
    // Fallback fuer Komponenten die ausserhalb des Providers gemounted
    // werden (sollte in der App nicht vorkommen — Layout wraps alles).
    // No-Op statt Crash damit Tests + Storybook funktionieren.
    const kein = async () => ({ success: false, error: "Kein StempelProvider" });
    return {
      active: null,
      loading: false,
      clockIn: kein,
      clockOut: kein,
      switchRateTier: kein,
      refresh: async () => {},
      ausstehend: 0,
      nachsendbar: 0,
      queue: [],
      online: true,
      jetztSenden: async () => {},
      verwerfen: async () => {},
      serverKonfliktBehalten: async () => {},
      erneutVersuchen: async () => {},
    };
  }
  return ctx;
}

// Hilfsfunktion fuer Live-Timer-Anzeige. Dauer = UTC-Differenz (Zeitumstellung
// 25.10.2026 aendert daran nichts).
export function formatStempelDuration(clockIn: string, now: number = Date.now()): string {
  const start = new Date(clockIn).getTime();
  const totalSec = Math.max(0, Math.floor((now - start) / 1000));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
