"use client";

/**
 * Floating Dokument-Vorschau (PDF, Bild, Word, Excel) — kein Modal, App bleibt
 * bedienbar.
 *
 * - Typ wird an der Dateiendung erkannt (Titel, sonst URL-Pfad): PDF via
 *   iframe (Desktop) bzw. pdf.js (Mobile), Bilder via <img>, Office-Dateien
 *   via OfficeViewer (docx-preview / SheetJS, rein im Browser — kein
 *   externer Viewer). Es wird nie ein Download ausgeloest.
 *
 * - Title-Bar ist Drag-Handle (cursor:move). Mouse-Down auf Header startet
 *   Drag, danach folgt das Panel der Maus bis Mouse-Up.
 * - Resize via CSS `resize: both` in der unteren rechten Ecke (Browser-
 *   nativ, keine eigene Logic).
 * - Iframe schluckt sonst Mouse-Events bei Drag — waehrend dem Drag legen
 *   wir ein transparentes Overlay drueber das die Events abfaengt.
 * - Mehrere Popups gleichzeitig moeglich (jede Page haelt eigene State).
 *
 * Verwendung:
 *   const [pdf, setPdf] = useState<{url: string; title: string} | null>(null);
 *   ...onClick={() => setPdf({url, title})}
 *   {pdf && <PdfPopup url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { X, ExternalLink, Download, Loader2 } from "lucide-react";

// pdf.js nur auf Mobile + lazy laden, damit es nicht ins Haupt-Bundle wandert.
const PdfMobileViewer = dynamic(() => import("./pdf-mobile-viewer"), { ssr: false });
// Office-Vorschau (docx-preview + SheetJS) ebenfalls lazy — nur wenn eine
// Word-/Excel-Datei geoeffnet wird.
const OfficeViewer = dynamic(() => import("./office-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  ),
});

type PreviewKind = "image" | "docx" | "sheet" | "office-unsupported" | "html" | "default";
/** Erkannter Typ plus die Endung (klein, ohne Punkt), an der er erkannt wurde —
 *  der OfficeViewer braucht sie (CSV vs. Excel), damit nicht zweimal geraten wird. */
type Erkannt = { kind: PreviewKind; ext: string };

