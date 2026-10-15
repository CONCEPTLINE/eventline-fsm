"use client";

// NAS-Ablage (Leo 2026-09-26): Dokumente hier ablegen statt von Hand auf
// dem UGREEN-NAS einsortieren. Pro Datei PFLICHT: Betreff + Zielordner
// aus der gepflegten NAS-Struktur. DOKUMENTE NIE AN EINEN CLOUD-DIENST —
// den Inhalt liest nur die LOKALE KI im Buero (docs/lokale-ki/SPEC.md,
// «Ablage ohne Tippen», 2026-10-02): Datei rein -> /api/ablage/ki-upload
// -> Auftrag `ablage_analyse` -> Ergebnis fuellt Beschrieb + alle Felder.
// Ist die lokale KI offline, gilt der bisherige Weg: der Nutzer tippt den
// Beschrieb, Claude strukturiert NUR diesen Text (+ Dateiname) in die
// Namens-Bausteine (/api/ablage/name-vorschlag). Die Dateien landen im
// privaten Uebergabe-Bucket, das NAS holt sie per Sync ab (kein offener
// Port am NAS).
//
// Admin-only: Sidebar zeigt den Eintrag nur Admins, die Seite gated
// zusaetzlich selbst, RLS + API (requireAdmin) sichern die Daten.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { BackupTab } from "@/components/nas/backup-tab";
import { InhaltTreffer } from "@/components/nas/inhalt-treffer";
import { ArchivAntwort, useArchivAutoFrage, useArchivFrage } from "@/components/nas/archiv-frage";
import { erzeugeThumb, holeNasDatei, kiBereitFuer, leseKiArten, weckeKi } from "@/components/nas/ki-hilfen";
import { RueckstauZz } from "@/components/nas/vorschlaege-gruppe";
import { FristenGruppe } from "@/components/nas/fristen-gruppe";
import { TabsNav } from "@/components/ui/tabs-nav";
import { DOK_TYPEN, dokTyp, baueAblageName } from "@/lib/ablage-doktypen";
import { berechneOrdnerVorschlaege } from "@/lib/ordner-vorschlaege";
import { KI_TIMEOUT_ABLAGE_MS } from "@/lib/ki/konstanten";
import { istSystemPfad } from "@/lib/ki/bereinigen";
import { leseOrdnerName } from "@/lib/ki/pfade";
import { todayLocalIso } from "@/lib/swiss-time";
import type { OrdnerQuelle, OrdnerSicherheit } from "@/lib/ki/typen";
import { leseAblageDoppel, type AblageDoppel } from "@/lib/ki/doppel";
import { kiVorschlagKarte, type KiVorschlagKarte } from "@/lib/ki/ablage-ki-vorschlag";
import { DoppelteListe } from "@/components/nas/doppelte-liste";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { toast } from "sonner";
import {
  HardDriveUpload, Upload, Loader2, Check, Trash2,
  ShieldCheck, FileText, ChevronRight, Sparkles, FolderPlus, Clock, Search, X,
  Folder, FolderOpen, Download, Copy, Pencil, HardDrive, FolderInput, Bell, Mail, Layers,
  Cpu, TriangleAlert, Inbox, CalendarClock,
} from "lucide-react";
import { useConfirm } from "@/components/ui/use-confirm";

interface OrdnerRow { id: string; pfad: string; aktiv: boolean; nas_ausstehend: boolean }
/** Zeile aus dem NAS-Datei-Index (vom Sync-Client gescannte Dateinamen). */
interface IndexRow { id: string; pfad: string; ordner_pfad: string; name: string; geaendert: string | null }
/** Per Mail an ablage@ eingegangener Anhang, wartet auf Uebernahme. */
interface EingangRow { id: string; name: string; mime_type: string | null; groesse: number | null; mail_von: string | null; mail_betreff: string | null; created_at: string }
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
  /** Kurzbeschrieb: von der lokalen KI gelesen oder frei getippt — im
   *  Claude-Weg (Fallback) die EINZIGE KI-Eingabe (nie die Datei). */
  kiText: string;
  /** Tmp-Objekt `ki-tmp/<id>` im Bucket (SPEC 2.3) — ablegen() schickt
   *  dann `tmp_id` statt der Datei, der Server verschiebt das Objekt. */
  tmpId?: string;
  /** Auftrag `ablage_analyse` der lokalen KI (wird alle 1,5 s abgefragt). */
  auftragId?: string;
  /** Fortschritt waehrend die lokale KI liest (offen -> wartet, laeuft -> liest). */
  lokalStatus?: "wartet" | "liest";
  /** Start des Lese-Vorgangs (ms) fuer die Sekunden-Anzeige. */
  lokalSeit?: number;
  /** Felder stammen von der lokalen KI (Chip «lokal gelesen»). */
  lokalGelesen?: boolean;
  /** Echter Fehler beim lokalen Lesen (Lesefehler, Zeitueberschreitung,
   *  Server-Meldung) — amber Hinweis in der Karte. Das generische «nicht
   *  erreichbar» steht EINMAL ueber der Karten-Liste, nicht pro Karte. */
  lokalHinweis?: string;
  /** Beschrieb-Feld beim Eintritt in «beschreiben» fokussieren — nur nach
   *  Nutzeraktion (Hinzufuegen, «Selbst beschreiben»), nie beim
   *  automatischen Rueckfall aus lokalLesen() (reisst sonst den Fokus an sich). */
  fokus?: boolean;
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
  /** Kuendigungs-/Ablauffrist (optional) — Erinnerung 30/7/0 Tage vorher. */
  frist: string;
  ordner: string;
  /** Flow: lesen (lokale KI liest das Dokument) -> pruefen; Fallback
   *  ohne lokale KI: beschreiben (1 Feld, Claude nur mit dem Text) -> pruefen. */
  phase: "lesen" | "beschreiben" | "pruefen";
  /** Detail-Felder im Pruefen-Schritt aufgeklappt. */
  anpassen?: boolean;
  status: "offen" | "laedt" | "fertig" | "fehler";
  fehler?: string;
  /** Mögliche-Duplikat-Funde vom Server (409) — nie blockierend. */
  duplikatFunde?: { art: string; text: string }[];
  /** Doppel-Prüfung der lokalen KI gegen das ganze NAS (Migration 334): exakt / gleicher Inhalt / neuere Fassung —
   *  nur Pfad, nie Text; Hinweis vor dem Ablegen, nie blockierend. */
  rigDoppel?: AblageDoppel;
  /** Mini-Vorschau (Object-/Data-URL) — null solange keine da ist. */
  thumb?: string;
  /** KI-Vorschlag fuer einen NEUEN Zielordner (wenn keiner passt). */
  neuerOrdner?: string;
  /** Naechstbeste Zielordner der lokalen KI (max 2, volle Pfade) — Chips
   *  «Oder:»/«Vorschläge:»; nur lokal gelesene Karten, nie der Claude-Weg. */
  ordnerAlternativen?: string[];
  /** V8 — woher `ordner` stammt (Chip neben dem Zielordner). Faellt weg,
   *  sobald der Nutzer einen anderen Ordner waehlt. */
  ordnerQuelle?: OrdnerQuelle;
  /** V8 — nur bei Claude; «niedrig» -> Zeile «Unsicher — bitte prüfen». */
  ordnerSicherheit?: OrdnerSicherheit;
  ordnerBegruendung?: string;
  /** Momentaufnahme des letzten KI-Vorschlags (lokale KI oder Claude-Weg), unberührt von späteren Änderungen —
   *  geht beim Ablegen mit, der Server hält ihn neben dem gewählten Ziel fest (Trefferquote, Migration 339). */
  kiVorschlag?: KiVorschlagKarte;
}

const LETZTE_ORDNER_KEY = "ablage-letzte-ordner";

const ITEM_SELECT = "id, ordner_pfad, beschrieb, abgelegt_name, created_at, synced_at, autor:profiles!ablage_items_created_by_fkey(full_name)";

/** Mail-Adresse der Ablage — Anhaenge landen im "Per Mail eingegangen"-
 *  Eingang (gleiche Inbound-Route wie auftrag@). */
const ABLAGE_MAIL = "ablage@in.eventline-basel.com";

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

// ── Lokale KI (docs/lokale-ki/SPEC.md 2.3 / 3.1) ─────────────────────
/** Antwort von GET /api/ki/status. */
interface KiStatus {
  online: boolean;
  letzter_poll: string | null;
  modell: string | null;
  warteschlange: number;
  /** Vom Rig gemeldete Arten (MP-1): undefined = unbekannt, null = altes Rig. */
  arten: string[] | null | undefined;
}
/** Ergebnis eines `ablage_analyse`-Auftrags (SPEC 3.1) — nur die Felder,
 *  die die Karte fuellt; Kennzahlen (sha256, seiten, dauer_ms) bleiben
 *  dem Server. */
interface KiAblageErgebnis {
  beschrieb?: string | null;
  typ?: string | null;
  betreff?: string | null;
  person?: string | null;
  partei?: string | null;
  nummer?: string | null;
  dok_datum?: string | null;
  frist?: string | null;
  ordner?: string | null;
  /** Bis zu zwei naechstbeste Ziele (Server prueft gegen die aktive Liste). */
  ordner_alternativen?: string[] | null;
  neuer_ordner?: string | null;
  /** V8 — Herkunft des Zielordners (Chip «Regel»/«Vorbild»/«Claude»);
   *  fehlt bei einem Rig ohne V8. */
  ordner_quelle?: OrdnerQuelle | null;
  ordner_sicherheit?: OrdnerSicherheit | null;
  ordner_begruendung?: string | null;
  /** Doppel-Prüfung des Rigs (lib/ki/doppel, leseAblageDoppel). */
  doppel?: unknown;
}
/** Kopfzeile des Doppel-Hinweises auf der Ablage-Karte (Rig, Migration 334). */
const RIG_DOPPEL_TITEL: Record<AblageDoppel["art"], string> = {
  exakt: "Liegt schon auf dem NAS — nicht nochmals ablegen",
  inhalt: "Wahrscheinlich gleiches Dokument (andere Form) wie",
  fassung: "Neuere Fassung von",
};
const ORDNER_QUELLE_LABEL: Record<OrdnerQuelle, string> = { regel: "Regel", lokal: "Vorbild", claude: "Claude" };
const ORDNER_QUELLE_TOOLTIP: Record<OrdnerQuelle, string> = {
  regel: "Zielordner nach fester Regel (z. B. Auftragsnummer → Projektordner, Personalakte → Akte der Person)",
  lokal: "Zielordner von der lokalen KI im Büro nach Vorbild-Dokumenten gewählt — ohne Claude",
  claude: "Zielordner von Claude anhand einer minimierten Einordnung gewählt — das Dokument selbst bleibt im Haus",
};
const KI_AUFTRAG_POLL_MS = 1_500;
const KI_STATUS_POLL_MS = 60_000;
const KI_OFFLINE_HINWEIS = "Lokale KI nicht erreichbar — Beschrieb eingeben";

/** Kleiner Fortschritt waehrend die lokale KI liest: Status-Text aus dem
 *  Auftrag + Sekunden seit Start. Tickt nur hier (wie NasCountdown). */
