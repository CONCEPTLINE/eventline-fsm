"use client";

/**
 * Floating PDF/Bild-Vorschau — kein Modal, App bleibt bedienbar.
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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ExternalLink } from "lucide-react";

interface Props {
  url: string;
  title: string;
  onClose: () => void;
}

export function PdfPopup({ url, title, onClose }: Props) {
  const [pos, setPos] = useState(() => {
    // Default: leicht versetzt von Mitte, oben links damit Sidebar nicht
    // verdeckt wird.
    if (typeof window === "undefined") return { x: 320, y: 80 };
    return { x: Math.max(280, window.innerWidth / 2 - 350), y: 60 };
  });
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => setMounted(true), []);

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

  const popup = (
    <div
      style={{
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
      }}
      className="bg-card border border-border rounded-xl shadow-2xl flex flex-col"
    >
      <div
        onMouseDown={onHeaderMouseDown}
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/40 cursor-move select-none shrink-0"
      >
        <span className="text-sm font-medium truncate flex-1 min-w-0">{title}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          data-tooltip="In neuem Tab öffnen"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative flex-1 bg-muted/20">
        <iframe
          src={url}
          className="w-full h-full border-0"
          title={title}
        />
        {/* Overlay waehrend Drag — sonst schluckt das iframe mousemove/mouseup */}
        {dragging && <div className="absolute inset-0" />}
      </div>
    </div>
  );

  return createPortal(popup, document.body);
}
