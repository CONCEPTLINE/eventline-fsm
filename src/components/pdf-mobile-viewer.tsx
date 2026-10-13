"use client";

/**
 * Mobile-PDF-Viewer auf Basis von react-pdf (PDF.js).
 *
 * Warum nicht das <iframe> wie auf Desktop? Auf iOS/Android zeigt ein
 * iframe mit PDF-Quelle nur die ERSTE Seite und laesst sich nicht sinnvoll
 * zoomen/scrollen — man muss horizontal "herumschweben". Hier rendern wir
 * jede Seite selbst auf Canvas, breiten-angepasst (passt per Default exakt
 * in die Mobil-Breite) und mit Zoom-Buttons.
 *
 * Wird nur lazy auf Mobile geladen (next/dynamic, ssr:false in pdf-popup),
 * damit pdf.js nicht ins Haupt-Bundle wandert.
 */

import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { ZoomIn, ZoomOut, Loader2, AlertTriangle, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/ui/empty-state";
import { useOnline } from "@/lib/offline/sync-trigger";

// Worker lokal aus dem Bundle (kein externes CDN — robust & offline-fest).
// Er MUSS exakt die pdfjs-Version sein, die react-pdf intern benutzt, sonst
// bricht pdf.js jedes Laden ab («API version … does not match the Worker
// version …»). react-pdf pinnt seine eigene pdfjs-dist (10.4.1 → 5.4.296),
// npm legt sie darum verschachtelt unter react-pdf/node_modules ab. Das
// oberste pdfjs-dist (6.x: NAS-Vorschaubilder, Plan-Unterlagen, ladePdfjs())
// passt NICHT — ein nackter "pdfjs-dist/…"-Pfad wuerde von hier aus genau
// dort landen. Deshalb der relative Pfad direkt auf react-pdfs eigene Kopie.
// Die Worker-Einstellung gilt nur fuer diese pdfjs-Instanz; die anderen
// pdfjs-Nutzer setzen ihre eigene. Verlangen react-pdf und das oberste
// pdfjs-dist einmal dieselbe Version, entfaellt die verschachtelte Kopie und
// der Build findet die Datei nicht mehr → dann hier wieder
// "pdfjs-dist/build/pdf.worker.min.mjs" eintragen.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "../../node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

export default function PdfMobileViewer({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [numPages, setNumPages] = useState(0);
  // URL, deren Laden zuletzt scheiterte — an die URL gebunden, damit ein
  // anderes Dokument die alte Fehlermeldung nicht erbt.
  const [fehlerUrl, setFehlerUrl] = useState<string | null>(null);
  // «Erneut versuchen» zaehlt hoch → neuer key, <Document> laedt frisch.
  const [versuch, setVersuch] = useState(0);
  const online = useOnline();
  const error = fehlerUrl === url;

  // Fehler nie still schlucken: echte Ursache in die Konsole (Worker,
  // abgelaufener Link, kaputte Datei …), der Nutzer bekommt Toast + Ausweg.
  function onLadeFehler(err: Error) {
    console.error("PDF-Vorschau (Mobile):", err);
    setFehlerUrl(url);
    toast.error("PDF-Vorschau konnte nicht geladen werden");
  }

  function erneutVersuchen() {
    setNumPages(0);
    setFehlerUrl(null);
    setVersuch((v) => v + 1);
  }

  // Verfuegbare Breite messen (und bei Rotation/Resize aktualisieren), damit
  // die Seiten exakt in den Viewport passen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Seitenbreite = volle Breite * Zoom, minus etwas Polster.
  const pageWidth = containerWidth > 0 ? Math.floor((containerWidth - 16) * zoom) : undefined;

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full overflow-auto bg-muted/30 flex flex-col items-center py-2"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {error ? (
          <div className="flex h-full w-full items-center justify-center px-4">
            <EmptyState
              icon={AlertTriangle}
              title="PDF konnte nicht geladen werden"
              description={
                online
                  ? "Erneut versuchen oder das PDF im Browser öffnen."
                  : "Keine Verbindung — sobald du wieder online bist, erneut versuchen."
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={erneutVersuchen}
                    className="kasten kasten-muted h-[34px] px-5 text-[13px]"
                  >
                    <RefreshCw className="h-4 w-4" /> Erneut versuchen
                  </button>
                  {/* Signierter Link im neuen Tab — der Browser-eigene Viewer
                      als Ausweg, falls pdf.js hier scheitert. */}
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="kasten kasten-muted h-[34px] px-5 text-[13px]"
                  >
                    <ExternalLink className="h-4 w-4" /> Im Browser öffnen
                  </a>
                </div>
              }
            />
          </div>
        ) : (
          <Document
            key={versuch}
            file={url}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={onLadeFehler}
            onSourceError={onLadeFehler}
            loading={
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            }
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i}
                pageNumber={i + 1}
                width={pageWidth}
                // Text-/Annotation-Layer aus: wir brauchen reine Darstellung,
                // das spart CSS-Setup und ist deutlich schneller.
                renderTextLayer={false}
                renderAnnotationLayer={false}
                className="mb-2 shadow-sm"
              />
            ))}
          </Document>
        )}
      </div>

      {/* Zoom-Steuerung — schwebt unten rechts, immer erreichbar. */}
      {numPages > 0 && !error && (
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-card/95 border border-border shadow-lg px-1 py-1 backdrop-blur">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.25) * 100) / 100))}
            disabled={zoom <= MIN_ZOOM}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
            aria-label="Verkleinern"
          >
            <ZoomOut className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="px-2 text-xs font-medium tabular-nums text-muted-foreground min-w-[3rem]"
            aria-label="Zoom zurücksetzen"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.25) * 100) / 100))}
            disabled={zoom >= MAX_ZOOM}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
            aria-label="Vergrößern"
          >
            <ZoomIn className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
