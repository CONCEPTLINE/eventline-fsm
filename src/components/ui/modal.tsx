"use client";

// Eine zentrale Modal-Komponente fuer die ganze App.
// Vorher: 30+ inline-Modal-Pattern mit fixed inset-0, z-[60]/z-[70], backdrop-blur.
// Jeder hatte leichte Abweichungen (z-Index, Klick-Handler, Esc-Behandlung)
// — Konsistenz-Risiko. Diese Komponente kapselt:
//   * Backdrop (z-1100) mit Klick-zu-Schliessen
//   * Panel (z-1110) mit max-width + bg-card + Border
//   * Header mit Titel + X-Schliessen-Button (optional)
//   * Esc-Taste schliesst (wenn nicht disabled)
//   * A11y: role="dialog" aria-modal, focus-trap innerhalb des Panels,
//     Focus-Restore auf den vorher fokussierten Trigger beim Schliessen
//   * Scrollbar-Kompensation beim Body-Scroll-Lock damit der Content
//     nicht um die Scrollbar-Breite springt wenn das Modal aufgeht
//   * Render via Portal an document.body — damit kein Ancestor-Stacking-Context den
//     Backdrop einschraenkt (war ein Bug bei der mobilen Sidebar).
//
// Verwendung:
//   <Modal open={...} onClose={...} title="Stornieren?">
//     <p>...</p>
//     <div className="flex gap-2 pt-2">
//       <button className="kasten kasten-muted flex-1" onClick={onClose}>Abbrechen</button>
//       <button className="kasten kasten-red flex-1" onClick={confirm}>Bestätigen</button>
//     </div>
//   </Modal>

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface ModalProps {
  open: boolean;
  /** Wird gerufen wenn Backdrop geklickt, X-Button oder Esc gedrueckt wird.
   *  Falls disabled (z.B. waehrend Saving), Schliessen ueber `closable=false` blocken. */
  onClose: () => void;
  title?: string;
  /** Header-Icon links vom Titel (z.B. <Send className="h-5 w-5 text-blue-500" />) */
  icon?: React.ReactNode;
  /** Default 'sm' (max-w-sm). 'md' fuer Formulare, 'lg' fuer breitere Inhalte,
   *  'xl'/'2xl'/'3xl'/'4xl' fuer Chip-Grids/Matrix-Layouts (z.B. Rollen-Modal). */
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
  /** Default true. Wenn false, klick auf Backdrop + Esc + X tun nichts. Fuer
   *  Saving-States verwenden, damit der User nicht versehentlich abbricht. */
  closable?: boolean;
  /** Am Handy (< md) als Bottom-Sheet: volle Breite, unten angedockt, Griff
   *  oben, Safe-Area unten. Ab md exakt wie bisher (zentriert). Opt-in —
   *  bestehende Aufrufer bleiben unveraendert. Reine CSS-Weiche, kein JS. */
  sheet?: boolean;
  /** Klassen des Inhalts-Bereichs (Default `p-6 space-y-4`). Fuer Listen
   *  randbuendig: `p-0`. */
  bodyClassName?: string;
  /** Zugaenglicher Name, wenn kein `title` gerendert wird (Sheets ohne
   *  Kopfzeile wie das Mehr-Menue). */
  ariaLabel?: string;
  children: React.ReactNode;
}

const SIZE_CLASS = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
} as const;

// Sheet-Variante: am Handy keine max-Breite (max-w-sm = 384 px waere auf
// 390 px ein 3-px-Rand), ab md die normale Groesse. Literale Strings, damit
// Tailwind die md:-Klassen findet.
const SIZE_CLASS_SHEET = {
  sm: "max-w-none md:max-w-sm",
  md: "max-w-none md:max-w-md",
  lg: "max-w-none md:max-w-lg",
  xl: "max-w-none md:max-w-xl",
  "2xl": "max-w-none md:max-w-2xl",
  "3xl": "max-w-none md:max-w-3xl",
  "4xl": "max-w-none md:max-w-4xl",
} as const;