function kindFromName(name: string): Erkannt {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (/^(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(ext)) return { kind: "image", ext };
  if (/^(docx|docm|dotx)$/.test(ext)) return { kind: "docx", ext };
  if (/^(xlsx|xlsm|xlsb|xls|csv|ods)$/.test(ext)) return { kind: "sheet", ext };
  // Office-Formate ohne Browser-Renderer: Hinweis + Herunterladen statt
  // leerem Popup (der Browser wuerde die Datei sonst still herunterladen).
  if (/^(doc|dot|rtf|odt|ppt|pptx|pps|ppsx|pot|potx|odp)$/.test(ext)) return { kind: "office-unsupported", ext };
  // HTML-Visualisierung (3D-Modell o.ae.) — URL zeigt auf /api/visualisierung/[id].
  if (/^html?$/.test(ext)) return { kind: "html", ext };
  return { kind: "default", ext };
}

/** Vorschau-Typ: zuerst am Titel (Dateiname), sonst am Pfad der URL. */
function previewKind(title: string, url: string): Erkannt {
  const byTitle = kindFromName(title);
  if (byTitle.kind !== "default") return byTitle;
  try {
    return kindFromName(new URL(url, window.location.href).pathname);
  } catch {
    return { kind: "default", ext: "" };
  }
}

interface Props {
  url: string;
  title: string;
  onClose: () => void;
}

// Client-only-Zustand ohne setState-im-Effect (react-hooks/set-state-in-effect):
// Server-Snapshot = false, im Browser true → Portal erst nach der Hydration.
const noopSubscribe = () => () => {};
function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

export function PdfPopup({ url, title, onClose }: Props) {
  const [pos, setPos] = useState(() => {
    // Default: leicht versetzt von Mitte, oben links damit Sidebar nicht
    // verdeckt wird.
    if (typeof window === "undefined") return { x: 320, y: 80 };
    return { x: Math.max(280, window.innerWidth / 2 - 350), y: 60 };
  });
  const [dragging, setDragging] = useState(false);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // Auf Mobile fuellt das Popup den ganzen Screen (Fixed-Panel mit
  // left/width ragt sonst aus dem schmalen Viewport raus -> abgeschnitten
  // und nicht bedienbar). Drag/Resize sind auf Touch eh sinnlos.
  const isMobile = useSyncExternalStore(subscribeResize, () => window.innerWidth < 640, () => false);
  const dragOffset = useRef({ x: 0, y: 0 });

  function onHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return; // Buttons im Header ignorieren
    setDragging(true);
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dragOffset.current.y)),
      });
    }
    function onUp() { setDragging(false); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Escape schliesst — convenience
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  const { kind, ext } = previewKind(title, url);
  const isOffice = kind === "docx" || kind === "sheet" || kind === "office-unsupported";

  const popup = (
    <div
      style={
        isMobile
          ? {
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              width: "100%",
              height: "100dvh",
              overflow: "hidden",
              zIndex: 1400,
            }
          : {
              position: "fixed",
              left: pos.x,
              top: pos.y,
              width: 700,
              height: 850,
              minWidth: 360,
              minHeight: 240,
              maxWidth: "95vw",
              maxHeight: "92vh",
              resize: "both",
              overflow: "hidden",
              zIndex: 1400,
            }
      }
      className={`bg-card border border-border shadow-2xl flex flex-col ${isMobile ? "" : "rounded-xl"}`}
    >
      <div
        onMouseDown={isMobile ? undefined : onHeaderMouseDown}
        className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/40 select-none shrink-0 ${isMobile ? "" : "cursor-move"}`}
        // Auf Mobile sitzt der Header sonst unter der iOS-Notch/Statusleiste
        // (viewportFit:cover + black-translucent im Layout) -> X unsichtbar.
        // Safe-Area-Inset oben dazurechnen, damit der Schliessen-Button frei liegt.
        style={isMobile ? { paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" } : undefined}
      >
        <span className="text-sm font-medium truncate flex-1 min-w-0">{title}</span>
        {/* Office-Dateien kann der Browser nicht selbst anzeigen — der Link
            in den neuen Tab ist dort faktisch ein Download, also auch so
            beschriften. */}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          download={isOffice ? title : undefined}
          className={`rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ${isMobile ? "p-2" : "p-1"}`}
          data-tooltip={isOffice ? "Herunterladen" : "In neuem Tab öffnen"}
          aria-label={isOffice ? "Herunterladen" : "In neuem Tab öffnen"}
        >
          {isOffice
            ? <Download className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
            : <ExternalLink className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />}
        </a>
        <button
          type="button"
          onClick={onClose}
          className={`rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ${isMobile ? "p-2 -mr-1" : "p-1"}`}
          aria-label="Schliessen"
        >
          <X className={isMobile ? "h-6 w-6" : "h-4 w-4"} />
        </button>
      </div>
      <div
        className="relative flex-1 bg-muted/20 overflow-auto"
        // Unten Safe-Area (Home-Indicator) freihalten, damit der letzte
        // Teil des Dokuments nicht hinter der Leiste klemmt.
        style={isMobile ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
      >
        {/* Bilder: <img> mit max-width:100%, passt sich der Popup-Breite an.
            Office (Word/Excel): OfficeViewer rendert im Browser; .doc/.pptx
            & Co. bekommen dort einen Hinweis mit Download-Knopf.
            PDFs auf Mobile: eigener PDF.js-Viewer (das native iframe zeigt
            dort nur Seite 1 und laesst sich nicht zoomen). PDFs auf Desktop:
            iframe (Browser-PDF-Viewer mit Toolbar funktioniert dort gut). */}
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={title}
            className="block max-w-full h-auto mx-auto"
          />
        ) : isOffice ? (
          <OfficeViewer
            key={url}
            url={url}
            title={title}
            ext={ext}
            kind={kind === "office-unsupported" ? "unsupported" : kind}
          />
        ) : kind === "html" ? (
          // Zusaetzlich zum CSP-Sandbox der Route: iframe-Sandbox ohne
          // allow-same-origin — die Seite bleibt vom App-Ursprung getrennt.
          <iframe
            src={url}
            sandbox="allow-scripts"
            allow="fullscreen"
            className="w-full h-full border-0"
            title={title}
          />
        ) : isMobile ? (
          <PdfMobileViewer url={url} />
        ) : (
          <iframe
            src={url}
            className="w-full h-full border-0"
            title={title}
          />
        )}
        {/* Overlay waehrend Drag — sonst schluckt das iframe mousemove/mouseup */}
        {dragging && <div className="absolute inset-0" />}
      </div>
    </div>
  );

  return createPortal(popup, document.body);
}
