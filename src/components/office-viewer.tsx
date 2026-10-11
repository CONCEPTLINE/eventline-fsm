"use client";

/**
 * Office-Vorschau (Word/Excel) im Browser — wird vom PdfPopup lazy geladen.
 *
 * Datenschutz: Die Datei wird ueber die signierte URL geholt und NUR lokal im
 * Browser gerendert (docx-preview fuer .docx, SheetJS fuer Tabellen). Kein
 * externer Viewer (kein Office-Online, kein Google-Viewer), nichts verlaesst
 * den Browser.
 *
 * Bundle: Diese Datei kommt per next/dynamic, die beiden Bibliotheken werden
 * erst beim Rendern per import() nachgeladen — nichts davon im Haupt-Bundle.
 *
 * - docx:  seitentreu (Seitengroesse, Raender, Kopf-/Fusszeilen). Passt sich
 *          per CSS-zoom an die Popup-Breite an; Zoom-Knoepfe wie im
 *          Mobile-PDF-Viewer.
 * - sheet: .xlsx/.xlsm/.xlsb/.xls/.csv/.ods — Blatt-Tabs, Zahlen/Datum so
 *          formatiert wie im Dokument hinterlegt, verbundene Zellen,
 *          Spaltenbreiten, ausgeblendete Zeilen/Spalten.
 * - unsupported: .doc/.ppt/.pptx/… — Hinweis + Herunterladen.
 */

import { useEffect, useRef, useState } from "react";
import { Download, FileWarning, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import type { CellObject, WorkSheet } from "xlsx";

export type OfficeKind = "docx" | "sheet" | "unsupported";

interface Props {
  url: string;
  title: string;
  kind: OfficeKind;
  /** Endung (klein, ohne Punkt), an der PdfPopup den Typ erkannt hat —
   *  entscheidet CSV (roh lesen) vs. Excel; hier wird nicht erneut geraten. */
  ext: string;
}

type Status = "loading" | "ready" | "error";

export default function OfficeViewer({ url, title, kind, ext }: Props) {
  if (kind === "unsupported") {
    return (
      <Hinweis
        url={url}
        title={title}
        text="Für dieses Format gibt es keine Vorschau — nur für Word (.docx) und Excel (.xlsx, .xls, .csv). Datei herunterladen und im Programm öffnen."
      />
    );
  }
  if (kind === "docx") return <DocxView url={url} title={title} />;
  return <SheetView url={url} title={title} csv={ext === "csv"} />;
}

/** Nach dem Rendern eines Word-Dokuments: nichts Aktives aus der Datei im
 *  App-Origin lassen. docx-preview wuerde eingebettetes HTML (altChunk) als
 *  iframe OHNE sandbox rendern (abgeschaltet via renderAltChunks:false, hier
 *  zusaetzlich entfernt) und uebernimmt Hyperlink-Ziele ungefiltert — ein
 *  «javascript:»-Ziel liefe sonst mit der Session des Betrachters. Normale
 *  Links oeffnen in einem neuen Tab, damit das Popup und die Seite dahinter
 *  (ungespeicherte Eingaben) nicht wegnavigiert werden. */
function entschaerfeDokument(host: HTMLElement) {
  host.querySelectorAll("iframe, script, object, embed").forEach((n) => n.remove());
  host.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });
  host.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return; // Sprungmarken (Fussnoten, Verzeichnis) bleiben
    if (!/^(https?:|mailto:|tel:)/i.test(href.trim())) {
      a.removeAttribute("href");
      return;
    }
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

// ---------------------------------------------------------------------------
// Gemeinsames
// ---------------------------------------------------------------------------

async function fetchFile(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

function Laden() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <span className="text-xs">Vorschau wird geladen…</span>
    </div>
  );
}

function Hinweis({ url, title, text }: { url: string; title: string; text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <FileWarning className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 break-all text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{text}</p>
        <a href={url} download={title} target="_blank" rel="noopener noreferrer" className="kasten kasten-muted mt-4">
          <Download className="h-3.5 w-3.5" /> Herunterladen
        </a>
      </div>
    </div>
  );
}

const FEHLER_TEXT = "Die Vorschau konnte nicht geladen werden. Datei herunterladen und im Programm öffnen.";