// Focusable-Selector fuer den Focus-Trap. Deckt die gaengigen Interaktive
// Elemente ab; tabindex=-1 bleibt aussen vor (ist explizit "nicht fokussierbar
// via Tab").
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({ open, onClose, title, icon, size = "sm", closable = true, sheet = false, bodyClassName = "p-6 space-y-4", ariaLabel, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Ref auf das Element das VOR dem Oeffnen den Fokus hatte — damit wir
  // beim Schliessen den Fokus dorthin zurueckgeben (a11y-Restore).
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Begann der Pointer-Druck auf der freien Flaeche neben dem Sheet?
  const downFrei = useRef(false);
  const titleId = useId();

  // Esc schliesst (wenn closable). Listener nur registriert solange offen,
  // damit kein Memory-Leak bei vielen Modal-Instanzen.
  useEffect(() => {
    if (!open || !closable) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, closable, onClose]);

  // Body-Scroll lockt waehrend Modal offen ist — verhindert dass User
  // den Hintergrund parallel zum Modal scrollt. Sowohl <body> als auch
  // <html> werden gelockt, weil je nach Layout-Kette die Scroll-Quelle
  // unterschiedlich sein kann (Body in Next.js, HTML in iOS-Safari etc).
  //
  // Scrollbar-Kompensation: wenn eine Scrollbar sichtbar ist, ersetzen
  // wir sie beim Lock durch einen padding-right am Body, sonst springen
  // Header / fixed-elements um die Scrollbar-Breite nach rechts wenn das
  // Modal aufgeht (in Chrome/Firefox auf Windows/Linux ~15px).
  useEffect(() => {
    if (!open) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      document.body.style.paddingRight = prevPad;
    };
  }, [open]);

  // Focus-Management: initial-Fokus ins Panel setzen (erstes fokussierbares
  // Element oder das Panel selbst); beim Schliessen zurueck auf den Trigger.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null;
    // Timeout auf 0 damit das Portal-DOM tatsaechlich gemountet ist bevor
    // wir focus() rufen.
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  // Focus-Trap: Tab / Shift-Tab am Rand des Panels zirkuliert innerhalb.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const handleBackdrop = () => {
    if (closable) onClose();
  };

  return createPortal(
    <>
      {/* z-Indices ueber Leaflet-Default-Stack (Map-Controls bei 1000):
          sonst sitzt z.B. die Schweizer Karte ueber dem Modal-Backdrop
          und wuerde nicht geblurrt werden. */}
      <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur" onClick={handleBackdrop} />
      {/* Der Panel-Container liegt inset-0 UEBER dem Backdrop und faengt
          Klicks neben dem Panel ab. Nur beim Sheet schliesst ein Tipp auf
          die freie Flaeche — und nur, wenn auch der Druck dort begann: eine
          Textauswahl, die ueber den Panel-Rand gezogen wird, landet sonst
          als click auf dem Container und wuerde das Formular verwerfen.
          Ohne sheet (Desktop, Portale) bleibt das Modal wie bisher offen. */}
      <div
        className={`fixed inset-0 z-[1110] flex justify-center ${sheet ? "items-end p-0 md:items-center md:p-4" : "items-center p-4"}`}
        onPointerDown={sheet ? (e) => { downFrei.current = e.target === e.currentTarget; } : undefined}
        onClick={sheet ? (e) => { if (downFrei.current && e.target === e.currentTarget) handleBackdrop(); downFrei.current = false; } : undefined}
      >
        {/* max-h-[90vh] + overflow-y-auto am Body damit lange Inhalte auf
            kleinen Screens scrollbar bleiben statt unter dem Fold zu verschwinden.
            Header bleibt sichtbar (sticky-ish per flex-shrink-0).
            Sheet-Variante (Handy): unten angedockt, oben rund, Griff, Safe-Area
            unten; dvh statt vh, weil iOS-Safari 100vh hinter der Adressleiste
            versteckt. */}
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-label={!title && ariaLabel ? ariaLabel : undefined}
          tabIndex={-1}
          className={
            sheet
              ? `bg-card rounded-t-2xl md:rounded-2xl shadow-2xl w-full ${SIZE_CLASS_SHEET[size]} overflow-hidden border max-h-[92dvh] md:max-h-[90vh] pb-[env(safe-area-inset-bottom)] md:pb-0 flex flex-col focus:outline-none`
              : `bg-card rounded-2xl shadow-2xl w-full ${SIZE_CLASS[size]} overflow-hidden border max-h-[90vh] flex flex-col focus:outline-none`
          }
        >
          {sheet && (
            <div className="md:hidden flex justify-center pt-2.5 pb-0.5 shrink-0" aria-hidden="true">
              <span className="block w-9 h-1 rounded-full bg-foreground/20" />
            </div>
          )}
          {(title || icon) && (
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <div className="flex items-center gap-2">
                {icon}
                {title && <h2 id={titleId} className="font-semibold">{title}</h2>}
              </div>
              {closable && (
                <button
                  type="button"
                  onClick={onClose}
                  className={`rounded-lg hover:bg-muted transition-colors ${sheet ? "inline-flex h-[44px] w-[44px] items-center justify-center -mr-3 md:h-auto md:w-auto md:p-1.5 md:mr-0" : "p-1.5"}`}
                  aria-label="Schließen"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>
          )}
          <div className={`${bodyClassName} overflow-y-auto`}>{children}</div>
        </div>
      </div>
    </>,
    document.body,
  );
}
