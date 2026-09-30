"use client";

// NAS-Ablage (Leo 2026-09-26): Dokumente hier ablegen statt von Hand auf
// dem UGREEN-NAS einsortieren. Pro Datei PFLICHT: Betreff + Zielordner
// aus der gepflegten NAS-Struktur. DOKUMENTE NIE AN KI — sensible Inhalte
// werden nie analysiert; die KI strukturiert hoechstens den vom Nutzer
// GETIPPTEN Beschrieb (+ Dateiname) in die Namens-Bausteine
// (/api/ablage/name-vorschlag). Die Dateien landen im privaten Uebergabe-
// Bucket, das NAS holt sie per Sync ab (kein offener Port am NAS).
//
// Admin-only: Sidebar zeigt den Eintrag nur Admins, die Seite gated
// zusaetzlich selbst, RLS + API (requireAdmin) sichern die Daten.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { BackupTab } from "@/components/nas/backup-tab";
import { TabsNav } from "@/components/ui/tabs-nav";
import { DOK_TYPEN, dokTyp, baueAblageName } from "@/lib/ablage-doktypen";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { toast } from "sonner";
import {
  HardDriveUpload, Upload, Loader2, Check, Trash2,
  ShieldCheck, FileText, ChevronRight, Sparkles, FolderPlus, Clock, Search, X,
  Folder, FolderOpen, Download, Copy, Pencil, HardDrive,
} from "lucide-react";

interface OrdnerRow { id: string; pfad: string; aktiv: boolean; nas_ausstehend: boolean }
/** Zeile aus dem NAS-Datei-Index (vom Sync-Client gescannte Dateinamen). */
interface IndexRow { id: string; pfad: string; ordner_pfad: string; name: string; geaendert: string | null }
interface ItemRow {
  id: string;
  ordner_pfad: string;
  beschrieb: string;
  abgelegt_name: string;
  created_at: string;
  synced_at: string | null;
  autor: { full_name: string }[] | { full_name: string } | null;
}
interface PendingFile {
  key: string;
  file: File;
  /** Frei getippter Kurzbeschrieb — einzige KI-Eingabe (nie die Datei). */
  kiText: string;
  kiLaeuft?: boolean;
  /** Schon mal analysiert? (steuert den Auto-Lauf beim Feld-Verlassen) */
  kiGelaufen?: boolean;
  /** Rueckfragen der KI, wenn im Beschrieb Wichtiges fehlt. */
  fragen?: string[];
  /** Antwort-Feld fuer die Rueckfragen. */
  antwort: string;
  typ: string;
  betreff: string;
  /** Kanonischer Mitarbeiter-Name (Auswahl aus den Profilen). */
  person: string;
  partei: string;
  nummer: string;
  dokDatum: string;
  ordner: string;
  status: "offen" | "laedt" | "fertig" | "fehler";
  fehler?: string;
}

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

const LETZTE_ORDNER_KEY = "ablage-letzte-ordner";

const ITEM_SELECT = "id, ordner_pfad, beschrieb, abgelegt_name, created_at, synced_at, autor:profiles!ablage_items_created_by_fkey(full_name)";

/** Dateien robust aus einem Drop ziehen: items-Weg (mit Ordner-Erkennung)
 *  zuerst, dataTransfer.files als Fallback — je nach Browser/Quelle ist
 *  nur einer der beiden gefuellt. */
function dateienAusDrop(dt: DataTransfer): { dateien: File[]; hatOrdner: boolean } {
  const dateien: File[] = [];
  let hatOrdner = false;
  if (dt.items && dt.items.length > 0) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== "file") continue;
      const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.();
      if (entry?.isDirectory) { hatOrdner = true; continue; }
      const f = it.getAsFile();
      if (f) dateien.push(f);
    }
  }
  if (dateien.length === 0 && !hatOrdner && dt.files) {
    for (const f of Array.from(dt.files)) dateien.push(f);
  }
  return { dateien, hatOrdner };
}

interface SyncStatus { letzter_poll: string; intervall_s: number }

/** Live-Countdown bis zum naechsten NAS-Abgleich (tickt nur hier, nicht
 *  die ganze Seite). */
function NasCountdown({ status }: { status: SyncStatus | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!status) return <>—</>;
  const next = new Date(status.letzter_poll).getTime() + status.intervall_s * 1000;
  const diff = Math.round((next - Date.now()) / 1000);
  if (diff <= -status.intervall_s * 3) {
    return <span className="text-amber-600 dark:text-amber-400">Sync offline?</span>;
  }
  if (diff <= 0) return <>gleich…</>;
  return <>{Math.floor(diff / 60)}:{String(diff % 60).padStart(2, "0")}</>;
}

/** Sync-Puls auf der Tablinie: roter Fortschrittsring, der sich ueber
 *  das Poll-Intervall fuellt (Uhr bis zum naechsten NAS-Abgleich).
 *  Beim Abgleich pulsiert das NAS-Symbol, offline wird der Ring amber. */
function NasPuls({ status }: { status: SyncStatus | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!status) return null;
  const R = 8;
  const C = 2 * Math.PI * R;
  const next = new Date(status.letzter_poll).getTime() + status.intervall_s * 1000;
  const diff = (next - Date.now()) / 1000;
  const offline = diff <= -status.intervall_s * 3;
  const gleich = !offline && diff <= 0;
  const frac = gleich || offline ? 1 : Math.min(1, Math.max(0, 1 - diff / status.intervall_s));
  const zeit = offline ? "—" : gleich ? "…" : `${Math.floor(diff / 60)}:${String(Math.floor(diff) % 60).padStart(2, "0")}`;
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground"
      data-tooltip={offline ? "NAS-Sync meldet sich nicht — Container auf dem UGREEN prüfen" : "Nächster NAS-Abgleich"}
    >
      <span className="relative inline-flex h-[22px] w-[22px]">
        <svg width="22" height="22" viewBox="0 0 22 22" className="-rotate-90">
          <circle cx="11" cy="11" r={R} fill="none" strokeWidth="2" className="stroke-foreground/10 dark:stroke-foreground/20" />
          <circle
            cx="11" cy="11" r={R} fill="none" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
            className={offline ? "stroke-amber-500" : "stroke-red-500"}
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
        <HardDrive className={`absolute inset-0 m-auto h-3 w-3 ${offline ? "text-amber-500" : gleich ? "text-red-500 animate-pulse" : "text-muted-foreground"}`} />
      </span>
      <span className={offline ? "text-amber-600 dark:text-amber-400" : ""}>{zeit}</span>
    </div>
  );
}

function fmtBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtWann(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function NasPage() {
  const supabase = useMemo(() => createClient(), []);
  const { role, ready } = usePermissions();
  // Tab via URL-Param (?tab=backup) — ueberlebt Reload (§10);
  // replaceState statt useSearchParams (kein Suspense-Boundary noetig).
  const [tab, setTab] = useState<"ablage" | "ordner" | "backup">(() => {
    if (typeof window === "undefined") return "ablage";
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "backup" || t === "ordner" ? t : "ablage";
  });
  function wechsleTab(t: "ablage" | "ordner" | "backup") {
    setTab(t);
    window.history.replaceState(null, "", `/nas?tab=${t}`);
  }
  const [ordner, setOrdner] = useState<OrdnerRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  /** Aktive Mitarbeiter fuer das Person-Feld (kanonische volle Namen). */
  const [mitarbeiter, setMitarbeiter] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [alleBusy, setAlleBusy] = useState(false);
  const [ordnerFilter, setOrdnerFilter] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  /** Keys, fuer die gerade ein KI-Vorschlag laeuft (synchroner Doppel-Guard). */
  const kiLaeuftRef = useRef<Set<string>>(new Set());

  // ── Seitenweiter Drag&Drop (Leo 2026-09-30) ───────────────────────
  // Vorher fing NUR der gestrichelte Knopf Drops ab: knapp daneben
  // losgelassen oeffnete der Browser die Datei bzw. der Drop verpuffte
  // still. Jetzt nimmt die ganze Seite Drops an, mit Hervorhebung der
  // Zone waehrend des Ziehens und Toast statt Stille bei Problemen.
  const [zieht, setZieht] = useState(false);
  const ziehtTiefe = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const dateienWaehlenRef = useRef<(f: File[] | FileList | null) => void>(() => {});
  useEffect(() => {
    const istDateiDrag = (e: DragEvent) => (e.dataTransfer?.types ?? []).includes?.("Files") || Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!istDateiDrag(e)) return;
      ziehtTiefe.current++;
      setZieht(true);
    };
    const leave = () => {
      ziehtTiefe.current = Math.max(0, ziehtTiefe.current - 1);
      if (ziehtTiefe.current === 0) setZieht(false);
    };
    const over = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      ziehtTiefe.current = 0;
      setZieht(false);
      if (!e.dataTransfer || !istDateiDrag(e)) return;
      if (tabRef.current !== "ablage") {
        toast.error("Zum Ablegen zuerst in den Tab «Ablage» wechseln");
        return;
      }
      const { dateien, hatOrdner } = dateienAusDrop(e.dataTransfer);
      if (dateien.length === 0) {
        toast.error(hatOrdner
          ? "Ordner können nicht direkt abgelegt werden — bitte die Dateien darin reinziehen"
          : "Keine Datei erkannt — bitte über «Dateien wählen» hochladen");
        return;
      }
      dateienWaehlenRef.current(dateien);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const [letzteOrdner, setLetzteOrdner] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(LETZTE_ORDNER_KEY) ?? "[]"); } catch { return []; }
  });

  const load = useCallback(async () => {
    const [oRes, iRes, mRes] = await Promise.all([
      supabase.from("ablage_ordner").select("id, pfad, aktiv, nas_ausstehend").order("pfad"),
      supabase
        .from("ablage_items")
        .select(ITEM_SELECT)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase.from("profiles").select("full_name").eq("is_active", true).order("full_name"),
    ]);
    setOrdner((oRes.data ?? []) as OrdnerRow[]);
    setItems((iRes.data ?? []) as unknown as ItemRow[]);
    setMitarbeiter((mRes.data ?? []).map((m) => m.full_name as string).filter(Boolean));
  }, [supabase]);

  useEffect(() => { if (ready && role === "admin") load(); }, [ready, role, load]);

  // Deaktivierung vererbt sich auf den ganzen Zweig: Pfade unter einem
  // inaktiven Ordner sind ebenfalls nicht waehlbar.
  const inaktivePfade = useMemo(() => (ordner ?? []).filter((o) => !o.aktiv).map((o) => o.pfad), [ordner]);
  const gesperrtDurch = useCallback((pfad: string): string | null => {
    for (const p of inaktivePfade) {
      if (pfad === p || pfad.startsWith(p + "/")) return p;
    }
    return null;
  }, [inaktivePfade]);

  // ── Suche im Namensregister (Leo 2026-09-30) ──────────────────────
  // Zwei Quellen: die Ablage-Historie (mit Beschrieb) UND der NAS-Datei-
  // Index (ALLE Dateien der Freigabe, auch manuell abgelegte — der
  // Sync-Client scannt Namen, nie Inhalte). Server-seitig via ilike +
  // pg_trgm-Indexe; Duplikate (abgelegte Datei ist auch im Index)
  // werden beim Rendern über den Pfad ausgefiltert.
  const [suche, setSuche] = useState("");
  const [indexTreffer, setIndexTreffer] = useState<IndexRow[]>([]);
  useEffect(() => {
    if (!ready || role !== "admin") return;
    const t = setTimeout(async () => {
      const s = suche.trim().replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim();
      if (!s) {
        setIndexTreffer([]);
        const { data } = await supabase.from("ablage_items").select(ITEM_SELECT).order("created_at", { ascending: false }).limit(50);
        setItems((data ?? []) as unknown as ItemRow[]);
        return;
      }
      // Dokumente in gesperrten Ordnern (aktiv=false, inkl. vererbter
      // Sperre auf Unterordner) aus der Suche ausschliessen (Leo
      // 2026-09-30). _ und % in Pfaden fuer LIKE escapen.
      const sperren = inaktivePfade.map((p) => p.replace(/[\\%_]/g, "\\$&"));
      let qa = supabase
        .from("ablage_items")
        .select(ITEM_SELECT)
        .or(`abgelegt_name.ilike.%${s}%,beschrieb.ilike.%${s}%,ordner_pfad.ilike.%${s}%`);
      let qb = supabase
        .from("ablage_datei_index")
        .select("id, pfad, ordner_pfad, name, geaendert")
        .or(`name.ilike.%${s}%,ordner_pfad.ilike.%${s}%`);
      for (const esc of sperren) {
        qa = qa.not("ordner_pfad", "like", esc).not("ordner_pfad", "like", `${esc}/%`);
        qb = qb.not("ordner_pfad", "like", esc).not("ordner_pfad", "like", `${esc}/%`);
      }
      const [a, b] = await Promise.all([
        qa.order("created_at", { ascending: false }).limit(50),
        qb.order("geaendert", { ascending: false, nullsFirst: false }).limit(50),
      ]);
      if (a.error || b.error) {
        toast.error("Suche fehlgeschlagen: " + (a.error?.message ?? b.error?.message));
        return;
      }
      setItems((a.data ?? []) as unknown as ItemRow[]);
      setIndexTreffer((b.data ?? []) as IndexRow[]);
    }, 300);
    return () => clearTimeout(t);
  }, [suche, ready, role, supabase, inaktivePfade]);

  // Ordner-Optionen: nur effektiv aktive, zuletzt verwendete zuoberst.
  const ordnerOptionen = useMemo(() => {
    const alle = (ordner ?? []).filter((o) => gesperrtDurch(o.pfad) === null).map((o) => o.pfad);
    const zuletzt = letzteOrdner.filter((p) => alle.includes(p));
    const rest = alle.filter((p) => !zuletzt.includes(p));
    return [
      ...zuletzt.map((p) => ({ id: p, label: p, sublabel: "zuletzt verwendet" })),
      ...rest.map((p) => ({ id: p, label: p })),
    ];
  }, [ordner, letzteOrdner, gesperrtDurch]);
  // ── Explorer-Zustand des Ordner-Tabs (Leo 2026-09-30) ─────────────
  // Aufgeklappte Ordner (beliebige Tiefe) + ausgewaehlter Ordner —
  // beides ueberlebt den Reload (§10, localStorage).
  const [offene, setOffene] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem("nas-ordner-offen") ?? "[]")); } catch { return new Set(); }
  });
  const [auswahl, setAuswahl] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem("nas-ordner-auswahl"); } catch { return null; }
  });
  useEffect(() => {
    try { localStorage.setItem("nas-ordner-offen", JSON.stringify([...offene])); } catch { /* egal */ }
  }, [offene]);
  useEffect(() => {
    try {
      if (auswahl) localStorage.setItem("nas-ordner-auswahl", auswahl);
      else localStorage.removeItem("nas-ordner-auswahl");
    } catch { /* egal */ }
  }, [auswahl]);

  /** Kinder je Eltern-Pfad ("" = Hauptebene), DB-sortiert. */
  const kinderVon = useMemo(() => {
    const m = new Map<string, OrdnerRow[]>();
    for (const o of ordner ?? []) {
      const i = o.pfad.lastIndexOf("/");
      const parent = i === -1 ? "" : o.pfad.slice(0, i);
      if (!m.has(parent)) m.set(parent, []);
      m.get(parent)!.push(o);
    }
    return m;
  }, [ordner]);

  /** Ordner auswaehlen: rechte Seite zeigt Inhalt, Pfad klappt auf. */
  const waehlen = useCallback((pfad: string) => {
    setAuswahl(pfad);
    setOffene((prev) => {
      const next = new Set(prev);
      const teile = pfad.split("/");
      for (let i = 1; i <= teile.length; i++) next.add(teile.slice(0, i).join("/"));
      return next;
    });
  }, []);

  // Sync-Puls fuer den Countdown (stempelt die Abhol-API bei jedem
  // Poll des NAS-Clients) — alle 20s nachladen, 1s-Tick nur im
  // NasCountdown selbst.
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    if (!ready || role !== "admin") return;
    let aktiv = true;
    const laden = async () => {
      const { data } = await supabase.from("ablage_sync_status").select("letzter_poll, intervall_s").eq("id", 1).maybeSingle();
      if (aktiv) setSyncStatus((data as SyncStatus | null) ?? null);
    };
    laden();
    const t = setInterval(laden, 20_000);
    return () => { aktiv = false; clearInterval(t); };
  }, [ready, role, supabase]);

  /** Hover-Zeile in den Dokument-Listen (state-driven, §3). */
  const [hoverRow, setHoverRow] = useState<string | null>(null);

  // ── Datei-Abruf vom NAS (Leo 2026-09-30) ──────────────────────────
  // Klick auf ein Dokument: Abruf-Zeile anlegen, der Sync-Client laedt
  // die Datei in den Uebergabe-Bucket, das UI pollt bis "bereit" und
  // startet den Download. Housekeeping raeumt den Bucket nach 1h.
  const [abrufLaeuft, setAbrufLaeuft] = useState<Record<string, boolean>>({});
  async function dateiAbrufen(pfad: string) {
    if (abrufLaeuft[pfad]) return;
    setAbrufLaeuft((p) => ({ ...p, [pfad]: true }));
    const fertig = () => setAbrufLaeuft((p) => { const n = { ...p }; delete n[pfad]; return n; });
    try {
      const { data: row, error } = await supabase.from("ablage_abrufe").insert({ pfad }).select("id").single();
      if (error || !row) {
        fertig();
        toast.error("Abruf konnte nicht gestartet werden" + (error ? ": " + error.message : ""));
        return;
      }
      toast.info("Wird vom NAS geholt — kann bis zu einer Minute dauern…");
      const start = Date.now();
      while (Date.now() - start < 150_000) {
        await new Promise((r) => setTimeout(r, 4000));
        const { data: st } = await supabase.from("ablage_abrufe").select("status, fehler").eq("id", row.id).maybeSingle();
        if (!st) break;
        if (st.status === "bereit") {
          const res = await fetch(`/api/ablage/abruf/${row.id}`);
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.success) {
            toast.error(json?.error ?? "Download fehlgeschlagen");
            fertig();
            return;
          }
          // Datei als Blob holen und SELBST benennen — der Name aus der
          // signierten URL kommt sonst URL-kodiert an (%5B, %CC%88 bei
          // Mac-Umlauten). NFC-Normalisierung macht aus zerlegten
          // Umlauten wieder echte ö/ä/ü.
          const dl = await fetch(json.url);
          if (!dl.ok) {
            toast.error("Download fehlgeschlagen (HTTP " + dl.status + ")");
            fertig();
            return;
          }
          const blob = await dl.blob();
          const obj = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = obj;
          a.download = String(json.name ?? "dokument").normalize("NFC");
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(obj), 10_000);
          toast.success("Download gestartet", { description: a.download });
          fertig();
          return;
        }
        if (st.status === "fehler") {
          toast.error("NAS meldet: " + (st.fehler ?? "Abruf fehlgeschlagen"));
          fertig();
          return;
        }
      }
      toast.error("Zeitüberschreitung — läuft der Sync-Container auf dem NAS?");
      await supabase.from("ablage_abrufe").delete().eq("id", row.id);
      fertig();
    } catch {
      fertig();
      toast.error("Abruf fehlgeschlagen — Netzwerkfehler");
    }
  }

  // Dateien des ausgewaehlten Ordners aus dem Datei-Index laden.
  const [paneDateien, setPaneDateien] = useState<{ name: string; groesse: number | null; geaendert: string | null }[] | null>(null);
  const [paneLaedt, setPaneLaedt] = useState(false);
  useEffect(() => {
    if (!auswahl || !ready || role !== "admin") return;
    let aktiv = true;
    setPaneLaedt(true);
    supabase
      .from("ablage_datei_index")
      .select("name, groesse, geaendert")
      .eq("ordner_pfad", auswahl)
      .order("name")
      .limit(500)
      .then(({ data, error }) => {
        if (!aktiv) return;
        setPaneLaedt(false);
        if (error) {
          toast.error("Dateien konnten nicht geladen werden: " + error.message);
          return;
        }
        setPaneDateien((data ?? []) as { name: string; groesse: number | null; geaendert: string | null }[]);
      });
    return () => { aktiv = false; };
  }, [auswahl, ready, role, supabase]);

  /** Ordner (de)aktivieren — optimistisch, direkter DB-Write (RLS admin). */
  async function toggleOrdner(o: OrdnerRow) {
    setOrdner((prev) => (prev ?? []).map((x) => (x.id === o.id ? { ...x, aktiv: !o.aktiv } : x)));
    const { error } = await supabase.from("ablage_ordner").update({ aktiv: !o.aktiv }).eq("id", o.id);
    if (error) {
      setOrdner((prev) => (prev ?? []).map((x) => (x.id === o.id ? { ...x, aktiv: o.aktiv } : x)));
      toast.error("Änderung fehlgeschlagen: " + error.message);
    }
  }

  // ── Neuer Ordner aus dem FSM (Leo 2026-09-30) ─────────────────────
  // Direkt im Baum: das Plus am Ordner oeffnet ein Eingabefeld genau
  // dort (Leo: Dropdown war nicht intuitiv). Zeile mit
  // nas_ausstehend=true; der Sync-Client erstellt den Ordner beim
  // naechsten Poll physisch auf dem UGREEN und bestaetigt.
  /** Bearbeiten-Modus im Ordner-Tab: nur dann sind die Aktiv-Häkchen
   *  sichtbar (Leo 2026-09-30 — sonst drückt man sie versehentlich). */
  const [bearbeiten, setBearbeiten] = useState(false);
  /** Eltern-Pfad des offenen Inline-Editors ("" = Hauptebene, null = zu). */
  const [neuParent, setNeuParent] = useState<string | null>(null);
  const [neuName, setNeuName] = useState("");
  const [neuBusy, setNeuBusy] = useState(false);

  function editorOeffnen(parent: string) {
    setNeuName("");
    setNeuParent(parent);
    // Zugeklappten Zweig aufklappen, damit das Feld sichtbar ist.
    if (parent) waehlen(parent);
  }

  async function ordnerAnlegen() {
    const name = neuName.trim().replace(/\s+/g, " ");
    if (!name || neuBusy || neuParent === null) return;
    if (name.length > 80 || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /^[@.#]/.test(name) || name.includes("..")) {
      toast.error("Ungültiger Ordnername — keine Zeichen wie / \\ : * ? \" < > | und nicht mit @ . # beginnen");
      return;
    }
    const pfad = neuParent ? `${neuParent}/${name}` : name;
    if ((ordner ?? []).some((o) => o.pfad === pfad)) {
      toast.error("Diesen Ordner gibt es schon");
      return;
    }
    setNeuBusy(true);
    const { error } = await supabase.from("ablage_ordner").insert({ pfad, aktiv: true, nas_ausstehend: true });
    setNeuBusy(false);
    if (error) {
      toast.error("Anlegen fehlgeschlagen: " + error.message);
      return;
    }
    toast.success(`«${pfad}» angelegt — wird beim nächsten Sync auf dem NAS erstellt`);
    setNeuName("");
    setNeuParent(null);
    load();
  }

  /** Inline-Eingabezeile fuer den neuen Ordner (im Baum an Ort und Stelle). */
  const ordnerEditor = (
    <div className="flex items-center gap-2 py-1 flex-wrap">
      <FolderPlus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Input
        autoFocus
        value={neuName}
        onChange={(e) => setNeuName(e.target.value)}
        placeholder={neuParent ? `Neuer Ordner in «${neuParent.split("/").pop()}»…` : "Neuer Hauptordner…"}
        className="h-8 text-xs w-64 max-w-full"
        disabled={neuBusy}
      />
      <button
        type="button"
        onClick={ordnerAnlegen}
        disabled={neuBusy || !neuName.trim()}
        className="kasten shrink-0"
      >
        {neuBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Anlegen
      </button>
      <button
        type="button"
        onClick={() => setNeuParent(null)}
        className="icon-btn shrink-0"
        aria-label="Abbrechen"
        data-tooltip="Abbrechen"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  function merkeOrdner(pfad: string) {
    setLetzteOrdner((prev) => {
      const next = [pfad, ...prev.filter((p) => p !== pfad)].slice(0, 5);
      try { localStorage.setItem(LETZTE_ORDNER_KEY, JSON.stringify(next)); } catch { /* egal */ }
      return next;
    });
  }

  function dateienWaehlen(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    // Sofort in ein echtes Array kopieren: die FileList des Inputs kann
    // beim anschliessenden value=""-Reset geleert werden, BEVOR der
    // batched State-Updater laeuft — dann kaeme still nichts an.
    const liste = Array.from(files);
    const defaultOrdner = letzteOrdner[0] ?? "";
    setPending((prev) => [
      ...prev,
      ...liste.map((f, i) => ({
        key: `${Date.now()}_${i}_${f.name}`,
        file: f,
        kiText: "",
        antwort: "",
        typ: "sonstiges",
        betreff: "",
        person: "",
        partei: "",
        nummer: "",
        dokDatum: "",
        ordner: defaultOrdner,
        status: "offen" as const,
      })),
    ]);
    if (fileRef.current) fileRef.current.value = "";
  }
  dateienWaehlenRef.current = dateienWaehlen;

  function updatePending(key: string, patch: Partial<PendingFile>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  /** KI strukturiert NUR den getippten Beschrieb (+ Dateiname) in die
   *  Namens-Bausteine — das Dokument selbst geht nie an die KI. Fehlt
   *  etwas Wichtiges, kommen Rueckfragen zurueck (Frage-Kasten im UI). */
  async function kiVorschlag(p: PendingFile, text?: string) {
    const beschrieb = (text ?? p.kiText).trim();
    // Ref-Guard statt State: Blur + Knopfklick feuern direkt nacheinander
    // mit demselben (stalen) Render-Objekt — der State-Check allein wuerde
    // dann doppelt analysieren.
    if (beschrieb.length < 3 || kiLaeuftRef.current.has(p.key)) return;
    kiLaeuftRef.current.add(p.key);
    updatePending(p.key, { kiLaeuft: true, kiGelaufen: true, fehler: undefined });
    try {
      const res = await fetch("/api/ablage/name-vorschlag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beschrieb, dateiname: p.file.name }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        kiLaeuftRef.current.delete(p.key);
        updatePending(p.key, { kiLaeuft: false });
        toast.error(json?.error ?? "KI-Vorschlag fehlgeschlagen");
        return;
      }
      const v = json.vorschlag as { typ: string; betreff: string; person: string; partei: string; nummer: string; dok_datum: string; fragen?: string[] };
      kiLaeuftRef.current.delete(p.key);
      // Nur nicht-leere Vorschlaege uebernehmen; laufende Uploads nie anfassen.
      setPending((prev) =>
        prev.map((x) =>
          x.key === p.key && (x.status === "offen" || x.status === "fehler")
            ? {
                ...x,
                kiLaeuft: false,
                typ: v.typ || x.typ,
                betreff: v.betreff || x.betreff,
                // Person nur uebernehmen, wenn der (neue) Typ sie kennt.
                person: dokTyp(v.typ || x.typ)?.person ? (v.person || x.person) : "",
                partei: v.partei || x.partei,
                nummer: v.nummer || x.nummer,
                dokDatum: v.dok_datum || x.dokDatum,
                fragen: v.fragen ?? [],
                antwort: "",
              }
            : x,
        ),
      );
    } catch {
      kiLaeuftRef.current.delete(p.key);
      updatePending(p.key, { kiLaeuft: false });
      toast.error("KI-Vorschlag fehlgeschlagen — Netzwerkfehler");
    }
  }

  /** Antwort auf die KI-Rueckfragen in den Beschrieb mergen + neu analysieren. */
  function fragenBeantworten(p: PendingFile) {
    const antwort = p.antwort.trim();
    if (!antwort) return;
    const neu = `${p.kiText.trim()}; ${antwort}`;
    updatePending(p.key, { kiText: neu, antwort: "" });
    kiVorschlag(p, neu);
  }

  async function ablegen(p: PendingFile): Promise<boolean> {
    const typ = dokTyp(p.typ);
    if (!p.betreff.trim() || !p.ordner) {
      updatePending(p.key, { status: "fehler", fehler: "Betreff und Zielordner sind Pflicht" });
      return false;
    }
    if (typ?.partei?.pflicht && !p.partei.trim()) {
      updatePending(p.key, { status: "fehler", fehler: `${typ.partei.label} fehlt noch — gehört bei «${typ.label}» in den Namen` });
      return false;
    }
    if (typ?.person?.pflicht && !p.person.trim()) {
      updatePending(p.key, { status: "fehler", fehler: `${typ.person.label} fehlt noch — gehört bei «${typ.label}» in den Namen` });
      return false;
    }
    updatePending(p.key, { status: "laedt", fehler: undefined });
    try {
      const fd = new FormData();
      fd.append("file", p.file);
      fd.append("typ", p.typ);
      fd.append("betreff", p.betreff.trim());
      fd.append("person", p.person.trim());
      fd.append("partei", p.partei.trim());
      fd.append("nummer", p.nummer.trim());
      fd.append("dok_datum", p.dokDatum);
      fd.append("ordner", p.ordner);
      const res = await fetch("/api/ablage/upload", { method: "POST", body: fd });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        updatePending(p.key, { status: "fehler", fehler: json?.error ?? "Upload fehlgeschlagen" });
        return false;
      }
      merkeOrdner(p.ordner);
      updatePending(p.key, { status: "fertig" });
      return true;
    } catch {
      updatePending(p.key, { status: "fehler", fehler: "Netzwerkfehler" });
      return false;
    }
  }

  async function alleAblegen() {
    const offen = pending.filter((p) => p.status === "offen" || p.status === "fehler");
    if (offen.length === 0) return;
    setAlleBusy(true);
    let ok = 0;
    for (const p of offen) {
      if (await ablegen(p)) ok++;
    }
    setAlleBusy(false);
    if (ok > 0) {
      toast.success(`${ok} Dokument${ok === 1 ? "" : "e"} abgelegt`);
      // Fertige nach kurzer Sichtbarkeit aus der Liste raeumen.
      setTimeout(() => setPending((prev) => prev.filter((p) => p.status !== "fertig")), 1500);
      load();
    }
  }

  if (!ready) {
    return <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;
  }
  if (role !== "admin") {
    return <p className="text-sm text-muted-foreground p-6">Kein Zugriff — die NAS-Ablage ist Admins vorbehalten.</p>;
  }

  const offeneAnzahl = pending.filter((p) => p.status === "offen" || p.status === "fehler").length;

  return (
    <div className="space-y-6 page-enter">
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <HardDriveUpload className="h-6 w-6" /> NAS
      </h1>
      {/* Kanonisches Nav-Tab-Muster (Underline, border-red-500) — Ablage
          und Backup sind unterschiedliche Sektionen, kein Filter. */}
      <div className="relative mb-4">
        <TabsNav
          tabs={[
            { key: "ablage", label: "Ablage" },
            { key: "ordner", label: "Ordner" },
            { key: "backup", label: "Backup" },
          ]}
          active={tab}
          onChange={(k) => wechsleTab(k as "ablage" | "ordner" | "backup")}
          ariaLabel="NAS-Bereiche"
        />
        {/* Sync-Puls rechts auf der Tablinie — auf allen Tabs sichtbar. */}
        <div className="absolute right-0 top-[45%] -translate-y-1/2">
          <NasPuls status={syncStatus} />
        </div>
      </div>

      {tab === "backup" ? (
        <BackupTab />
      ) : (
      <>
      {tab === "ablage" && (
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-green-600 shrink-0" />
          Vertraulich: Dokument-Inhalte werden nie von KI analysiert — die KI sieht nur deinen getippten Beschrieb.
        </p>
      )}

      {tab === "ordner" && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-sm">NAS-Ordnerstruktur</CardTitle>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBearbeiten((b) => !b)}
                  aria-pressed={bearbeiten}
                  className={`kasten ${bearbeiten ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-500/15 dark:border-red-500/40 dark:text-red-300" : ""}`}
                  data-tooltip={bearbeiten ? "Bearbeiten beenden" : "Aktiv-Häkchen zum (De-)Aktivieren einblenden"}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Bearbeiten
                </button>
                <button type="button" onClick={() => editorOeffnen("")} className="kasten">
                  <FolderPlus className="h-3.5 w-3.5" />
                  Neuer Hauptordner
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Die Liste kommt automatisch vom NAS (Abgleich ca. alle 10 Minuten).
              Mit dem <FolderPlus className="h-3 w-3 inline align-[-1px]" /> am Ordner legst du direkt dort einen
              Unterordner an — er wird beim nächsten Sync auf dem NAS erstellt.
              Häkchen weg = Ordner erscheint nicht mehr in der Zielordner-Auswahl.
            </p>
            {(ordner ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Noch keine Ordner — sie erscheinen automatisch, sobald der Sync-Container auf dem NAS läuft.
              </p>
            ) : (
              (() => {
                // Explorer-Ansicht (Leo 2026-09-30): links echter Baum mit
                // Fuehrungslinien, jede Ebene einzeln auf-/zuklappbar;
                // rechts der Inhalt des gewaehlten Ordners (Unterordner +
                // Dateien aus dem Datei-Index).
                const filter = ordnerFilter.trim().toLowerCase();
                const passt = (p: string) => p.toLowerCase().includes(filter);
                const zeigen = (o: OrdnerRow) =>
                  !filter || passt(o.pfad) || (ordner ?? []).some((x) => x.pfad.startsWith(o.pfad + "/") && passt(x.pfad));
                const deaktiviert = (ordner ?? []).filter((o) => !o.aktiv).length;

                const zeile = (o: OrdnerRow, tiefe: number): ReactNode => {
                  const alleKinder = kinderVon.get(o.pfad) ?? [];
                  const kinder = alleKinder.filter(zeigen);
                  const hatKinder = alleKinder.length > 0;
                  const offen = filter !== "" ? kinder.length > 0 : offene.has(o.pfad);
                  const sperrer = gesperrtDurch(o.pfad);
                  const vererbGesperrt = sperrer !== null && sperrer !== o.pfad;
                  const gewaehlt = auswahl === o.pfad;
                  return (
                    <li key={o.id}>
                      <div className={`flex items-center gap-1 rounded-lg pl-1 pr-1.5 py-1 ${gewaehlt ? "bg-muted" : ""}`}>
                        {hatKinder ? (
                          <button
                            type="button"
                            onClick={() => setOffene((prev) => {
                              const next = new Set(prev);
                              if (next.has(o.pfad)) next.delete(o.pfad); else next.add(o.pfad);
                              return next;
                            })}
                            className="p-0.5 rounded text-muted-foreground shrink-0"
                            aria-label={offen ? "Zuklappen" : "Aufklappen"}
                          >
                            <ChevronRight className={`h-4 w-4 transition-transform ${offen ? "rotate-90" : ""}`} />
                          </button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}
                        <button
                          type="button"
                          onClick={() => waehlen(o.pfad)}
                          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                          data-tooltip={vererbGesperrt ? `Über «${sperrer}» deaktiviert` : undefined}
                        >
                          {offen && hatKinder ? (
                            <FolderOpen className={`h-4 w-4 shrink-0 ${sperrer ? "text-muted-foreground/40" : "text-amber-500 dark:text-amber-400"}`} />
                          ) : (
                            <Folder className={`h-4 w-4 shrink-0 ${sperrer ? "text-muted-foreground/40" : "text-amber-500 dark:text-amber-400"}`} />
                          )}
                          <span className={`truncate text-sm ${tiefe === 0 ? "font-medium" : ""} ${sperrer ? "text-muted-foreground/50 line-through" : ""}`}>
                            {o.pfad.split("/").pop()}
                          </span>
                          {o.nas_ausstehend && (
                            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" data-tooltip="Im FSM angelegt — wird beim nächsten Sync auf dem NAS erstellt">
                              <Clock className="h-2.5 w-2.5" /> ausstehend
                            </span>
                          )}
                        </button>
                        {bearbeiten && (
                          <label
                            className={`shrink-0 flex ${vererbGesperrt ? "cursor-not-allowed" : "cursor-pointer"}`}
                            data-tooltip={o.aktiv ? "Als Ablage-Ziel aktiv — Häkchen weg = ausblenden" : "Als Ablage-Ziel deaktiviert"}
                          >
                            <input
                              type="checkbox"
                              checked={o.aktiv}
                              onChange={() => toggleOrdner(o)}
                              disabled={vererbGesperrt}
                              className="h-4 w-4 accent-red-600 disabled:opacity-40"
                            />
                          </label>
                        )}
                        {sperrer === null && (
                          <button
                            type="button"
                            onClick={() => editorOeffnen(o.pfad)}
                            className="icon-btn shrink-0 opacity-60"
                            aria-label={`Unterordner in ${o.pfad} anlegen`}
                            data-tooltip="Unterordner anlegen"
                          >
                            <FolderPlus className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {neuParent === o.pfad && <div className="pl-6">{ordnerEditor}</div>}
                      {offen && kinder.length > 0 && (
                        <ul className="ml-[13px] border-l border-border pl-2.5 space-y-0.5">
                          {kinder.map((k) => zeile(k, tiefe + 1))}
                        </ul>
                      )}
                    </li>
                  );
                };
                const unterordner = auswahl ? (kinderVon.get(auswahl) ?? []) : [];
                return (
                  <div className="flex flex-col lg:flex-row gap-6">
                    {/* Linke Seite: der Baum */}
                    <div className="lg:w-[380px] xl:w-[440px] shrink-0 lg:border-r lg:border-border lg:pr-6 space-y-2">
                      <Input
                        value={ordnerFilter}
                        onChange={(e) => setOrdnerFilter(e.target.value)}
                        placeholder="Ordner filtern…"
                        className="h-8 text-xs"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {(ordner ?? []).length} Ordner{deaktiviert > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{deaktiviert} deaktiviert</span></>}
                      </p>
                      {neuParent === "" && ordnerEditor}
                      <ul className="space-y-0.5">
                        {(kinderVon.get("") ?? []).filter(zeigen).map((o) => zeile(o, 0))}
                      </ul>
                    </div>
                    {/* Rechte Seite: Inhalt des gewaehlten Ordners */}
                    <div className="flex-1 min-w-0">
                      {!auswahl ? (
                        <div className="min-h-[240px] h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
                          <FolderOpen className="h-8 w-8 opacity-40" />
                          <p className="text-sm">Wähle links einen Ordner — hier erscheinen seine Unterordner und Dateien.</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <p className="text-sm font-mono font-medium truncate">{auswahl}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {unterordner.length} Unterordner · {paneDateien ? paneDateien.length : "…"} Dateien — Stand letzter NAS-Scan (ca. alle 10 Min)
                            </p>
                          </div>
                          {unterordner.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {unterordner.map((u) => (
                                <button key={u.id} type="button" onClick={() => waehlen(u.pfad)} className="kasten kasten-muted">
                                  <Folder className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                                  {u.pfad.split("/").pop()}
                                </button>
                              ))}
                            </div>
                          )}
                          {paneLaedt ? (
                            <div className="space-y-2">
                              {[0, 1, 2].map((i) => <div key={i} className="shimmer rounded-md h-8" />)}
                            </div>
                          ) : (paneDateien ?? []).length === 0 ? (
                            unterordner.length === 0
                              ? <p className="text-sm text-muted-foreground">Dieser Ordner ist leer (Stand letzter Scan).</p>
                              : <p className="text-xs text-muted-foreground">Keine Dateien direkt in diesem Ordner.</p>
                          ) : (
                            <ul>
                              {(paneDateien ?? []).map((d) => {
                                const pfadVoll = `${auswahl}/${d.name}`;
                                const laeuft = !!abrufLaeuft[pfadVoll];
                                const hover = hoverRow === pfadVoll;
                                return (
                                  <li
                                    key={d.name}
                                    onMouseEnter={() => setHoverRow(pfadVoll)}
                                    onMouseLeave={() => setHoverRow((h) => (h === pfadVoll ? null : h))}
                                    className={`py-1.5 px-2 -mx-2 rounded-lg flex items-center gap-2.5 ${hover ? "bg-muted/60" : ""}`}
                                  >
                                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                                    {/* Klick holt die Datei vom NAS und laedt sie
                                        im Browser herunter (Leo 2026-09-30). */}
                                    <button
                                      type="button"
                                      onClick={() => dateiAbrufen(pfadVoll)}
                                      disabled={laeuft}
                                      aria-label={`${d.name} herunterladen`}
                                      className="min-w-0 flex-1 truncate text-sm text-left disabled:opacity-60"
                                    >
                                      {d.name}
                                    </button>
                                    {laeuft ? (
                                      <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0 tabular-nums">
                                        <Loader2 className="h-3 w-3 animate-spin" /> holt vom NAS… Abgleich in <NasCountdown status={syncStatus} />
                                      </span>
                                    ) : (
                                      <>
                                        {d.geaendert && (
                                          <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                                            {new Date(d.geaendert).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                                          </span>
                                        )}
                                        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums w-16 text-right">{fmtBytes(d.groesse)}</span>
                                        <span className="w-12 shrink-0 flex items-center justify-end gap-1">
                                          {hover && (
                                            <>
                                              <button
                                                type="button"
                                                onClick={async () => {
                                                  try {
                                                    await navigator.clipboard.writeText(pfadVoll);
                                                    toast.success("NAS-Pfad kopiert", { description: pfadVoll });
                                                  } catch {
                                                    toast.error("Kopieren fehlgeschlagen");
                                                  }
                                                }}
                                                className="icon-btn opacity-70"
                                                aria-label="NAS-Pfad kopieren"
                                              >
                                                <Copy className="h-3.5 w-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => dateiAbrufen(pfadVoll)}
                                                className="icon-btn"
                                                aria-label="Herunterladen"
                                              >
                                                <Download className="h-4 w-4 animate-bounce text-blue-600 dark:text-blue-400" />
                                              </button>
                                            </>
                                          )}
                                        </span>
                                      </>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Ablegen ────────────────────────────────────────── */}
      {tab === "ablage" && (
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          {ordner !== null && ordner.length === 0 && (
            <div className="px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-xs text-amber-800 dark:text-amber-200">
              Noch keine Ordnerstruktur hinterlegt — im Tab «Ordner» anlegen oder den Sync-Container auf dem NAS starten.
            </div>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={`w-full flex items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed text-sm font-medium transition-colors ${
              zieht
                ? "border-red-400 bg-red-50/60 text-red-700 dark:bg-red-500/10 dark:border-red-500/50 dark:text-red-300"
                : "text-muted-foreground hover:text-foreground hover:border-foreground/30"
            }`}
          >
            <Upload className="h-4 w-4" />
            {zieht ? "Loslassen — Datei wird hinzugefügt" : "Dateien wählen oder hierhin ziehen"}
          </button>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => dateienWaehlen(e.target.files)} />

          {pending.length > 0 && (
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.key} className={`p-3 rounded-xl border space-y-2 ${p.status === "fertig" ? "border-green-300 bg-green-50/50 dark:bg-green-500/10 dark:border-green-500/30" : p.status === "fehler" ? "border-red-300 bg-red-50/40 dark:bg-red-500/10 dark:border-red-500/30" : "bg-muted/20"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5 min-w-0">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.file.name}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">({(p.file.size / 1024 / 1024).toFixed(1)} MB)</span>
                    </p>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {p.status === "laedt" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {p.status === "fertig" && <span className="text-[11px] font-medium text-green-700 dark:text-green-400 flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Abgelegt</span>}
                      {p.status !== "laedt" && p.status !== "fertig" && (
                        <button type="button" onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))} className="icon-btn icon-btn-red" aria-label="Entfernen" data-tooltip="Entfernen">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                  {p.status !== "fertig" && (() => {
                    const typ = dokTyp(p.typ);
                    const laedt = p.status === "laedt";
                    const vorschau = p.betreff.trim()
                      ? baueAblageName(
                          { typKey: p.typ, betreff: p.betreff, person: typ?.person ? p.person : "", partei: p.partei, nummer: p.nummer, dokDatum: p.dokDatum },
                          p.file.name,
                          heuteZurich(),
                        )
                      : null;
                    return (
                      <div className="space-y-2">
                        {/* KI-Beschrieb: einziger KI-Input ist dieser Text +
                            der Dateiname — das Dokument geht NIE an die KI
                            (harte Leo-Vorgabe, vertrauliche Dokumente). */}
                        <div className="flex gap-2">
                          <Input
                            placeholder="Beschrieb in deinen Worten — z.B. «Haftpflichtversicherung von der AXA, Police P-778812, vom 15.1.26»"
                            value={p.kiText}
                            onChange={(e) => updatePending(p.key, { kiText: e.target.value })}
                            onBlur={() => {
                              // Smart mitdenken: beim Verlassen des Felds einmal
                              // automatisch analysieren (danach nur noch per Knopf).
                              if (!p.kiGelaufen && !p.kiLaeuft && p.kiText.trim().length >= 10) kiVorschlag(p);
                            }}
                            disabled={laedt || p.kiLaeuft}
                            className="flex-1"
                          />
                          <button
                            type="button"
                            onClick={() => kiVorschlag(p)}
                            disabled={laedt || p.kiLaeuft || p.kiText.trim().length < 3}
                            className="kasten shrink-0"
                            data-tooltip="KI setzt aus deinem Beschrieb Typ, Betreff, Partei, Nummer und Datum ein"
                          >
                            {p.kiLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            {p.kiLaeuft ? "Füllt aus…" : "Felder ausfüllen"}
                          </button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Die KI sieht nur diesen Text und den Dateinamen — nie das Dokument.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <SearchableSelect
                            value={p.typ}
                            onChange={(v) => updatePending(p.key, { typ: v })}
                            items={DOK_TYPEN.map((t) => ({ id: t.key, label: t.label }))}
                            placeholder="Dokumenttyp…"
                          />
                          <SearchableSelect
                            value={p.ordner}
                            onChange={(v) => updatePending(p.key, { ordner: v })}
                            items={ordnerOptionen}
                            placeholder="Zielordner wählen… *"
                          />
                        </div>
                        <Input
                          placeholder={typ?.key === "sonstiges" ? "Betreff — was ist das Dokument? *" : "Betreff — worum geht es? (z.B. Haftpflicht) *"}
                          value={p.betreff}
                          onChange={(e) => updatePending(p.key, { betreff: e.target.value })}
                          disabled={laedt}
                        />
                        {/* "Folgefragen": typ-abhaengige Zusatzfelder, die der
                            Name braucht — erscheinen direkt beim Typ-Wechsel. */}
                        {typ && (
                          <div className={`grid grid-cols-1 gap-2 ${(typ.person ? 1 : 0) + (typ.partei ? 1 : 0) + (typ.nummer ? 1 : 0) >= 3 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
                            {typ.person && (
                              <SearchableSelect
                                value={p.person}
                                onChange={(v) => updatePending(p.key, { person: v })}
                                items={mitarbeiter.map((m) => ({ id: m, label: m }))}
                                placeholder={`${typ.person.label}${typ.person.pflicht ? " *" : ""} — wählen…`}
                              />
                            )}
                            {typ.partei && (
                              <Input
                                placeholder={`${typ.partei.label}${typ.partei.pflicht ? " *" : ""} — ${typ.partei.placeholder ?? ""}`}
                                value={p.partei}
                                onChange={(e) => updatePending(p.key, { partei: e.target.value })}
                                disabled={laedt}
                              />
                            )}
                            {typ.nummer && (
                              <Input
                                placeholder={`${typ.nummer.label} — optional`}
                                value={p.nummer}
                                onChange={(e) => updatePending(p.key, { nummer: e.target.value })}
                                disabled={laedt}
                              />
                            )}
                            <Input
                              type="date"
                              value={p.dokDatum}
                              onChange={(e) => updatePending(p.key, { dokDatum: e.target.value })}
                              disabled={laedt}
                              aria-label="Dokument-Datum (optional, sonst heute)"
                              data-tooltip="Datum des Dokuments — leer = heutiges Ablage-Datum"
                            />
                          </div>
                        )}
                        {/* KI-Rueckfragen: fehlt im Beschrieb etwas Wichtiges
                            (Person, Gegenpartei, Datum), fragt die KI gezielt
                            nach — Antwort wird in den Beschrieb gemerged und
                            neu strukturiert. */}
                        {!p.kiLaeuft && (p.fragen?.length ?? 0) > 0 && (
                          <div className="px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 space-y-1.5">
                            {p.fragen!.map((f, i) => (
                              <p key={i} className="text-xs font-medium text-amber-800 dark:text-amber-200">{f}</p>
                            ))}
                            <div className="flex gap-2">
                              <Input
                                placeholder="Antwort — z.B. «für Tim, vom 12.8.»"
                                value={p.antwort}
                                onChange={(e) => updatePending(p.key, { antwort: e.target.value })}
                                disabled={laedt}
                                className="flex-1"
                              />
                              <button
                                type="button"
                                onClick={() => fragenBeantworten(p)}
                                disabled={laedt || !p.antwort.trim()}
                                className="kasten shrink-0"
                              >
                                <Sparkles className="h-3.5 w-3.5" />
                                Ergänzen
                              </button>
                            </div>
                          </div>
                        )}
                        {vorschau && (
                          <p className="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={vorschau}>
                            → {vorschau}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {p.fehler && <p className="text-xs text-red-600 dark:text-red-400">{p.fehler}</p>}
                </div>
              ))}
              <button
                type="button"
                onClick={alleAblegen}
                disabled={alleBusy || offeneAnzahl === 0}
                className="kasten kasten-red w-full"
              >
                {alleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveUpload className="h-3.5 w-3.5" />}
                {alleBusy ? "Legt ab…" : offeneAnzahl === 1 ? "Dokument ablegen" : `${offeneAnzahl} Dokumente ablegen`}
              </button>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* ── Historie / Namensregister ──────────────────────── */}
      {tab === "ablage" && (
      <Card className="bg-card">
        {(() => {
          // NAS-Index-Treffer ohne die, die schon als Ablage-Eintrag da sind.
          const belegt = new Set(items.map((i) => `${i.ordner_pfad}/${i.abgelegt_name}`));
          const nasTreffer = suche.trim() ? indexTreffer.filter((x) => !belegt.has(x.pfad)) : [];
          const anzahl = items.length + nasTreffer.length;
          return (
          <>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-sm">{suche.trim() ? `Suchergebnisse (${anzahl})` : "Zuletzt abgelegt"}</CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={suche}
                onChange={(e) => setSuche(e.target.value)}
                placeholder="Dokument suchen — findet alles auf dem NAS…"
                className="h-8 text-xs pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {anzahl === 0 ? (
            <p className="text-sm text-muted-foreground">{suche.trim() ? "Nichts gefunden." : "Noch nichts abgelegt."}</p>
          ) : (
            <ul>
              {items.map((i) => {
                const a = Array.isArray(i.autor) ? i.autor[0] : i.autor;
                const pfadVoll = `${i.ordner_pfad}/${i.abgelegt_name}`;
                return (
                  <li
                    key={i.id}
                    onMouseEnter={() => setHoverRow(i.id)}
                    onMouseLeave={() => setHoverRow((h) => (h === i.id ? null : h))}
                    className={`py-2 px-2 -mx-2 rounded-lg flex items-start gap-2.5 ${hoverRow === i.id ? "bg-muted/60" : ""}`}
                  >
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      {/* Titel-Klick springt in den Ordner-Explorer (Leo 2026-09-30). */}
                      <button
                        type="button"
                        onClick={() => { waehlen(i.ordner_pfad); wechsleTab("ordner"); }}
                        aria-label={`${i.abgelegt_name} im Explorer zeigen`}
                        className="block max-w-full truncate text-sm text-left"
                      >
                        {i.abgelegt_name}
                      </button>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
                        <span className="font-mono">{i.ordner_pfad}</span>
                        <ChevronRight className="h-3 w-3" />
                        {fmtWann(i.created_at)}{a?.full_name ? ` · ${a.full_name}` : ""}
                      </p>
                    </div>
                    {i.synced_at ? (
                      <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" data-tooltip={`Übertragen ${fmtWann(i.synced_at)}`}>
                        <Check className="h-2.5 w-2.5" /> Auf NAS
                      </span>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" data-tooltip="Der NAS-Sync hat die Datei noch nicht abgeholt">
                        <Loader2 className="h-2.5 w-2.5" /> Wartet auf Sync
                      </span>
                    )}
                    {i.synced_at && (
                      <span className="w-7 shrink-0 flex justify-end">
                        {(hoverRow === i.id || abrufLaeuft[pfadVoll]) && (
                          <button
                            type="button"
                            onClick={() => dateiAbrufen(pfadVoll)}
                            className="icon-btn"
                            aria-label="Herunterladen"
                          >
                            {abrufLaeuft[pfadVoll]
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <Download className="h-4 w-4 animate-bounce text-blue-600 dark:text-blue-400" />}
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
              {nasTreffer.map((x) => (
                <li
                  key={x.id}
                  onMouseEnter={() => setHoverRow(x.id)}
                  onMouseLeave={() => setHoverRow((h) => (h === x.id ? null : h))}
                  className={`py-2 px-2 -mx-2 rounded-lg flex items-start gap-2.5 ${hoverRow === x.id ? "bg-muted/60" : ""}`}
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => { waehlen(x.ordner_pfad); wechsleTab("ordner"); }}
                      aria-label={`${x.name} im Explorer zeigen`}
                      className="block max-w-full truncate text-sm text-left"
                    >
                      {x.name}
                    </button>
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
                      <span className="font-mono">{x.ordner_pfad || "(Hauptebene)"}</span>
                      {x.geaendert && (
                        <>
                          <ChevronRight className="h-3 w-3" />
                          {fmtWann(x.geaendert)}
                        </>
                      )}
                    </p>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" data-tooltip="Liegt auf dem NAS (vom Datei-Scan gefunden)">
                    <Check className="h-2.5 w-2.5" /> Auf NAS
                  </span>
                  <span className="w-7 shrink-0 flex justify-end">
                    {(hoverRow === x.id || abrufLaeuft[x.pfad]) && (
                      <button
                        type="button"
                        onClick={() => dateiAbrufen(x.pfad)}
                        className="icon-btn"
                        aria-label="Herunterladen"
                      >
                        {abrufLaeuft[x.pfad]
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Download className="h-4 w-4 animate-bounce text-blue-600 dark:text-blue-400" />}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
          </>
          );
        })()}
      </Card>
      )}
      </>
      )}
    </div>
  );
}