function LeseFortschritt({ seit, status }: { seit: number; status?: "wartet" | "liest" }) {
  // Sekunden im State statt Date.now() im Render (react-hooks/purity).
  const [sek, setSek] = useState(0);
  useEffect(() => {
    const tick = () => setSek(Math.max(0, Math.round((Date.now() - seit) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [seit]);
  return (
    <span className="text-muted-foreground tabular-nums">
      {status === "liest" ? "liest…" : "wartet auf die lokale KI"} · {sek} s
    </span>
  );
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
  /** Rechte Spalte im Tab «Ablage»: Einsortieren (Rückstau ZZ) oder Fristen.
   *  URL-Param `gruppe` (§10) — `?gruppe=fristen` ist zugleich der Deep-Link
   *  aus Dashboard und Erinnerungs-Mail. */
  const [sicht, setSicht] = useState<"einsortieren" | "fristen" | "doppelte">(() => {
    if (typeof window === "undefined") return "einsortieren";
    const g = new URLSearchParams(window.location.search).get("gruppe");
    return g === "fristen" || g === "doppelte" ? g : "einsortieren";
  });
  const sichtRef = useRef(sicht);
  sichtRef.current = sicht;
  function wechsleTab(t: "ablage" | "ordner" | "backup") {
    setTab(t);
    window.history.replaceState(null, "", t === "ablage" ? `/nas?tab=ablage&gruppe=${sichtRef.current}` : `/nas?tab=${t}`);
  }
  function wechsleSicht(s: "einsortieren" | "fristen" | "doppelte") {
    setSicht(s);
    window.history.replaceState(null, "", `/nas?tab=ablage&gruppe=${s}`);
  }
  /** Anzahlen fuer den Umschalter (null = laedt noch). */
  const [zzAnzahl, setZzAnzahl] = useState<number | null>(null);
  const [doppelAnzahl, setDoppelAnzahl] = useState<number | null>(null);
  const [fristAnzahl, setFristAnzahl] = useState<{ n: number | null; zuPruefen: number }>({ n: null, zuPruefen: 0 });
  const meldeFristen = useCallback((n: number | null, zuPruefen: number) => setFristAnzahl({ n, zuPruefen }), []);

  // ── Fit-to-Viewport (Laptop, ab xl): das Raster des Tabs «Ablage» fuellt
  // genau die Fensterhoehe unter dem Kopf; lange Listen scrollen intern,
  // die Seite nicht. Oberkante gemessen statt geraten (Kopf/Infozeile koennen
  // umbrechen); unter xl stapelt sich alles und die Seite scrollt normal.
  const [rasterH, setRasterH] = useState<number | null>(null);
  const rasterElRef = useRef<HTMLDivElement | null>(null);
  const rasterMessen = useCallback(() => {
    const el = rasterElRef.current;
    if (!el) return;
    const oben = el.getBoundingClientRect().top + window.scrollY;
    // 32 px = unteres Polster von <main> (md:py-8) — sonst klebt die Karte am Rand.
    setRasterH(Math.max(440, Math.floor(window.innerHeight - oben - 32)));
  }, []);
  const rasterBeobachter = useRef<ResizeObserver | null>(null);
  const rasterRef = useCallback((el: HTMLDivElement | null) => {
    rasterBeobachter.current?.disconnect();
    rasterBeobachter.current = null;
    rasterElRef.current = el;
    if (!el) return;
    rasterMessen();
    // Kopf/Infozeile aendern ihre Hoehe nach dem Laden (KI-Status, Umbruch):
    // die Seite (Eltern-Element) waechst dann mit -> neu messen. Gleicher
    // Wert = kein neues Rendern (React bricht bei gleichem State ab).
    if (typeof ResizeObserver !== "undefined" && el.parentElement) {
      const ro = new ResizeObserver(() => rasterMessen());
      ro.observe(el.parentElement);
      rasterBeobachter.current = ro;
    }
  }, [rasterMessen]);
  useEffect(() => {
    window.addEventListener("resize", rasterMessen);
    return () => window.removeEventListener("resize", rasterMessen);
  }, [rasterMessen]);
  const [ordner, setOrdner] = useState<OrdnerRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  /** Aktive Mitarbeiter fuer das Person-Feld (kanonische volle Namen). */
  const [mitarbeiter, setMitarbeiter] = useState<string[]>([]);
  /** Per Mail eingegangene Anhaenge (ablage@ -> Migr 282/283). */
  const [eingang, setEingang] = useState<EingangRow[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  /** Aktueller Karten-Stand fuer den Unmount-Cleanup — die Effekt-Closure
   *  saehe sonst den Stand vom Mount (leer). */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [alleBusy, setAlleBusy] = useState(false);
  const [ordnerFilter, setOrdnerFilter] = useState("");
  /** Live-Takt: zaehlt hoch, wenn das NAS seit dem letzten Check
   *  gepollt hat — haengt Baum/Suche/Panel als Dep dran. */
  const [datenTick, setDatenTick] = useState(0);
  const { confirm, ConfirmModalElement } = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  /** Keys, fuer die gerade ein KI-Vorschlag laeuft (synchroner Doppel-Guard). */
  const kiLaeuftRef = useRef<Set<string>>(new Set());

  // ── Seitenweiter Drag&Drop (Leo 2026-09-30) ───────────────────────
  // Vorher fing NUR der gestrichelte Knopf Drops ab: knapp daneben
  // losgelassen oeffnete der Browser die Datei bzw. der Drop verpuffte
  // still. Jetzt nimmt die ganze Seite Drops an, mit Hervorhebung der
  // Zone waehrend des Ziehens und Toast statt Stille bei Problemen.
  const [zieht, setZieht] = useState(false);
  /** Hover auf der Drop-Zone — state-driven (§3, CSS-hover ist hier unzuverlässig). */
  const [hoverZone, setHoverZone] = useState(false);
  const ziehtTiefe = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const dateienWaehlenRef = useRef<(f: File[] | FileList | null) => void>(() => {});
  useEffect(() => {
    // Grosszuegig erkennen: manche Browser/Quellen liefern beim
    // dragenter noch keine Typen — dann trotzdem als Datei-Drag werten
    // (nur eindeutige Text-/Link-Drags ignorieren).
    const istDateiDrag = (e: DragEvent) => {
      const t = Array.from(e.dataTransfer?.types ?? []);
      return t.length === 0 || t.includes("Files");
    };
    // Selbstheilung: bricht ein Drag ohne sauberes leave/drop ab
    // (ausserhalb des Fensters losgelassen), wuerde die Zone sonst fuer
    // immer rot haengen. Solange ein Drag laeuft, feuert dragover im
    // Sekundentakt — bleibt es >1.2s aus, ist der Drag vorbei.
    const letztesOver = { t: 0 };
    const enter = (e: DragEvent) => {
      if (!istDateiDrag(e)) return;
      ziehtTiefe.current++;
      letztesOver.t = Date.now();
      setZieht(true);
    };
    const leave = () => {
      ziehtTiefe.current = Math.max(0, ziehtTiefe.current - 1);
      if (ziehtTiefe.current === 0) setZieht(false);
    };
    const over = (e: DragEvent) => {
      e.preventDefault();
      letztesOver.t = Date.now();
    };
    const wache = setInterval(() => {
      if (ziehtTiefe.current > 0 && Date.now() - letztesOver.t > 1200) {
        ziehtTiefe.current = 0;
        setZieht(false);
      }
    }, 400);
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
      clearInterval(wache);
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
    const { data: ein } = await supabase
      .from("ablage_eingang")
      .select("id, name, mime_type, groesse, mail_von, mail_betreff, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    setEingang((ein ?? []) as EingangRow[]);
  }, [supabase]);

  useEffect(() => { if (ready && role === "admin") load(); }, [ready, role, load, datenTick]);

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
  }, [suche, ready, role, supabase, inaktivePfade, datenTick]);

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
  /** Effektiv aktive Ziele als Set — KI-Alternativen erscheinen nur, solange
   *  ihr Ordner noch waehlbar ist (inzwischen deaktiviert = kein Chip). */
  const waehlbareOrdner = useMemo(() => new Set(ordnerOptionen.map((o) => o.id)), [ordnerOptionen]);
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
  // Live-Takt (Leo 2026-10-02): hat das NAS seit dem letzten Check
  // gepollt, laden Baum/Dateien/Panel automatisch nach — kein F5 noetig.
  const letzterPollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || role !== "admin") return;
    let aktiv = true;
    const laden = async () => {
      const { data } = await supabase.from("ablage_sync_status").select("letzter_poll, intervall_s").eq("id", 1).maybeSingle();
      if (!aktiv) return;
      const st = (data as SyncStatus | null) ?? null;
      setSyncStatus(st);
      if (st && letzterPollRef.current && st.letzter_poll !== letzterPollRef.current) {
        setDatenTick((t) => t + 1);
      }
      if (st) letzterPollRef.current = st.letzter_poll;
    };
    laden();
    const t = setInterval(laden, 20_000);
    return () => { aktiv = false; clearInterval(t); };
  }, [ready, role, supabase]);

  // Lokale KI (SPEC 2.3): Status einmal beim Laden + alle 60 s. Der Ref
  // ist die synchrone Wahrheit fuer dateienWaehlen (kein Render noetig);
  // jede Stoerung (Route fehlt, Netz weg) zaehlt als offline — Fallback
  // statt Haengen.
  const [kiStatus, setKiStatus] = useState<KiStatus | null>(null);
  const kiStatusRef = useRef<KiStatus | null>(null);
  const ladeKiStatus = useCallback(async (): Promise<KiStatus> => {
    let st: KiStatus = { online: false, letzter_poll: null, modell: null, warteschlange: 0, arten: undefined };
    try {
      const res = await fetch("/api/ki/status", { cache: "no-store" });
      const json = res.ok ? await res.json().catch(() => null) : null;
      if (json && typeof json.online === "boolean") {
        st = {
          online: json.online,
          letzter_poll: typeof json.letzter_poll === "string" ? json.letzter_poll : null,
          modell: typeof json.modell === "string" && json.modell ? json.modell : null,
          warteschlange: Number(json.warteschlange) || 0,
          arten: leseKiArten(json.arten),
        };
      }
    } catch {
      // offline
    }
    kiStatusRef.current = st;
    setKiStatus(st);
    return st;
  }, []);
  useEffect(() => {
    if (!ready || role !== "admin") return;
    ladeKiStatus();
    const t = setInterval(ladeKiStatus, KI_STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [ready, role, ladeKiStatus]);
  // Faehigkeiten der lokalen KI (Rig-Masterplan MP-1): Inhaltssuche und
  // «Frag das Archiv» erscheinen nur, wenn das Rig online ist UND die Art
  // meldet — sonst bleibt die Seite wie bisher. Beides kommt aus derselben
  // Antwort von /api/ki/status (alle 60 s).
  const inhaltBereit = kiBereitFuer(kiStatus?.online, kiStatus?.arten, "nas_suche");
  const archivBereit = kiBereitFuer(kiStatus?.online, kiStatus?.arten, "archiv_frage");
  const archiv = useArchivFrage();
  // Frage an den Inhalt im Suchfeld → nach Tipp-Pause automatisch ans Archiv.
  useArchivAutoFrage(archiv, suche, archivBereit);
  /** Keys, fuer die gerade ein lokaler Lese-Auftrag laeuft — Entfernen
   *  der Karte oder «Selbst beschreiben» nimmt den Key raus, die Poll-
   *  Schleife bricht dann ab (verspaetete Ergebnisse werden ignoriert). */
  const lokalLaeuftRef = useRef<Set<string>>(new Set());
  /** Ein AbortController je Karte fuer die laufenden Fetches von
   *  lokalLesen(). Beim Unmount werden alle abgebrochen — sonst pollen
   *  die Schleifen nach dem Verlassen der Seite weiter. */
  const lokalAbortRef = useRef<Map<string, AbortController>>(new Map());
  /** Keys entfernter Karten — trifft die tmp_id eines Uploads erst nach dem
   *  Entfernen ein, verwirft lokalLesen() Objekt + Auftrag sofort (SPEC V5). */
  const entferntRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const laeuft = lokalLaeuftRef.current;
    const abbrecher = lokalAbortRef.current;
    return () => {
      laeuft.clear();
      for (const c of abbrecher.values()) c.abort();
      abbrecher.clear();
      // Seite verlassen, ohne abzulegen: Tmp-Objekte und Lese-Auftraege der
      // Karten sofort verwerfen (SPEC V5) statt bis zu 24 h liegen lassen.
      // keepalive: der Request ueberlebt den Abbau der Seite; Fehler still —
      // hier sieht niemand mehr einen Toast, das Housekeeping raeumt nach.
      // Nicht fuer Karten, die gerade abgelegt werden (laedt) oder abgelegt
      // sind (fertig): ihr Objekt wird bzw. wurde nach items/ verschoben.
      for (const p of pendingRef.current) {
        if (!p.tmpId || p.status === "laedt" || p.status === "fertig") continue;
        void fetch(`/api/ablage/ki-upload?tmp_id=${encodeURIComponent(p.tmpId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    };
  }, []);

  /** Hover-Zeile in den Dokument-Listen (state-driven, §3). */
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  /** Vergroesserte Vorschau (Hover): Bild + Bildschirm-Position des
   *  Thumbs. Gerendert per Portal in document.body mit position:fixed —
   *  sonst schneidet der Karten-Rand (overflow) die Vorschau ab. */
  const [thumbGross, setThumbGross] = useState<{ key: string; src: string; top: number; left: number } | null>(null);

  // ── Versions-Muell-Finder (Leo 2026-10-02, on demand) ─────────────
  // Erkennt Familien wie name_v2 / name_final / name (3) im selben
  // Ordner (>= 3 Stueck) — Aktion: alles ausser der neuesten Version
  // in den Papierkorb.
  const [aufraeumGruppen, setAufraeumGruppen] = useState<
    { key: string; kern: string; ordner: string; dateien: { pfad: string; name: string; geaendert: string | null }[] }[] | null
  >(null);
  const [aufraeumLaedt, setAufraeumLaedt] = useState(false);

  async function bestandAnalysieren() {
    setAufraeumLaedt(true);
    const { data, error } = await supabase
      .from("ablage_datei_index")
      .select("pfad, ordner_pfad, name, geaendert")
      .limit(5000);
    setAufraeumLaedt(false);
    if (error) {
      toast.error("Analyse fehlgeschlagen: " + error.message);
      return;
    }
    // BEWUSST nur EINE Strip-Runde: iteratives Strippen kettet sonst
    // Datumsteile ab (Rapport_2026-04-10-2 -> ... -> "rapport_2026")
    // und wirft UNTERSCHIEDLICHE Dokumente in eine Familie.
    const kernName = (name: string): string => {
      const k = name.toLowerCase().normalize("NFC").replace(/\.[a-z0-9]{1,8}$/i, "");
      return k
        .replace(/\s*\(\d+\)$/, "")
        .replace(/[\s_-]+(v?\d{1,3}|final|kopie|copy|neu|alt|old)$/i, "")
        .trim();
    };
    const gruppen = new Map<string, { kern: string; ordner: string; dateien: { pfad: string; name: string; geaendert: string | null }[] }>();
    for (const row of (data ?? []) as { pfad: string; ordner_pfad: string; name: string; geaendert: string | null }[]) {
      const kern = kernName(row.name);
      if (kern.length < 3) continue;
      const key = `${row.ordner_pfad}::${kern}`;
      if (!gruppen.has(key)) gruppen.set(key, { kern, ordner: row.ordner_pfad, dateien: [] });
      gruppen.get(key)!.dateien.push({ pfad: row.pfad, name: row.name, geaendert: row.geaendert });
    }
    const liste = [...gruppen.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .filter((g) => g.dateien.length >= 3)
      .sort((a, b) => b.dateien.length - a.dateien.length)
      .slice(0, 10); // tz-ok Array: die zehn groessten Gruppen, kein Datum
    setAufraeumGruppen(liste);
    if (liste.length === 0) toast.info("Nichts Auffälliges gefunden — der Bestand sieht sauber aus.");
  }

  async function gruppeAufraeumen(g: { key: string; kern: string; dateien: { pfad: string; name: string; geaendert: string | null }[] }) {
    const sortiert = [...g.dateien].sort((a, b) => (b.geaendert ?? "").localeCompare(a.geaendert ?? ""));
    const behalten = sortiert[0];
    const weg = sortiert.slice(1);
    const ok = await confirm({
      title: `${weg.length} ältere Versionen in den Papierkorb?`,
      message:
        `Behalten wird die neueste: «${behalten.name}».\n\nIn den Papierkorb wandern:\n` +
        weg.slice(0, 12).map((d) => `• ${d.name}`).join("\n") +
        (weg.length > 12 ? `\n… und ${weg.length - 12} weitere` : "") +
        `\n\nBitte kurz prüfen, dass das wirklich Versionen DESSELBEN Dokuments sind.`,
      confirmLabel: "In Papierkorb",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("ablage_moves")
      .insert(weg.map((d) => ({ pfad: d.pfad, ziel_ordner: PAPIERKORB })));
    if (error) {
      toast.error("Aufräumen fehlgeschlagen: " + error.message);
      return;
    }
    setVerschiebend((prev) => {
      const next = new Set(prev);
      for (const d of weg) next.add(d.pfad);
      return next;
    });
    setAufraeumGruppen((prev) => (prev ?? []).filter((x) => x.key !== g.key));
    toast.success(`${weg.length} Dateien werden beim nächsten Sync in den Papierkorb verschoben`);
  }

  // ── Verschieben & Papierkorb (Leo 2026-10-02) ─────────────────────
  // Verschiebe-Auftrag (ablage_moves) — der Sync-Client macht mkdir -p
  // + rename (nie ueberschreiben). Papierkorb = 99_System/Papierkorb
  // (liegt im Scan-Ausschluss: taucht nie in Auswahl/Suche auf).
  const PAPIERKORB = "99_System/Papierkorb";
  const [moveFuer, setMoveFuer] = useState<string | null>(null);
  const [verschiebend, setVerschiebend] = useState<Set<string>>(new Set());
  async function dateiVerschieben(pfad: string, zielOrdner: string) {
    setMoveFuer(null);
    const { error } = await supabase.from("ablage_moves").insert({ pfad, ziel_ordner: zielOrdner });
    if (error) {
      toast.error("Verschieben fehlgeschlagen: " + error.message);
      return;
    }
    setVerschiebend((prev) => new Set(prev).add(pfad));
    toast.success(
      zielOrdner === PAPIERKORB
        ? "Wird beim nächsten Sync in den Papierkorb verschoben"
        : `Wird beim nächsten Sync nach «${zielOrdner}» verschoben`,
    );
  }
  async function dateiInPapierkorb(pfad: string, name: string) {
    const ok = await confirm({
      title: "In den Papierkorb verschieben?",
      message: `«${name}» wird auf dem NAS nach ${PAPIERKORB} verschoben (dort manuell wiederherstellbar).`,
      confirmLabel: "In Papierkorb",
    });
    if (!ok) return;
    await dateiVerschieben(pfad, PAPIERKORB);
  }

  // ── Datei-Abruf vom NAS (Leo 2026-09-30) ──────────────────────────
  // Klick auf ein Dokument: holeNasDatei (ki-hilfen.ts) legt die Abruf-
  // Zeile an, der Sync-Client laedt die Datei in den Uebergabe-Bucket,
  // dann kommt sie als Blob zurueck und wird SELBST benannt — der Name aus
  // der signierten URL kaeme URL-kodiert an (%5B, %CC%88 bei Mac-
  // Umlauten). Housekeeping raeumt den Bucket nach 1h.
  const [abrufLaeuft, setAbrufLaeuft] = useState<Record<string, boolean>>({});
  async function dateiAbrufen(pfad: string) {
    if (abrufLaeuft[pfad]) return;
    setAbrufLaeuft((p) => ({ ...p, [pfad]: true }));
    try {
      const { blob, name } = await holeNasDatei(supabase, pfad, {
        onGestartet: () => toast.info("Wird vom NAS geholt — kann bis zu einer Minute dauern…"),
      });
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = name || "dokument";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 10_000);
      toast.success("Download gestartet", { description: a.download });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Abruf fehlgeschlagen");
    } finally {
      setAbrufLaeuft((p) => { const n = { ...p }; delete n[pfad]; return n; });
    }
  }

  // Dateien des ausgewaehlten Ordners aus dem Datei-Index laden.
  const [paneDateien, setPaneDateien] = useState<{ name: string; groesse: number | null; geaendert: string | null }[] | null>(null);
  const [paneLaedt, setPaneLaedt] = useState(false);
  const paneAuswahlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!auswahl || !ready || role !== "admin") return;
    let aktiv = true;
    // Shimmer nur beim Ordner-Wechsel — der Live-Takt laedt still nach.
    if (paneAuswahlRef.current !== auswahl) setPaneLaedt(true);
    paneAuswahlRef.current = auswahl;
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
  }, [auswahl, ready, role, supabase, datenTick]);

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

  // ── Smarte Ordner-Vorschläge (Leo 2026-10-02) ─────────────────────
  // Deterministisch aus der Struktur berechnet (lib/ordner-vorschlaege);
  // ignorierte Vorschläge überleben den Reload (localStorage).
  const [vorschlaegeIgnoriert, setVorschlaegeIgnoriert] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem("nas-ordner-vorschlaege-ignoriert") ?? "[]")); } catch { return new Set(); }
  });
  const [vorschlagBusy, setVorschlagBusy] = useState<string | null>(null);
  const ordnerVorschlaege = useMemo(() => {
    if (!ordner || ordner.length === 0) return [];
    const jahr = parseInt(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" }).slice(0, 4), 10);
    return berechneOrdnerVorschlaege(ordner, jahr).filter((v) => !vorschlaegeIgnoriert.has(v.id));
  }, [ordner, vorschlaegeIgnoriert]);

  // KI-Plausibilitaetspruefung der Kandidaten (Leo 2026-10-02): die
  // Regel-Engine findet, die KI beurteilt anhand der Nachbarstruktur —
  // sie darf streichen oder Teilmengen behalten, nie ergaenzen.
  // Ergebnis wird je Kandidaten-Satz gecacht (localStorage).
  const [pruefung, setPruefung] = useState<{ key: string; map: Record<string, { pfade: string[]; grund: string }> } | null>(null);
  const [pruefungLaeuft, setPruefungLaeuft] = useState(false);
  const pruefungFehlerRef = useRef<string | null>(null);
  const pruefKey = ordnerVorschlaege.map((v) => `${v.id}:${v.neuePfade.length}`).join("|");
  useEffect(() => {
    if (!ready || role !== "admin" || ordnerVorschlaege.length === 0) return;
    if (pruefung?.key === pruefKey || pruefungFehlerRef.current === pruefKey) return;
    try {
      const cached = localStorage.getItem(`nas-vorschlaege-pruefung:${pruefKey}`);
      if (cached) {
        setPruefung({ key: pruefKey, map: JSON.parse(cached) });
        return;
      }
    } catch { /* egal */ }
    let aktiv = true;
    setPruefungLaeuft(true);
    fetch("/api/ablage/vorschlaege-pruefen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vorschlaege: ordnerVorschlaege }),
    })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!aktiv) return;
        setPruefungLaeuft(false);
        if (!res.ok || !json?.success) {
          // Fallback: ungeprueft anzeigen statt blockieren.
          pruefungFehlerRef.current = pruefKey;
          return;
        }
        const map: Record<string, { pfade: string[]; grund: string }> = {};
        for (const b of json.bewertungen ?? []) map[b.id] = { pfade: b.behalten_pfade, grund: b.grund };
        setPruefung({ key: pruefKey, map });
        try { localStorage.setItem(`nas-vorschlaege-pruefung:${pruefKey}`, JSON.stringify(map)); } catch { /* egal */ }
      })
      .catch(() => {
        if (!aktiv) return;
        setPruefungLaeuft(false);
        pruefungFehlerRef.current = pruefKey;
      });
    return () => { aktiv = false; };
  }, [ready, role, pruefKey, ordnerVorschlaege, pruefung]);

  /** Angezeigte Vorschlaege = Kandidaten nach KI-Pruefung (Fallback: alle). */
  const geprueft = pruefung?.key === pruefKey ? pruefung.map : null;
  const angezeigteVorschlaege = ordnerVorschlaege
    .map((v) => {
      const b = geprueft?.[v.id];
      const pfade = b ? b.pfade : v.neuePfade;
      let titel = v.titel;
      // Hat die KI reduziert, muss der Titel die gefilterte Anzahl
      // nennen — nicht die der Regel-Engine (Leo 2026-10-02).
      if (b && pfade.length !== v.neuePfade.length) {
        const n = pfade.length;
        const neu = titel
          .replace(/bei den übrigen \d+ anlegen\?$/, `bei ${n === 1 ? "einem" : n} davon anlegen?`)
          .replace(/fehlt bei \d+ von (\d+) Ordnern/, `fehlt bei ${n} von $1 Ordnern`);
        titel = neu !== titel ? neu : `${titel.replace(/\?$/, "")} — laut KI nur bei ${n} davon sinnvoll:`;
      }
      return { ...v, titel, neuePfade: pfade, grund: b?.grund ?? "" };
    })
    .filter((v) => v.neuePfade.length > 0);

  function vorschlagIgnorieren(id: string) {
    setVorschlaegeIgnoriert((prev) => {
      const next = new Set(prev).add(id);
      try { localStorage.setItem("nas-ordner-vorschlaege-ignoriert", JSON.stringify([...next])); } catch { /* egal */ }
      return next;
    });
  }

  async function vorschlagAnlegen(v: { id: string; neuePfade: string[] }) {
    if (vorschlagBusy) return;
    setVorschlagBusy(v.id);
    const { error } = await supabase
      .from("ablage_ordner")
      .insert(v.neuePfade.map((pfad) => ({ pfad, aktiv: true, nas_ausstehend: true })));
    setVorschlagBusy(null);
    if (error) {
      toast.error("Anlegen fehlgeschlagen: " + error.message);
      return;
    }
    toast.success(`${v.neuePfade.length} Ordner angelegt — werden beim nächsten Sync auf dem NAS erstellt`);
    load();
  }
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
    if (!neuName.trim() || neuBusy || neuParent === null) return;
    // Gleiche Regeln wie beim neuen Ordner aus einem Claude-Vorschlag (lib/ki/pfade).
    const name = leseOrdnerName(neuName);
    if (!name) {
      toast.error("Ungültiger Ordnername — keine Zeichen wie / \\ : * ? \" < > | und nicht mit @ . # beginnen");
      return;
    }
    const pfad = neuParent ? `${neuParent}/${name}` : name;
    // 99_System ist der Systembereich des NAS (Papierkorb, Sync-Interna).
    if (istSystemPfad(pfad)) {
      toast.error("99_System ist für das System reserviert — anderen Namen wählen");
      return;
    }
    // Vergleich in NFC: «Münsterplatz» vom Mac (zerlegte Umlaute) und von
    // Windows ist derselbe Ordner — sonst entsteht auf dem NAS ein Zwilling.
    const pfadNfc = pfad.normalize("NFC");
    if ((ordner ?? []).some((o) => o.pfad.normalize("NFC") === pfadNfc)) {
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
    const neue = liste.map((f, i) => ({
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
      frist: "",
      ordner: defaultOrdner,
      phase: "beschreiben" as const,
      fokus: true,
      status: "offen" as const,
    }));
    if (fileRef.current) fileRef.current.value = "";
    pendingHinzufuegen(neue);
  }
  dateienWaehlenRef.current = dateienWaehlen;

  /** Gemeinsamer Einstieg fuer Datei-Wahl, Drop und Mail-Eingang: Karten
   *  anlegen, Mini-Vorschau nachliefern und sofort die lokale KI lesen
   *  lassen (SPEC 2.3 UI). */
  function pendingHinzufuegen(neue: PendingFile[]) {
    setPending((prev) => [...prev, ...neue]);
    for (const n of neue) {
      // Mini-Vorschau asynchron nachliefern (Icon-Fallback bis dahin).
      erzeugeThumb(n.file).then((t) => {
        if (t) setPending((prev) => prev.map((x) => (x.key === n.key ? { ...x, thumb: t } : x)));
      });
      lokalLesen(n.key, n.file);
    }
  }

  // ── Mail-Eingang uebernehmen/verwerfen (Leo 2026-10-02) ──────────
  const [eingangBusy, setEingangBusy] = useState<string | null>(null);
  async function eingangUebernehmen(e: EingangRow) {
    if (eingangBusy) return;
    setEingangBusy(e.id);
    try {
      const res = await fetch(`/api/ablage/eingang/${e.id}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Übernahme fehlgeschlagen");
        return;
      }
      const dl = await fetch(json.url);
      if (!dl.ok) {
        toast.error("Datei konnte nicht geladen werden");
        return;
      }
      const blob = await dl.blob();
      const file = new File([blob], e.name, { type: e.mime_type ?? blob.type });
      const key = `${Date.now()}_mail_${e.id}`;
      const neu: PendingFile = {
        key, file,
        kiText: e.mail_betreff ?? "",
        antwort: "",
        typ: "sonstiges", betreff: "", person: "", partei: "", nummer: "",
        dokDatum: "", frist: "", ordner: letzteOrdner[0] ?? "",
        phase: "beschreiben", fokus: true, status: "offen",
      };
      pendingHinzufuegen([neu]);
      await fetch(`/api/ablage/eingang/${e.id}`, { method: "DELETE" });
      setEingang((prev) => prev.filter((x) => x.id !== e.id));
    } catch {
      toast.error("Übernahme fehlgeschlagen — Netzwerkfehler");
    } finally {
      setEingangBusy(null);
    }
  }
  async function eingangVerwerfen(e: EingangRow) {
    const ok = await confirm({
      title: "Mail-Anhang verwerfen?",
      message: `«${e.name}» wird endgültig gelöscht.`,
      confirmLabel: "Verwerfen",
    });
    if (!ok) return;
    const res = await fetch(`/api/ablage/eingang/${e.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Verwerfen fehlgeschlagen");
      return;
    }
    setEingang((prev) => prev.filter((x) => x.id !== e.id));
  }

  /** Pending-Karte entfernen inkl. Freigabe der Vorschau-URL. Die
   *  Poll-Schleife eines laufenden Lese-Auftrags endet; liegt die Datei
   *  schon als Tmp-Objekt im Bucket, raeumt kiUploadVerwerfen() Objekt und
   *  Auftrag sofort weg (SPEC V5). Laeuft lokalLesen() fuer die Karte noch
   *  (die tmp_id kann dann erst unterwegs sein), uebernimmt das dessen
   *  finally — genau ein DELETE. Die Karte verschwindet in jedem Fall. */
  function entfernePending(key: string) {
    lokalLaeuftRef.current.delete(key);
    entferntRef.current.add(key);
    const tmpId = pending.find((x) => x.key === key)?.tmpId;
    if (tmpId && !lokalAbortRef.current.has(key)) void kiUploadVerwerfen(tmpId);
    setPending((prev) => {
      const z = prev.find((x) => x.key === key);
      if (z?.thumb?.startsWith("blob:")) URL.revokeObjectURL(z.thumb);
      return prev.filter((x) => x.key !== key);
    });
  }

  /** DELETE /api/ablage/ki-upload?tmp_id= — Tmp-Objekt und Lese-Auftrag der
   *  lokalen KI verwerfen (SPEC V5). Schlaegt es fehl, raeumt das
   *  Housekeeping das Objekt spaetestens nach 24 h weg. */
  async function kiUploadVerwerfen(tmpId: string) {
    try {
      const res = await fetch(`/api/ablage/ki-upload?tmp_id=${encodeURIComponent(tmpId)}`, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success === true) return;
    } catch {
      // Netzwerkfehler — gleicher Hinweis wie bei einer Server-Absage.
    }
    toast.error("Zwischenkopie konnte nicht gelöscht werden — sie wird spätestens nach 24 h automatisch entfernt");
  }

  function updatePending(key: string, patch: Partial<PendingFile>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  /** Zielordner wechseln — EIN Weg fuer Auswahlfelder, Ordner-Chips und
   *  «Anlegen & verwenden», damit alles Abhaengige mitzieht: Duplikat-Funde
   *  galten dem alten Ziel (die Pruefung beim Ablegen haengt am Zielordner)
   *  und fallen weg — «Trotzdem ablegen» geht so nie ungeprueft ins neue
   *  Ziel. Ist das neue Ziel eine KI-Alternative, rueckt das bisherige an
   *  ihre Stelle (Zurueckwechseln mit einem Klick); ohne bisheriges Ziel
   *  faellt sie aus der Liste. Namensvorschau und Pflicht-Pruefung lesen
   *  den Ordner ohnehin frisch aus der Karte. */
  function zielordnerSetzen(key: string, neu: string, patch: Partial<PendingFile> = {}) {
    setPending((prev) =>
      prev.map((x) => {
        if (x.key !== key) return x;
        if (neu === x.ordner) return { ...x, ...patch };
        const alt = x.ordnerAlternativen ?? [];
        const i = alt.indexOf(neu);
        const ordnerAlternativen =
          i < 0
            ? x.ordnerAlternativen
            : x.ordner && !alt.includes(x.ordner)
              ? alt.map((a, j) => (j === i ? x.ordner : a))
              : alt.filter((_, j) => j !== i);
        // Anderer Ordner = nicht mehr der der KI: Herkunfts-Chip und
        // Unsicher-Hinweis fallen weg.
        return {
          ...x,
          ...patch,
          ordner: neu,
          ordnerAlternativen,
          duplikatFunde: undefined,
          ordnerQuelle: undefined,
          ordnerSicherheit: undefined,
          ordnerBegruendung: undefined,
        };
      }),
    );
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
        // Fallback: ohne KI weiter — Pruefen-Schritt mit offenen Feldern,
        // damit niemand im Beschreiben-Schritt stecken bleibt.
        updatePending(p.key, { kiLaeuft: false, phase: "pruefen", anpassen: true });
        toast.error(json?.error ?? "KI-Vorschlag fehlgeschlagen — Felder bitte selbst ausfüllen");
        return;
      }
      const v = json.vorschlag as { typ: string; betreff: string; person: string; partei: string; nummer: string; dok_datum: string; frist?: string; ordner?: string; neuer_ordner?: string; fragen?: string[] };
      kiLaeuftRef.current.delete(p.key);
      // Nur nicht-leere Vorschlaege uebernehmen; laufende Uploads nie anfassen.
      setPending((prev) =>
        prev.map((x) =>
          x.key === p.key && (x.status === "offen" || x.status === "fehler")
            ? {
                ...x,
                kiLaeuft: false,
                phase: "pruefen",
                // Vorschlag kommt jetzt von Claude (nur Text) — Chip weg,
                // ebenso die Ordner-Alternativen der lokalen KI und die
                // Herkunft des Zielordners (V8).
                lokalGelesen: false,
                ordnerAlternativen: undefined,
                ordnerQuelle: undefined,
                ordnerSicherheit: undefined,
                ordnerBegruendung: undefined,
                kiVorschlag: kiVorschlagKarte("beschrieb", v),
                typ: v.typ || x.typ,
                betreff: v.betreff || x.betreff,
                // Person nur uebernehmen, wenn der (neue) Typ sie kennt.
                person: dokTyp(v.typ || x.typ)?.person ? (v.person || x.person) : "",
                partei: v.partei || x.partei,
                nummer: v.nummer || x.nummer,
                dokDatum: v.dok_datum || x.dokDatum,
                frist: v.frist || x.frist,
                ordner: v.ordner || x.ordner,
                neuerOrdner: v.ordner || x.ordner ? undefined : (v.neuer_ordner || x.neuerOrdner),
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

  /** KI-vorgeschlagenen NEUEN Ordner anlegen (nas_ausstehend) und als
   *  Ziel setzen — der Datei-Sync erstellt ihn ohnehin per mkdir -p. */
  async function neuenOrdnerVerwenden(p: PendingFile) {
    const pfad = p.neuerOrdner;
    if (!pfad) return;
    const existiert = (ordner ?? []).some((o) => o.pfad === pfad);
    if (!existiert) {
      const { error } = await supabase.from("ablage_ordner").insert({ pfad, aktiv: true, nas_ausstehend: true });
      if (error && !error.message.includes("duplicate")) {
        toast.error("Ordner konnte nicht angelegt werden: " + error.message);
        return;
      }
      toast.success(`«${pfad}» angelegt — wird beim nächsten Sync auf dem NAS erstellt`);
      load();
    }
    zielordnerSetzen(p.key, pfad, { neuerOrdner: undefined });
  }

  /** Antwort auf die KI-Rueckfragen in den Beschrieb mergen + neu analysieren. */
  function fragenBeantworten(p: PendingFile) {
    const antwort = p.antwort.trim();
    if (!antwort) return;
    const neu = `${p.kiText.trim()}; ${antwort}`;
    updatePending(p.key, { kiText: neu, antwort: "" });
    kiVorschlag(p, neu);
  }

  // ── Lokale KI liest das Dokument (SPEC 2.3 UI / 3.1) ──────────────
  /** Datei sofort nach `ki-tmp/` hochladen, Auftrag `ablage_analyse`
   *  anlegen und alle 1,5 s nachfragen (max KI_TIMEOUT_ABLAGE_MS). Jede
   *  Stoerung — offline, Fehler, Zeitueberschreitung — fuehrt in den
   *  bisherigen Weg (Beschrieb tippen, Claude nur mit dem Text); nie
   *  blockieren. Echte Fehler stehen als Hinweis in der Karte; «nicht
   *  erreichbar» zeigt nur die Offline-Zeile ueber der Liste (Chip und
   *  Zeile ziehen per ladeKiStatus() sofort mit, nicht erst nach 60 s). */
  async function lokalLesen(key: string, file: File) {
    const ctrl = new AbortController();
    /** Automatischer Rueckfall in «beschreiben»: ohne Fokus-Klau
     *  (fokus: false); nach einem Abort (Unmount) kein State mehr. */
    const fallback = (hinweis?: string) => {
      lokalLaeuftRef.current.delete(key);
      if (ctrl.signal.aborted) return;
      setPending((prev) =>
        prev.map((x) =>
          x.key === key && x.phase === "lesen"
            ? { ...x, phase: "beschreiben", fokus: false, lokalStatus: undefined, lokalSeit: undefined, lokalHinweis: hinweis }
            : x,
        ),
      );
    };
    /** Rueckfall wegen Offline/Stoerung/Auftrag-Fehler: zusaetzlich den
     *  Status sofort nachladen, damit der Kopf-Chip mitzieht. */
    const stoerung = (hinweis?: string) => {
      fallback(hinweis);
      if (!ctrl.signal.aborted) void ladeKiStatus();
    };
    // Abbrecher schon VOR dem ersten await registrieren — sonst greift der
    // Unmount-Cleanup nicht, solange der Status noch laedt.
    lokalAbortRef.current.set(key, ctrl);
    const st = kiStatusRef.current ?? (await ladeKiStatus());
    // Offline: Karte bleibt im Beschreiben-Schritt (Fokus wie bisher),
    // die Offline-Zeile ueber der Liste erklaert es — einmal, nicht pro Karte.
    // Karte waehrend der Status-Abfrage entfernt: gar nicht erst hochladen.
    if (ctrl.signal.aborted || !st.online || entferntRef.current.has(key)) {
      if (lokalAbortRef.current.get(key) === ctrl) lokalAbortRef.current.delete(key);
      return;
    }
    lokalLaeuftRef.current.add(key);
    updatePending(key, { phase: "lesen", lokalStatus: "wartet", lokalSeit: Date.now(), lokalHinweis: undefined });
    /** tmp_id dieses Laufs — fuer das DELETE im finally, falls die Karte
     *  entfernt wird, solange lokalLesen() laeuft (SPEC V5). */
    let tmpIdLauf: string | undefined;
    try {
      let auftragId: string;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/ablage/ki-upload", { method: "POST", body: fd, signal: ctrl.signal });
        const json = await res.json().catch(() => null);
        if (!res.ok || typeof json?.auftrag_id !== "string" || typeof json?.tmp_id !== "string") {
          // fallback() greift nur in Phase «lesen» — nach «Selbst
          // beschreiben» oder Entfernen passiert hier nichts mehr.
          // 503/offline = generisch (Offline-Zeile), sonst Server-Meldung.
          if (res.status === 503 || json?.offline === true) stoerung();
          else fallback(typeof json?.error === "string" ? json.error : "Übergabe an die lokale KI fehlgeschlagen — Beschrieb eingeben");
          return;
        }
        auftragId = json.auftrag_id;
        // tmp_id bleibt auch nach Abbruch/Fehler/Timeout stehen: das Objekt
        // liegt vollstaendig im Bucket, ablegen() verschiebt es (kein 2. Upload).
        tmpIdLauf = json.tmp_id;
        updatePending(key, { auftragId, tmpId: json.tmp_id });
        if (!lokalLaeuftRef.current.has(key)) return;
      } catch {
        // Netz weg oder Abort — nach Abort setzt stoerung() nichts mehr.
        // Mit Hinweis in der Karte: meldet der Status danach «online», waere
        // der Rueckfall sonst unerklaert.
        stoerung("Übergabe an die lokale KI fehlgeschlagen — Beschrieb eingeben");
        return;
      }
      const start = Date.now();
      let fehlschlaege = 0;
      while (Date.now() - start < KI_TIMEOUT_ABLAGE_MS) {
        await new Promise((r) => setTimeout(r, KI_AUFTRAG_POLL_MS));
        if (!lokalLaeuftRef.current.has(key)) return;
        try {
          const res = await fetch(`/api/ki/auftrag/${auftragId}`, { cache: "no-store", signal: ctrl.signal });
          const json = await res.json().catch(() => null);
          if (!lokalLaeuftRef.current.has(key)) return;
          if (!res.ok || typeof json?.status !== "string") {
            // Einzelne Aussetzer tolerieren, dauerhaft (Route weg, 403) nicht.
            if (++fehlschlaege >= 3) { stoerung("Verbindung zur lokalen KI abgebrochen — Beschrieb eingeben"); return; }
            continue;
          }
          fehlschlaege = 0;
          if (json.status === "fertig") {
            ergebnisUebernehmen(key, (json.ergebnis ?? {}) as KiAblageErgebnis);
            return;
          }
          if (json.status === "fehler") {
            stoerung("Lokale KI konnte das Dokument nicht lesen — Beschrieb eingeben");
            return;
          }
          updatePending(key, { lokalStatus: json.status === "laeuft" ? "liest" : "wartet" });
        } catch {
          if (ctrl.signal.aborted) return;
          if (++fehlschlaege >= 3) { stoerung("Verbindung zur lokalen KI abgebrochen — Beschrieb eingeben"); return; }
        }
      }
      fallback("Lokale KI antwortet nicht (Zeitüberschreitung) — Beschrieb eingeben");
    } finally {
      if (lokalAbortRef.current.get(key) === ctrl) lokalAbortRef.current.delete(key);
      // Karte inzwischen entfernt: Tmp-Objekt + Auftrag sofort verwerfen.
      if (tmpIdLauf && entferntRef.current.has(key)) void kiUploadVerwerfen(tmpIdLauf);
    }
  }

  /** «Selbst beschreiben» waehrend die lokale KI liest: Poll-Schleife
   *  stoppen, Karte in den Beschreiben-Schritt (tmp_id bleibt). Bewusste
   *  Nutzeraktion -> Beschrieb-Feld bekommt den Fokus. */
  function lokalAbbrechen(key: string) {
    lokalLaeuftRef.current.delete(key);
    updatePending(key, { phase: "beschreiben", fokus: true, lokalStatus: undefined, lokalSeit: undefined });
  }

  /** Ergebnis der lokalen KI (SPEC 3.1) in die Karte — direkt in den
   *  Pruefen-Schritt (Zusammenfassung mit «Anpassen» wie beim Claude-Weg).
   *  Uebernahme-Regeln identisch zu kiVorschlag(): nur gefuellte Werte,
   *  Person nur wenn der Typ sie kennt, laufende Uploads nie anfassen. */
  function ergebnisUebernehmen(key: string, e: KiAblageErgebnis) {
    lokalLaeuftRef.current.delete(key);
    const s = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "");
    setPending((prev) =>
      prev.map((x) => {
        if (x.key !== key || x.phase !== "lesen" || !(x.status === "offen" || x.status === "fehler")) return x;
        const typ = dokTyp(s(e.typ)) ? s(e.typ) : x.typ;
        const alternativenRoh = (Array.isArray(e.ordner_alternativen) ? e.ordner_alternativen : []).map((a) => s(a)).filter(Boolean);
        // Hat die KI bewusst KEINEN Hauptordner gewaehlt, aber Vorschlaege
        // (Alternativen oder neuer Ordner), bleibt das Ziel leer: der zuletzt
        // verwendete Ordner wuerde sonst still als Hauptziel erscheinen.
        // Ohne jeden Vorschlag (z. B. Foto ohne Text) wie bisher der zuletzt
        // verwendete Ordner — praktisch bei Serien gleicher Dokumente.
        const ordner = s(e.ordner) || (alternativenRoh.length > 0 || s(e.neuer_ordner) ? "" : x.ordner);
        // Naechstbeste Ziele: ohne das aktuelle Ziel, ohne Doppel, max 2 —
        // fehlt das Feld (aelterer Dienst), bleibt alles wie bisher.
        const ordnerAlternativen = alternativenRoh
          .filter((a, i, liste) => a !== ordner && liste.indexOf(a) === i)
          .slice(0, 2);
        // V8: Herkunft nur, wenn der Ordner wirklich vom Server kommt (nicht
        // der still uebernommene zuletzt verwendete Ordner).
        const quelle = e.ordner_quelle === "regel" || e.ordner_quelle === "lokal" || e.ordner_quelle === "claude" ? e.ordner_quelle : undefined;
        const ordnerQuelle = s(e.ordner) ? quelle : undefined;
        const sicherheit = e.ordner_sicherheit === "hoch" || e.ordner_sicherheit === "mittel" || e.ordner_sicherheit === "niedrig" ? e.ordner_sicherheit : undefined;
        return {
          ...x,
          phase: "pruefen",
          lokalStatus: undefined,
          lokalSeit: undefined,
          lokalHinweis: undefined,
          lokalGelesen: true,
          // Beschrieb der KI als Text-Basis fuer «Neu analysieren» (Claude-Weg).
          kiText: s(e.beschrieb) || x.kiText,
          kiGelaufen: true,
          typ,
          betreff: s(e.betreff) || x.betreff,
          person: dokTyp(typ)?.person ? (s(e.person) || x.person) : "",
          partei: s(e.partei) || x.partei,
          nummer: s(e.nummer) || x.nummer,
          dokDatum: s(e.dok_datum) || x.dokDatum,
          frist: s(e.frist) || x.frist,
          ordner,
          ordnerAlternativen,
          ordnerQuelle,
          ordnerSicherheit: ordnerQuelle === "claude" ? sicherheit : undefined,
          ordnerBegruendung: ordnerQuelle && s(e.ordner_begruendung) ? s(e.ordner_begruendung) : undefined,
          // Vorschlag der KI selbst (nicht der still übernommene zuletzt verwendete Ordner); ohne V8-Felder = lokal.
          kiVorschlag: kiVorschlagKarte(quelle ?? "lokal", e),
          neuerOrdner: ordner ? undefined : (s(e.neuer_ordner) || x.neuerOrdner),
          rigDoppel: leseAblageDoppel(e.doppel) ?? undefined,
          fragen: [],
          antwort: "",
        };
      }),
    );
  }

  async function ablegen(p: PendingFile, force = false): Promise<boolean> {
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
    updatePending(p.key, { status: "laedt", fehler: undefined, duplikatFunde: undefined });
    try {
      // Liegt die Datei schon als Tmp-Objekt im Bucket (lokale KI), geht
      // nur `tmp_id` mit — der Server verschiebt das Objekt (SPEC 2.3).
      // Ist es dort nicht mehr (Housekeeping; Server: 404 und/oder
      // {tmp_fehlt:true}), genau einmal mit der Datei (force bleibt).
      const sende = async (mitTmp: boolean) => {
        const fd = new FormData();
        if (mitTmp && p.tmpId) fd.append("tmp_id", p.tmpId);
        else fd.append("file", p.file);
        fd.append("typ", p.typ);
        fd.append("betreff", p.betreff.trim());
        fd.append("person", p.person.trim());
        fd.append("partei", p.partei.trim());
        fd.append("nummer", p.nummer.trim());
        fd.append("dok_datum", p.dokDatum);
        fd.append("frist", p.frist);
        fd.append("ordner", p.ordner);
        if (p.kiVorschlag) fd.append("ki_vorschlag", JSON.stringify(p.kiVorschlag));
        if (force) fd.append("force", "1");
        const res = await fetch("/api/ablage/upload", { method: "POST", body: fd });
        const json = await res.json().catch(() => null);
        return { res, json };
      };
      let { res, json } = await sende(true);
      if ((res.status === 404 || json?.tmp_fehlt === true) && p.tmpId) {
        if (!p.file) {
          updatePending(p.key, { tmpId: undefined, status: "fehler", fehler: "Datei bitte erneut auswählen" });
          return false;
        }
        updatePending(p.key, { tmpId: undefined });
        ({ res, json } = await sende(false));
      }
      if (res.status === 409 && json?.duplikat) {
        // Moegliches Duplikat: amber Box mit den Funden, "Trotzdem
        // ablegen" wiederholt mit force — nie blockierend.
        updatePending(p.key, { status: "offen", duplikatFunde: json.funde ?? [] });
        return false;
      }
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

  /** Ablegbar = offen/fehler und nicht gerade bei der lokalen KI. */
  const istAblegbar = (p: PendingFile) => (p.status === "offen" || p.status === "fehler") && p.phase !== "lesen";

  async function alleAblegen() {
    const offen = pending.filter(istAblegbar);
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
      setTimeout(() => setPending((prev) => {
        for (const x of prev) {
          if (x.status === "fertig" && x.thumb?.startsWith("blob:")) URL.revokeObjectURL(x.thumb);
        }
        return prev.filter((x) => x.status !== "fertig");
      }), 1500);
      load();
    }
  }

  if (!ready) {
    return <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;
  }
  if (role !== "admin") {
    return <p className="text-sm text-muted-foreground p-6">Kein Zugriff — die Ablage ist Admins vorbehalten.</p>;
  }

  const offeneAnzahl = pending.filter(istAblegbar).length;

  return (
    <div className="space-y-6 page-enter">
      {ConfirmModalElement}
      {thumbGross && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none rounded-lg border border-border bg-white shadow-2xl p-1"
          style={{ position: "fixed", top: thumbGross.top, left: thumbGross.left, zIndex: 60 }}
        >
          <img src={thumbGross.src} alt="" className="block max-w-[300px] max-h-[380px] w-auto h-auto rounded-md" />
        </div>,
        document.body,
      )}
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <HardDriveUpload className="h-6 w-6" /> Ablage
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
          ariaLabel="Ablage-Bereiche"
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
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <ShieldCheck className="h-4 w-4 text-green-600 shrink-0" />
            Vertraulich: Dokument-Inhalte liest nur die lokale KI im Büro — nie ein Cloud-Dienst.
            {/* Chip «Lokale KI · online/offline» (SPEC 2.3) — Modell aus
                /api/ki/status, Tooltip = letzter Herzschlag (Zürich). */}
            {kiStatus === null ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Lokale KI · prüft…
              </span>
            ) : kiStatus.online ? (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                data-tooltip={kiStatus.letzter_poll ? `zuletzt gesehen ${fmtWann(kiStatus.letzter_poll)}` : "Herzschlag der lokalen KI im Büro"}
                data-tooltip-side="bottom"
              >
                <Cpu className="h-3 w-3" />
                Lokale KI · online{kiStatus.modell ? ` · ${kiStatus.modell}` : ""}
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground"
                data-tooltip={kiStatus.letzter_poll ? `zuletzt gesehen ${fmtWann(kiStatus.letzter_poll)}` : "noch nie gesehen"}
                data-tooltip-side="bottom"
              >
                <Cpu className="h-3 w-3" />
                Lokale KI · offline
              </span>
            )}
          </p>
          {/* Gleicher Stil wie die Weiterleitungs-Adresse im Auftrags-
              Eingang (eingang-erfassung.tsx). */}
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
            Auch per Mail an
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(ABLAGE_MAIL).then(() => toast.success("Adresse kopiert")); }}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground bg-muted/50 border border-border rounded-md px-1.5 py-0.5 hover:border-foreground/40"
              data-tooltip="Adresse kopieren"
              data-tooltip-side="bottom"
            >
              {ABLAGE_MAIL}
              <Copy className="h-3 w-3 text-muted-foreground" />
            </button>
            — Anhänge erscheinen unter «Ablegen».
          </p>
        </div>
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
            {/* Smarte Vorschläge: deterministisch gefunden, von der KI
                auf Sinnhaftigkeit geprüft (Nachbarstruktur) — nie automatisch. */}
            {pruefungLaeuft && ordnerVorschlaege.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  Struktur-Vorschläge werden auf Sinnhaftigkeit geprüft…
                </p>
              </div>
            )}
            {!pruefungLaeuft && angezeigteVorschlaege.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-2">
                {angezeigteVorschlaege.map((v) => (
                  <div key={v.id} className="flex items-center gap-2.5">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs">{v.titel}</p>
                      <p className="text-[11px] text-muted-foreground font-mono truncate">
                        {v.neuePfade.slice(0, 2).join(" · ")}{v.neuePfade.length > 2 ? ` · +${v.neuePfade.length - 2} weitere` : ""}
                      </p>
                      {v.grund && (
                        <p className="text-[11px] text-muted-foreground italic truncate" data-tooltip={v.grund}>
                          KI: {v.grund}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => vorschlagAnlegen(v)}
                      disabled={vorschlagBusy !== null}
                      className="kasten shrink-0"
                    >
                      {vorschlagBusy === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
                      {v.neuePfade.length > 1 ? `Bei ${v.neuePfade.length} anlegen` : "Anlegen"}
                    </button>
                    <button
                      type="button"
                      onClick={() => vorschlagIgnorieren(v.id)}
                      className="icon-btn shrink-0 opacity-60"
                      aria-label="Nicht mehr vorschlagen"
                      data-tooltip="Nicht mehr vorschlagen"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Versions-Muell-Finder (on demand). */}
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 shrink-0" />
                  Versions-Müll finden (…_v2, _final, «(3)» im selben Ordner)
                </p>
                <button type="button" onClick={bestandAnalysieren} disabled={aufraeumLaedt} className="kasten">
                  {aufraeumLaedt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                  Bestand analysieren
                </button>
              </div>
              {aufraeumGruppen && aufraeumGruppen.length > 0 && aufraeumGruppen.map((g) => (
                <div key={g.key} className="flex items-center gap-2.5">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs">{g.dateien.length}× «{g.kern}»</p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{g.ordner || "(Hauptebene)"}</p>
                  </div>
                  <button type="button" onClick={() => gruppeAufraeumen(g)} className="kasten shrink-0">
                    <Trash2 className="h-3.5 w-3.5" />
                    {g.dateien.length - 1} ältere → Papierkorb
                  </button>
                </div>
              ))}
            </div>
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
                                const wirdVerschoben = verschiebend.has(pfadVoll);
                                return (
                                  <li
                                    key={d.name}
                                    onMouseEnter={() => setHoverRow(pfadVoll)}
                                    onMouseLeave={() => setHoverRow((h) => (h === pfadVoll ? null : h))}
                                    className={`py-1.5 px-2 -mx-2 rounded-lg ${hover ? "bg-muted/60" : ""} ${wirdVerschoben ? "opacity-50" : ""}`}
                                  >
                                  <div className="flex items-center gap-2.5">
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
                                    {wirdVerschoben ? (
                                      <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0">
                                        <Loader2 className="h-3 w-3 animate-spin" /> verschiebt… <NasCountdown status={syncStatus} />
                                      </span>
                                    ) : laeuft ? (
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
                                        <span className="w-[104px] shrink-0 flex items-center justify-end gap-1">
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
                                                onClick={() => setMoveFuer((m) => (m === pfadVoll ? null : pfadVoll))}
                                                className="icon-btn opacity-70"
                                                aria-label="In anderen Ordner verschieben"
                                                data-tooltip="Verschieben"
                                              >
                                                <FolderInput className="h-3.5 w-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => dateiInPapierkorb(pfadVoll, d.name)}
                                                className="icon-btn icon-btn-red opacity-70"
                                                aria-label="In den Papierkorb"
                                                data-tooltip="Papierkorb"
                                              >
                                                <Trash2 className="h-3.5 w-3.5" />
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
                                  </div>
                                  {moveFuer === pfadVoll && !wirdVerschoben && (
                                    <div className="mt-1.5 pl-6 max-w-md">
                                      <SearchableSelect
                                        value=""
                                        onChange={(ziel) => { if (ziel) dateiVerschieben(pfadVoll, ziel); }}
                                        items={ordnerOptionen.filter((o) => o.id !== auswahl)}
                                        placeholder="Zielordner wählen…"
                                      />
                                    </div>
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

      {/* ── Tab «Ablage»: zwei Spalten (Laptop, fit-to-viewport) ──
          Links die tägliche Arbeit (Ablegen, Mail-Eingang, Suche/Zuletzt
          abgelegt), rechts was die lokale KI zum Entscheiden vorlegt
          (Einsortieren / Fristen, umschaltbar). Unter xl gestapelt. */}
      {tab === "ablage" && (
      <div
        ref={rasterRef}
        className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:h-[var(--ablage-h,calc(100dvh-15rem))]"
        style={rasterH ? ({ ["--ablage-h" as string]: `${rasterH}px` }) : undefined}
      >
      <div className="flex flex-col gap-4 min-h-0 min-w-0">
      {/* ── Ablegen (inkl. Mail-Eingang) ─────────────────────── */}
      <Card className="bg-card shrink-0 min-h-0 py-0 gap-0 xl:max-h-[62%]" data-testid="ablegen">
        <CardContent className="p-3 space-y-2.5 min-h-0 overflow-y-auto">
          {ordner !== null && ordner.length === 0 && (
            <div className="px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-xs text-amber-800 dark:text-amber-200">
              Noch keine Ordnerstruktur hinterlegt — im Tab «Ordner» anlegen oder den Sync-Container auf dem NAS starten.
            </div>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onMouseEnter={() => setHoverZone(true)}
            onMouseLeave={() => setHoverZone(false)}
            className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl border-2 border-dashed text-sm font-medium transition-all ${
              zieht
                ? "border-red-400 bg-red-50/60 text-red-700 dark:bg-red-500/10 dark:border-red-500/50 dark:text-red-300"
                : hoverZone
                  ? "border-foreground/40 bg-muted/50 text-foreground"
                  : "border-border text-muted-foreground"
            }`}
          >
            <Upload className={`h-4 w-4 ${zieht ? "animate-bounce" : ""}`} />
            {zieht ? "Loslassen — Datei wird hinzugefügt" : "Dateien wählen oder hierhin ziehen"}
          </button>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => dateienWaehlen(e.target.files)} />

          {/* ── Per Mail eingegangen (ablage@ -> Migr 282/283) ── */}
          {eingang.length > 0 && (
            <div className="rounded-lg border border-border" data-testid="mail-eingang">
              <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" />
                Per Mail eingegangen · {eingang.length}
              </p>
              <ul className="max-h-36 overflow-y-auto px-2.5 pb-1.5">
                {eingang.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 py-1">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] truncate" data-tooltip={e.name}>{e.name} <span className="text-[11px] text-muted-foreground">({fmtBytes(e.groesse)})</span></p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {e.mail_von ?? "unbekannt"}{e.mail_betreff ? ` · ${e.mail_betreff}` : ""} · {fmtWann(e.created_at)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => eingangUebernehmen(e)}
                      disabled={eingangBusy !== null}
                      className="kasten shrink-0 px-2 py-1 text-[11px]"
                    >
                      {eingangBusy === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <HardDriveUpload className="h-3 w-3" />}
                      Übernehmen
                    </button>
                    <button
                      type="button"
                      onClick={() => eingangVerwerfen(e)}
                      className="icon-btn icon-btn-red shrink-0"
                      aria-label="Verwerfen"
                      data-tooltip="Verwerfen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pending.length > 0 && (
            <div className="space-y-2">
              {/* Offline-Hinweis EINMAL ueber der Liste (nicht pro Karte),
                  solange mindestens eine Karte im Beschreiben-Schritt haengt. */}
              {kiStatus && !kiStatus.online && pending.some((p) => p.phase === "beschreiben") && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1">
                  <TriangleAlert className="h-3 w-3 shrink-0" />
                  {KI_OFFLINE_HINWEIS}
                </p>
              )}
              {pending.map((p) => (
                <div key={p.key} className={`p-3 rounded-xl border space-y-2 ${p.status === "fertig" ? "border-green-300 bg-green-50/50 dark:bg-green-500/10 dark:border-green-500/30" : p.status === "fehler" ? "border-red-300 bg-red-50/40 dark:bg-red-500/10 dark:border-red-500/30" : "bg-muted/20"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* Mini-Vorschau: man sieht sofort, WAS man da ablegt. */}
                      {p.thumb ? (
                        // Hover = grosse Vorschau (state-driven, §3);
                        // pointer-events-none, damit sie nie im Weg ist.
                        <span
                          className="relative shrink-0"
                          onMouseEnter={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            // Vertikal so klemmen, dass die (max 390px hohe)
                            // Vorschau immer ganz im Fenster bleibt.
                            const top = Math.max(8, Math.min(r.top, window.innerHeight - 398));
                            setThumbGross({ key: p.key, src: p.thumb!, top, left: r.right + 10 });
                          }}
                          onMouseLeave={() => setThumbGross((t) => (t?.key === p.key ? null : t))}
                        >
                          <img src={p.thumb} alt="" className="h-10 w-10 rounded-md border border-border object-cover bg-white cursor-zoom-in" />
                        </span>
                      ) : (
                        <span className="h-10 w-10 shrink-0 rounded-md border border-border bg-muted/40 flex items-center justify-center">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{p.file.name}</p>
                        <p className="text-[11px] text-muted-foreground">{(p.file.size / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {p.status === "laedt" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {p.status === "fertig" && <span className="text-[11px] font-medium text-green-700 dark:text-green-400 flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Abgelegt</span>}
                      {p.status !== "laedt" && p.status !== "fertig" && (
                        <button type="button" onClick={() => entfernePending(p.key)} className="icon-btn icon-btn-red" aria-label="Entfernen" data-tooltip="Entfernen">
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
                          todayLocalIso(),
                        )
                      : null;
                    // ── Phase 0: lokale KI liest das Dokument (SPEC 2.3).
                    // Spinner + Status aus dem Auftrag; «Selbst beschreiben»
                    // als Ausweg, damit niemand bis zum Timeout warten muss.
                    if (p.phase === "lesen") {
                      return (
                        <div className="px-3 py-2.5 rounded-lg bg-muted/40 flex items-center gap-2 text-xs flex-wrap">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                          <span className="font-medium">Lokale KI liest das Dokument…</span>
                          <LeseFortschritt seit={p.lokalSeit ?? Date.now()} status={p.lokalStatus} />
                          <button
                            type="button"
                            onClick={() => lokalAbbrechen(p.key)}
                            className="ml-auto text-[11px] text-muted-foreground underline underline-offset-2"
                          >
                            Selbst beschreiben
                          </button>
                        </div>
                      );
                    }
                    // ── Phase 1 (Fallback ohne lokale KI): nur EIN Feld —
                    // beschreiben (Leo 2026-09-30: die Formular-Wand war nicht
                    // intuitiv). Claude liefert danach Zusammenfassung inkl.
                    // Zielordner-Vorschlag — sieht nur den Text, nie die Datei.
                    if (p.phase !== "pruefen") {
                      return (
                        <div className="space-y-2">
                          {p.lokalHinweis && (
                            <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-1">
                              <TriangleAlert className="h-3 w-3 shrink-0" />
                              {p.lokalHinweis}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <Input
                              autoFocus={!!p.fokus}
                              placeholder="Was ist das? — z.B. «Haftpflichtversicherung von der AXA, Police P-778812, vom 15.1.26»"
                              value={p.kiText}
                              onChange={(e) => updatePending(p.key, { kiText: e.target.value })}
                              onBlur={() => {
                                if (!p.kiGelaufen && !p.kiLaeuft && p.kiText.trim().length >= 10) kiVorschlag(p);
                              }}
                              disabled={p.kiLaeuft}
                              className="flex-1"
                            />
                            <button
                              type="button"
                              onClick={() => kiVorschlag(p)}
                              disabled={p.kiLaeuft || p.kiText.trim().length < 3}
                              className="kasten shrink-0"
                            >
                              {p.kiLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                              {p.kiLaeuft ? "Analysiert…" : "Weiter"}
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <p className="text-[11px] text-muted-foreground">
                              Die KI sieht nur diesen Text und den Dateinamen — nie das Dokument.
                            </p>
                            <button
                              type="button"
                              onClick={() => updatePending(p.key, { phase: "pruefen", anpassen: true })}
                              className="text-[11px] text-muted-foreground underline underline-offset-2"
                            >
                              Ohne KI ausfüllen
                            </button>
                          </div>
                        </div>
                      );
                    }
                    // ── Phase 2: pruefen — Zusammenfassung statt Formular.
                    // Naechstbeste Ziele der lokalen KI als Ordner-Chips (Stil
                    // der Unterordner-Chips im Explorer): mit Ziel «Oder:» —
                    // Klick tauscht, zurueck mit einem Klick; ohne Ziel
                    // «Vorschläge:» — Klick setzt den Ordner. Die Zeile steht
                    // in der Zusammenfassung, bei offenem «Anpassen» ueber dem
                    // Ordner-Auswahlfeld (nie doppelt).
                    const alternativen = p.lokalGelesen
                      ? (p.ordnerAlternativen ?? []).filter((a) => a !== p.ordner && waehlbareOrdner.has(a))
                      : [];
                    const ordnerChips = (einzug = "") =>
                      alternativen.length === 0 ? null : (
                        <div className={`flex items-center gap-1.5 flex-wrap ${einzug}`}>
                          <span className="text-[11px] text-muted-foreground">{p.ordner ? "Oder:" : "Vorschläge:"}</span>
                          {alternativen.map((a) => (
                            <button
                              key={a}
                              type="button"
                              onClick={() => zielordnerSetzen(p.key, a, { neuerOrdner: undefined })}
                              disabled={laedt || p.kiLaeuft}
                              className="kasten kasten-muted max-w-full px-2 py-0.5 text-[11px]"
                              data-tooltip={a}
                            >
                              <Folder className="h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" />
                              <span className="min-w-0 truncate font-mono">{a.split("/").slice(-2).join("/")}</span>
                            </button>
                          ))}
                        </div>
                      );
                    return (
                      <div className="space-y-2">
                        <div className="px-3 py-2.5 rounded-lg bg-muted/40 space-y-1.5">
                          <p className="text-sm font-medium flex items-start gap-1.5 break-all">
                            <FileText className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                            <span className="flex-1 min-w-0">{vorschau ?? "— Betreff fehlt noch —"}</span>
                            {p.lokalGelesen && (
                              <span
                                className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                                data-tooltip="Die lokale KI im Büro hat das Dokument gelesen und die Felder ausgefüllt"
                              >
                                <Cpu className="h-3 w-3" />
                                lokal gelesen
                              </span>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5 text-xs flex-wrap">
                            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
                            {p.ordner ? (
                              <>
                                <span className="font-mono text-muted-foreground">{p.ordner}</span>
                                {/* V8: Herkunft des Zielordners (Stil «lokal gelesen»);
                                    bei niedriger Sicherheit amber statt gruen. */}
                                {p.ordnerQuelle && (
                                  <span
                                    className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                      p.ordnerSicherheit === "niedrig"
                                        ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
                                        : "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                                    }`}
                                    data-tooltip={p.ordnerBegruendung || ORDNER_QUELLE_TOOLTIP[p.ordnerQuelle]}
                                  >
                                    {ORDNER_QUELLE_LABEL[p.ordnerQuelle]}
                                  </span>
                                )}
                              </>
                            ) : (
                              <div className="flex-1 min-w-60 space-y-1.5">
                                {p.neuerOrdner && (
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs text-amber-700 dark:text-amber-300">
                                      Kein passender Ordner — Vorschlag: <span className="font-mono">{p.neuerOrdner}</span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => neuenOrdnerVerwenden(p)}
                                      disabled={laedt}
                                      className="kasten shrink-0"
                                    >
                                      <FolderPlus className="h-3.5 w-3.5" />
                                      Anlegen & verwenden
                                    </button>
                                  </div>
                                )}
                                {!p.anpassen && ordnerChips()}
                                <SearchableSelect
                                  value={p.ordner}
                                  onChange={(v) => zielordnerSetzen(p.key, v, { neuerOrdner: undefined })}
                                  items={ordnerOptionen}
                                  placeholder={p.neuerOrdner ? "…oder bestehenden Ordner wählen" : "Zielordner wählen… *"}
                                />
                              </div>
                            )}
                          </div>
                          {p.ordner && p.ordnerQuelle && p.ordnerSicherheit === "niedrig" && (
                            <p className="pl-5 text-[11px] flex items-center gap-1 text-amber-700 dark:text-amber-300">
                              <TriangleAlert className="h-3 w-3 shrink-0" />
                              Unsicher — bitte prüfen
                            </p>
                          )}
                          {p.ordner && !p.anpassen ? ordnerChips("pl-5") : null}
                          {p.frist && (
                            <p className="text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                              <Bell className="h-3.5 w-3.5 shrink-0" />
                              Frist {new Date(p.frist).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })} — Erinnerung 30/7/0 Tage vorher per Mail
                            </p>
                          )}
                        </div>
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
                                disabled={laedt || p.kiLaeuft}
                                className="flex-1"
                              />
                              <button
                                type="button"
                                onClick={() => fragenBeantworten(p)}
                                disabled={laedt || p.kiLaeuft || !p.antwort.trim()}
                                className="kasten shrink-0"
                              >
                                {p.kiLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                                Ergänzen
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <button
                            type="button"
                            onClick={() => updatePending(p.key, { anpassen: !p.anpassen })}
                            className="text-xs text-muted-foreground flex items-center gap-1"
                          >
                            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${p.anpassen ? "rotate-90" : ""}`} />
                            Anpassen
                          </button>
                          <button
                            type="button"
                            onClick={() => ablegen(p)}
                            disabled={laedt || p.kiLaeuft}
                            className="kasten kasten-red"
                          >
                            {laedt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveUpload className="h-3.5 w-3.5" />}
                            {laedt ? "Legt ab…" : "Ablegen"}
                          </button>
                        </div>
                        {p.anpassen && (
                        <>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Beschrieb in deinen Worten — für eine neue KI-Analyse…"
                            value={p.kiText}
                            onChange={(e) => updatePending(p.key, { kiText: e.target.value })}
                            disabled={laedt || p.kiLaeuft}
                            className="flex-1"
                          />
                          <button
                            type="button"
                            onClick={() => kiVorschlag(p)}
                            disabled={laedt || p.kiLaeuft || p.kiText.trim().length < 3}
                            className="kasten shrink-0"
                          >
                            {p.kiLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            Neu analysieren
                          </button>
                        </div>
                        {/* items-end: mit Ordner-Chips ueber dem Zielordner-Feld
                            bleiben beide Auswahlfelder auf einer Linie. */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
                          <SearchableSelect
                            value={p.typ}
                            onChange={(v) => updatePending(p.key, { typ: v })}
                            items={DOK_TYPEN.map((t) => ({ id: t.key, label: t.label }))}
                            placeholder="Dokumenttyp…"
                          />
                          <div className="space-y-1.5 min-w-0">
                            {ordnerChips()}
                            <SearchableSelect
                              value={p.ordner}
                              onChange={(v) => zielordnerSetzen(p.key, v)}
                              items={ordnerOptionen}
                              placeholder="Zielordner wählen… *"
                            />
                          </div>
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
                            <Input
                              type="date"
                              value={p.frist}
                              onChange={(e) => updatePending(p.key, { frist: e.target.value })}
                              disabled={laedt}
                              aria-label="Frist (optional)"
                              data-tooltip="Kündigungs-/Ablauffrist — Erinnerungs-Mail an Admins 30/7/0 Tage vorher"
                            />
                          </div>
                        )}
                        </>
                        )}
                      </div>
                    );
                  })()}
                  {p.status !== "fertig" && p.rigDoppel && (
                    <div
                      className="px-3 py-2 rounded-lg border border-violet-300 bg-violet-50 dark:bg-violet-500/15 dark:border-violet-500/40 space-y-0.5"
                      data-testid="ablage-doppel"
                    >
                      <p className="text-xs font-semibold text-violet-900 dark:text-violet-100">{RIG_DOPPEL_TITEL[p.rigDoppel.art]}</p>
                      <p className="text-[11px] font-mono break-all text-violet-800 dark:text-violet-200">{p.rigDoppel.pfad}</p>
                      {p.rigDoppel.art === "exakt" && (
                        <p className="text-[11px] text-violet-800 dark:text-violet-200">Exakt dieselbe Datei — Karte entfernen, wenn sie nicht gebraucht wird.</p>
                      )}
                    </div>
                  )}
                  {p.status !== "fertig" && (p.duplikatFunde?.length ?? 0) > 0 && (
                    <div className="px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 space-y-1.5">
                      <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">Mögliches Duplikat</p>
                      {p.duplikatFunde!.map((f, idx) => (
                        <p key={idx} className="text-xs text-amber-800 dark:text-amber-200">{f.text}</p>
                      ))}
                      <button type="button" onClick={() => ablegen(p, true)} className="kasten">
                        <HardDriveUpload className="h-3.5 w-3.5" />
                        Trotzdem ablegen
                      </button>
                    </div>
                  )}
                  {p.fehler && <p className="text-xs text-red-600 dark:text-red-400">{p.fehler}</p>}
                </div>
              ))}
              {offeneAnzahl > 1 && (
              // Klebt am unteren Rand der (intern scrollenden) Karte — bei
              // vielen Karten muss niemand bis ans Ende scrollen.
              <div className="sticky -bottom-3 z-[1] -mx-3 px-3 pt-1.5 pb-3 bg-card">
              <button
                type="button"
                onClick={alleAblegen}
                disabled={alleBusy}
                className="kasten kasten-red w-full"
              >
                {alleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveUpload className="h-3.5 w-3.5" />}
                {alleBusy ? "Legt ab…" : `Alle ${offeneAnzahl} Dokumente ablegen`}
              </button>
              </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Historie / Namensregister ──────────────────────── */}
      <Card className="bg-card min-h-0 max-h-[32rem] xl:max-h-none gap-0 pb-0" data-testid="zuletzt">
        {(() => {
          // NAS-Index-Treffer ohne die, die schon als Ablage-Eintrag da sind.
          const belegt = new Set(items.map((i) => `${i.ordner_pfad}/${i.abgelegt_name}`));
          const nasTreffer = suche.trim() ? indexTreffer.filter((x) => !belegt.has(x.pfad)) : [];
          const anzahl = items.length + nasTreffer.length;
          // Inhaltstreffer, die schon als Namenstreffer dastehen, nicht doppelt.
          const schonGelistet = new Set([...belegt, ...nasTreffer.map((x) => x.pfad)]);
          return (
          <>
        <CardHeader className="pb-2 shrink-0">
          <div className="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
            <CardTitle className="text-sm shrink-0">{suche.trim() ? `Suchergebnisse (${anzahl})` : "Zuletzt abgelegt"}</CardTitle>
            {/* Volle Spaltenbreite: der Placeholder nennt mit lokaler KI eine
                Beispiel-Frage (Fragen ans Archiv stellt die Seite automatisch,
                useArchivAutoFrage). */}
            <div className="relative w-full sm:flex-1 sm:min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={suche}
                onChange={(e) => setSuche(e.target.value)}
                onFocus={() => { if (inhaltBereit || archivBereit) weckeKi(); }}
                placeholder={archivBereit ? "Dokument suchen oder Frage stellen — z. B. Bis wann läuft der Mietvertrag?" : "Dokument suchen — findet alles auf dem NAS…"}
                className="h-8 text-xs pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 overflow-y-auto pb-3">
          <ArchivAntwort archiv={archiv} supabase={supabase} />
          {anzahl === 0 ? (
            <p className="text-sm text-muted-foreground">
              {suche.trim() ? (inhaltBereit ? "Kein Dateiname passt." : "Nichts gefunden.") : "Noch nichts abgelegt."}
            </p>
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
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 min-w-0">
                        <span className="font-mono min-w-0 truncate" data-tooltip={i.ordner_pfad}>{i.ordner_pfad}</span>
                        <ChevronRight className="h-3 w-3 shrink-0" />
                        <span className="shrink-0">{fmtWann(i.created_at)}{a?.full_name ? ` · ${a.full_name}` : ""}</span>
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
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 min-w-0">
                      <span className="font-mono min-w-0 truncate" data-tooltip={x.ordner_pfad || undefined}>{x.ordner_pfad || "(Hauptebene)"}</span>
                      {x.geaendert && (
                        <>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                          <span className="shrink-0">{fmtWann(x.geaendert)}</span>
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
          {inhaltBereit && suche.trim() && (
            <InhaltTreffer
              q={suche}
              ausblenden={schonGelistet}
              onOrdnerZeigen={(o) => { waehlen(o); wechsleTab("ordner"); }}
              onAbrufen={dateiAbrufen}
              abrufLaeuft={abrufLaeuft}
            />
          )}
        </CardContent>
          </>
          );
        })()}
      </Card>
      </div>

      {/* ── Rechts: was die lokale KI zum Entscheiden vorlegt ──
          Umschalter (Kasten-Toggle, Filter-Muster wie Einstellungen):
          Einsortieren = Rückstau ZZ (MP-7), Fristen = ablage_fristen
          (MP-7/E3.4, Ziel des Deep-Links ?gruppe=fristen), Doppelte = gleiche
          Dateien auf dem ganzen NAS (Migration 334, ?gruppe=doppelte). Alle
          bleiben gemountet (Anzahlen im Umschalter, Live-Takt), sichtbar ist einer.
          Rückstau erst nach geladener Ordnerliste, sonst gaelte jedes Ziel
          kurz als «gesperrt». */}
      <Card className="bg-card min-h-0 min-w-0 py-0 gap-0 max-h-[36rem] xl:max-h-full xl:self-start" data-testid="zu-erledigen">
        <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border flex-wrap">
          {([
            { key: "einsortieren", label: "Einsortieren", icon: <Inbox className="h-3.5 w-3.5" />, n: zzAnzahl, hinweis: "Zielordner-Vorschläge der lokalen KI für Dateien in den ZZ-Ordnern" },
            { key: "fristen", label: "Fristen", icon: <CalendarClock className="h-3.5 w-3.5" />, n: fristAnzahl.n, hinweis: fristAnzahl.zuPruefen > 0 ? `${fristAnzahl.zuPruefen} zu prüfen` : "Fristen aus Verträgen und beim Ablegen erfasste" },
            { key: "doppelte", label: "Doppelte", icon: <Copy className="h-3.5 w-3.5" />, n: doppelAnzahl, hinweis: "Gleiche Dateien auf dem ganzen NAS — von der lokalen KI im Büro gefunden" },
          ] as const).map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => wechsleSicht(s.key)}
              className={sicht === s.key ? "kasten-active" : "kasten-toggle-off"}
              aria-pressed={sicht === s.key}
              data-testid={`ablage-sicht-${s.key}`}
              data-tooltip={s.hinweis}
            >
              {s.icon}
              {s.label}
              {s.n !== null && <span className="tabular-nums opacity-70">{s.n}</span>}
            </button>
          ))}
          {fristAnzahl.zuPruefen > 0 && sicht !== "fristen" && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">{fristAnzahl.zuPruefen} {fristAnzahl.zuPruefen === 1 ? "Frist" : "Fristen"} zu prüfen</span>
          )}
        </div>
        <div className={sicht === "einsortieren" ? "flex flex-col flex-1 min-h-0" : "hidden"}>
          {ordner !== null ? (
            <RueckstauZz supabase={supabase} takt={datenTick} ordnerOptionen={ordnerOptionen} waehlbareOrdner={waehlbareOrdner} onAnzahl={setZzAnzahl} />
          ) : (
            <div className="p-4 space-y-2">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="shimmer rounded-md h-8" />)}
            </div>
          )}
        </div>
        <div className={sicht === "fristen" ? "flex flex-col flex-1 min-h-0" : "hidden"}>
          <FristenGruppe supabase={supabase} takt={datenTick} onAnzahl={meldeFristen} />
        </div>
        <div className={sicht === "doppelte" ? "flex flex-col flex-1 min-h-0" : "hidden"}>
          <DoppelteListe supabase={supabase} takt={datenTick} onAnzahl={setDoppelAnzahl} />
        </div>
      </Card>
      </div>
      )}
      </>
      )}
    </div>
  );
}