/** Runder Icon-Knopf fuer die schwebende Zoom-Steuerung (Hover state-driven). */
function RundKnopf({
  onClick, disabled, label, children,
}: { onClick: () => void; disabled?: boolean; label: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const active = hover && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-tooltip={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="rounded-full p-2 transition-colors disabled:opacity-40"
      style={{
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        backgroundColor: active ? "var(--muted)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Word (.docx) — docx-preview
// ---------------------------------------------------------------------------

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function DocxView({ url, title }: { url: string; title: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [pageWidth, setPageWidth] = useState(0);
  const [availWidth, setAvailWidth] = useState(0);
  // null = automatisch an die Breite anpassen (Default, folgt Popup-Resize)
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ctrl = new AbortController();
    let cancelled = false;
    host.innerHTML = "";
    (async () => {
      try {
        const [data, { renderAsync }] = await Promise.all([
          fetchFile(url, ctrl.signal),
          import("docx-preview"),
        ]);
        if (cancelled) return;
        await renderAsync(data, host, undefined, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          // Von Word gespeicherte Seitenumbrueche respektieren → gleiche Seiten
          // wie in Word (Seiten wachsen bei abweichenden Schriften, nichts geht verloren).
          ignoreLastRenderedPageBreak: false,
          experimental: true, // Tabulatoren-Berechnung — bessere Layout-Treue
          useBase64URL: true, // keine Blob-URLs, die man aufraeumen muesste
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          // Eingebettetes HTML (altChunk) nie rendern — waere ein iframe ohne
          // sandbox im App-Origin (Review 2026-10-11); s. entschaerfeDokument.
          renderAltChunks: false,
        });
        if (cancelled) { host.innerHTML = ""; return; }
        entschaerfeDokument(host);
        setPageWidth(host.querySelector<HTMLElement>("section.docx")?.offsetWidth ?? 0);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("Office-Vorschau (docx):", err);
        setStatus("error");
        toast.error("Vorschau konnte nicht geladen werden");
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      host.innerHTML = "";
    };
  }, [url]);

  // Verfuegbare Breite messen (Popup ist resizable) fuer Fit-to-Width.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = pageWidth > 0 && availWidth > 0 ? Math.min(1, (availWidth - 32) / pageWidth) : 1;
  const scale = zoom ?? fit;
  // Auf Viertelschritte einrasten (0.84 → 1.0 / 0.75), nie ueber die Grenzen.
  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? Math.floor(scale * 4) / 4 + 0.25 : Math.ceil(scale * 4) / 4 - 0.25;
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  };

  return (
    <div className="relative h-full w-full">
      {/* Eigener Stacking-Kontext (z-0): docx-preview setzt im Dokument
          position/z-index — ohne Isolation malt der Seiteninhalt ueber die
          schwebende Zoom-Steuerung. */}
      <div ref={scrollRef} className="relative z-0 h-full w-full overflow-auto">
        <div
          ref={hostRef}
          className={`office-docx ${status === "ready" ? "" : "invisible"}`}
          style={{ zoom: scale }}
        />
      </div>
      {status === "loading" && <Laden />}
      {status === "error" && (
        <div className="absolute inset-0 z-10 bg-card">
          <Hinweis url={url} title={title} text={FEHLER_TEXT} />
        </div>
      )}
      {status === "ready" && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-full border border-border bg-card/95 px-1 py-1 shadow-lg backdrop-blur">
          <RundKnopf onClick={() => zoomStep(-1)} disabled={scale <= MIN_ZOOM} label="Verkleinern">
            <ZoomOut className="h-5 w-5" />
          </RundKnopf>
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="min-w-[3rem] px-2 text-xs font-medium tabular-nums text-muted-foreground"
            aria-label="An Breite anpassen"
            data-tooltip="An Breite anpassen"
          >
            {Math.round(scale * 100)}%
          </button>
          <RundKnopf onClick={() => zoomStep(1)} disabled={scale >= MAX_ZOOM} label="Vergrössern">
            <ZoomIn className="h-5 w-5" />
          </RundKnopf>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabellen (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods) — SheetJS
// ---------------------------------------------------------------------------

// Grenzen fuer die Darstellung (nicht fuers Parsen): grosse Blaetter wuerden
// sonst zehntausende Zellen rendern. Die Datei selbst bleibt vollstaendig.
const MAX_ROWS = 1000;
const MAX_COLS = 50;

type Xlsx = typeof import("xlsx");

interface CellView {
  key: string;
  text: string;
  align: "left" | "right" | "center";
  rowSpan: number;
  colSpan: number;
}
interface SheetModel {
  name: string;
  cols: { c: number; letter: string; width: number }[];
  rows: { r: number; cells: (CellView | null)[] }[];
  truncated: string | null;
}

// Tausendertrennzeichen wie ueberall in der App (Intl de-CH → «’»). Excel-
// Formate tragen immer «,» als Gruppierungs-Code; angezeigt wird das Zeichen
// der Region — SheetJS kennt keine Region und gibt das Komma aus.
const GROUP_SEP = new Intl.NumberFormat("de-CH").format(1000).charAt(1);

/**
 * SheetJS kann Punkte in Datumsformaten (dd.mm.yyyy — Standard in CH/DE) nicht
 * formatieren: ein Punkt nach einem Datums-Token gilt dort als Sekunden-
 * bruchteil («bad second format»). Punkte, auf die kein Ziffern-Platzhalter
 * folgt, als Literal escapen — Zahlenformate (#,##0.00) bleiben unberuehrt.
 */
function sanitizeFormat(z: string): string {
  return z.replace(/(?<!\\)\.(?![0#?])/g, "\\.");
}

function cellText(XLSX: Xlsx, cell: CellObject | undefined): string {
  if (!cell || cell.t === "z") return "";
  if (cell.t === "b") return cell.v ? "WAHR" : "FALSCH";
  let text: string;
  try {
    if (cell.w !== undefined) {
      text = cell.w;
    } else if (cell.t === "n" && typeof cell.z === "string" && typeof cell.v === "number") {
      // Kein Anzeigetext vom Parser → Format war nicht formatierbar (Punkt-Datum)
      text = String(XLSX.SSF.format(sanitizeFormat(cell.z), cell.v));
    } else {
      text = XLSX.utils.format_cell(cell);
    }
  } catch {
    text = String(cell.v ?? "");
  }
  return cell.t === "n" ? text.replace(/(\d),(?=\d{3}(?!\d))/g, `$1${GROUP_SEP}`) : text;
}

function cellAlign(cell: CellObject | undefined): CellView["align"] {
  if (!cell) return "left";
  if (cell.t === "n" || cell.t === "d") return "right";
  if (cell.t === "b") return "center";
  return "left";
}

function buildSheet(XLSX: Xlsx, ws: WorkSheet, name: string): SheetModel {
  const ref = ws["!ref"];
  if (!ref) return { name, cols: [], rows: [], truncated: null };
  const range = XLSX.utils.decode_range(ref);
  const data = ws["!data"] ?? [];
  const colInfo = ws["!cols"] ?? [];
  const rowInfo = ws["!rows"] ?? [];
  const rEnd = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
  const cEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);

  const cols: SheetModel["cols"] = [];
  for (let c = range.s.c; c <= cEnd; c++) {
    const info = colInfo[c];
    if (info?.hidden) continue;
    // Excel-Breite in Zeichen → Pixel (Default ~8.43 Zeichen ≈ 64px)
    const width = info?.wpx ?? (info?.wch ? Math.round(info.wch * 7 + 5) : 64);
    cols.push({ c, letter: XLSX.utils.encode_col(c), width: Math.max(32, Math.min(width, 480)) });
  }
  const visibleRows: number[] = [];
  for (let r = range.s.r; r <= rEnd; r++) if (!rowInfo[r]?.hidden) visibleRows.push(r);
  const rowSet = new Set(visibleRows);
  const colSet = new Set(cols.map((x) => x.c));

  // Verbundene Zellen: der Anker bekommt row-/colSpan (nur sichtbare Zeilen/
  // Spalten gezaehlt), die ueberdeckten Zellen werden ausgelassen. Liegt der
  // Anker selbst ausserhalb/ausgeblendet, wird der Verbund ignoriert.
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const m of ws["!merges"] ?? []) {
    if (!rowSet.has(m.s.r) || !colSet.has(m.s.c)) continue;
    let rowSpan = 0;
    for (let r = m.s.r; r <= m.e.r; r++) if (rowSet.has(r)) rowSpan++;
    let colSpan = 0;
    for (let c = m.s.c; c <= m.e.c; c++) if (colSet.has(c)) colSpan++;
    spans.set(`${m.s.r}:${m.s.c}`, { rowSpan, colSpan });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`);
      }
    }
  }

  const rows: SheetModel["rows"] = visibleRows.map((r) => ({
    r,
    cells: cols.map(({ c }) => {
      const key = `${r}:${c}`;
      if (covered.has(key)) return null;
      const cell = data[r]?.[c];
      const span = spans.get(key);
      return {
        key,
        text: cellText(XLSX, cell),
        align: cellAlign(cell),
        rowSpan: span?.rowSpan ?? 1,
        colSpan: span?.colSpan ?? 1,
      };
    }),
  }));

  const totalRows = range.e.r - range.s.r + 1;
  const totalCols = range.e.c - range.s.c + 1;
  const parts: string[] = [];
  if (range.e.r > rEnd) parts.push(`erste ${MAX_ROWS} von ${totalRows} Zeilen`);
  if (range.e.c > cEnd) parts.push(`erste ${MAX_COLS} von ${totalCols} Spalten`);
  return { name, cols, rows, truncated: parts.length ? `Vorschau: ${parts.join(", ")}` : null };
}

/** CSV als Text dekodieren: UTF-8 (mit/ohne BOM), sonst Windows-1252 (Excel-Export). */
function decodeCsv(data: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

function SheetView({ url, title, csv }: { url: string; title: string; csv: boolean }) {
  const [status, setStatus] = useState<Status>("loading");
  const [sheets, setSheets] = useState<SheetModel[]>([]);
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const [data, XLSX] = await Promise.all([fetchFile(url, ctrl.signal), import("xlsx")]);
        if (cancelled) return;
        // Excels eingebaute, regionsabhaengige Formate «Datum kurz» (14) und
        // «Datum + Zeit» (22) wie in der Schweiz anzeigen statt US (m/d/yy).
        XLSX.SSF.load("dd\\.mm\\.yyyy", 14);
        XLSX.SSF.load("dd\\.mm\\.yyyy hh:mm", 22);
        const wb = csv
          // CSV: Werte so lassen wie sie in der Datei stehen (keine Datums-/Zahlenumdeutung)
          ? XLSX.read(decodeCsv(data), { type: "string", raw: true, dense: true })
          : XLSX.read(data, { type: "array", dense: true, cellNF: true });
        const models = wb.SheetNames.map((name) => buildSheet(XLSX, wb.Sheets[name], name));
        if (cancelled) return;
        setSheets(models);
        setActive(0);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("Office-Vorschau (Tabelle):", err);
        setStatus("error");
        toast.error("Vorschau konnte nicht geladen werden");
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [url, csv]);

  if (status === "error") return <Hinweis url={url} title={title} text={FEHLER_TEXT} />;
  if (status === "loading") return <div className="relative h-full w-full"><Laden /></div>;

  const sheet = sheets[active];
  if (!sheet) return <p className="p-4 text-xs italic text-muted-foreground">Leeres Dokument.</p>;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {sheet.rows.length === 0 ? (
          <p className="p-4 text-xs italic text-muted-foreground">Leeres Blatt.</p>
        ) : (
          <table className="border-separate border-spacing-0 text-xs tabular-nums">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r border-border bg-muted" style={{ minWidth: 36 }} />
                {sheet.cols.map(({ c, letter, width }) => (
                  <th
                    key={c}
                    className="sticky top-0 z-10 border-b border-r border-border bg-muted px-2 py-1 text-center text-[10px] font-medium text-muted-foreground"
                    style={{ minWidth: width }}
                  >
                    {letter}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr key={row.r} className="h-6">
                  <th className="sticky left-0 z-10 border-b border-r border-border bg-muted px-1.5 py-1 text-right text-[10px] font-medium text-muted-foreground">
                    {row.r + 1}
                  </th>
                  {row.cells.map((cell) => cell && (
                    <td
                      key={cell.key}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      className="whitespace-pre-wrap break-words border-b border-r border-border/70 px-2 py-1 align-top"
                      style={{ textAlign: cell.align, maxWidth: 480 }}
                    >
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(sheets.length > 1 || sheet.truncated) && (
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border bg-card px-2">
          {sheets.length > 1 && sheets.map((s, i) => (
            <button
              key={`${i}-${s.name}`}
              type="button"
              onClick={() => setActive(i)}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              className="whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: i === active || i === hovered ? "var(--foreground)" : "var(--muted-foreground)",
                boxShadow: i === active ? "inset 0 -2px 0 var(--accent)" : "none",
              }}
            >
              {s.name}
            </button>
          ))}
          {sheet.truncated && (
            <span className="ml-auto whitespace-nowrap py-1.5 pl-3 text-[10px] text-muted-foreground">{sheet.truncated}</span>
          )}
        </div>
      )}
    </div>
  );
}
