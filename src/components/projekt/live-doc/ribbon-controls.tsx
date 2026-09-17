"use client";

/**
 * Ribbon-Bausteine fuer den WordEditor — so nah an Word wie moeglich:
 *  - TB: kleiner Werkzeug-Knopf (Hover state-driven, Tooltip unten)
 *  - RibbonDropdown: Knopf + Aufklapp-Panel (schliesst bei Klick daneben)
 *  - FontColorControl: Split-Button wie Words "Schriftfarbe" — A wendet die
 *    zuletzt gewaehlte Farbe an, der Pfeil oeffnet das Office-Farbraster
 *    (Designfarben mit Abstufungen, Standardfarben, Automatisch,
 *    "Weitere Farben…" = freier Farbwaehler)
 *  - HighlightControl: Words Textmarker-Palette (15 Farben + Keine Farbe)
 *  - LineSpacingControl: Zeilenabstand 1.0/1.15/1.5/2.0/2.5/3.0
 *
 * Farbwerte = Office-Standardtheme (Word-Original), bewusst hardcodiert.
 */

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, Highlighter, MoveVertical } from "lucide-react";

/* ── Word-Schriften & -Groessen ─────────────────────────────────── */
export const WORD_FONTS = [
  { id: "Calibri, 'Segoe UI', sans-serif", label: "Calibri" },
  { id: "'Calibri Light', 'Segoe UI Light', sans-serif", label: "Calibri Light" },
  { id: "Arial, sans-serif", label: "Arial" },
  { id: "'Arial Black', sans-serif", label: "Arial Black" },
  { id: "Cambria, Georgia, serif", label: "Cambria" },
  { id: "Candara, 'Segoe UI', sans-serif", label: "Candara" },
  { id: "'Comic Sans MS', cursive", label: "Comic Sans MS" },
  { id: "Consolas, 'Courier New', monospace", label: "Consolas" },
  { id: "Constantia, Georgia, serif", label: "Constantia" },
  { id: "Corbel, 'Segoe UI', sans-serif", label: "Corbel" },
  { id: "'Courier New', monospace", label: "Courier New" },
  { id: "'Franklin Gothic Medium', 'Arial Narrow', sans-serif", label: "Franklin Gothic" },
  { id: "Garamond, 'Times New Roman', serif", label: "Garamond" },
  { id: "Georgia, serif", label: "Georgia" },
  { id: "Impact, 'Arial Black', sans-serif", label: "Impact" },
  { id: "'Segoe UI', sans-serif", label: "Segoe UI" },
  { id: "Tahoma, Verdana, sans-serif", label: "Tahoma" },
  { id: "'Times New Roman', Times, serif", label: "Times New Roman" },
  { id: "'Trebuchet MS', sans-serif", label: "Trebuchet MS" },
  { id: "Verdana, sans-serif", label: "Verdana" },
];

export const WORD_SIZES = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "22", "24", "26", "28", "36", "48", "72"];

/* ── Office-Farbraster (Word-Standardtheme) ─────────────────────── */
// 10 Designfarben, darunter je 5 Abstufungen (hell → dunkel), wie Word.
const THEME_COLUMNS: string[][] = [
  ["#FFFFFF", "#F2F2F2", "#D9D9D9", "#BFBFBF", "#A6A6A6", "#808080"],
  ["#000000", "#808080", "#595959", "#404040", "#262626", "#0D0D0D"],
  ["#E7E6E6", "#D0CECE", "#AEAAAA", "#757171", "#3B3838", "#181717"],
  ["#44546A", "#D6DCE5", "#ACB9CA", "#8496B0", "#333F50", "#222B35"],
  ["#4472C4", "#DAE3F3", "#B4C7E7", "#8FAADC", "#2F5597", "#1F3864"],
  ["#ED7D31", "#FBE5D6", "#F8CBAD", "#F4B183", "#C55A11", "#843C0C"],
  ["#A5A5A5", "#EDEDED", "#DBDBDB", "#C9C9C9", "#7B7B7B", "#525252"],
  ["#FFC000", "#FFF2CC", "#FFE699", "#FFD966", "#BF9000", "#7F6000"],
  ["#5B9BD5", "#DEEBF7", "#BDD7EE", "#9DC3E6", "#2E75B6", "#1F4E79"],
  ["#70AD47", "#E2EFDA", "#C6E0B4", "#A9D18E", "#548235", "#385723"],
];

const STANDARD_COLORS = ["#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];

// Words Textmarker-Farben (15) — kraeftig, deckend.
const HIGHLIGHT_COLORS = [
  "#FFFF00", "#00FF00", "#00FFFF", "#FF00FF", "#0000FF",
  "#FF0000", "#000080", "#008080", "#008000", "#800080",
  "#800000", "#808000", "#808080", "#C0C0C0", "#000000",
];

/* ── TB: Werkzeug-Knopf ─────────────────────────────────────────── */
/** Tooltip IMMER nach unten: nach oben laege er unter der Kopfleiste
 *  (deren Sticky-Kontext z-30 schlaegt das z-50 des Tooltips im z-20-Ribbon). */
export function TB({ onClick, active, disabled, tooltip, children }: {
  onClick: () => void; active?: boolean; disabled?: boolean; tooltip: string; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tooltip={tooltip}
      data-tooltip-side="bottom"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="p-1.5 rounded-md disabled:opacity-35"
      style={{
        background: active ? "rgba(47,84,150,0.16)" : hover && !disabled ? "rgba(0,0,0,0.07)" : "transparent",
        color: active ? "#2F5496" : undefined,
      }}
    >
      {children}
    </button>
  );
}

/* ── RibbonDropdown: Knopf + Panel ──────────────────────────────── */
export function RibbonDropdown({ tooltip, button, children, panelClassName }: {
  tooltip: string;
  button: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-tooltip={tooltip}
        data-tooltip-side="bottom"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="p-1.5 rounded-md flex items-center"
        style={{ background: open ? "rgba(47,84,150,0.16)" : hover ? "rgba(0,0,0,0.07)" : "transparent" }}
      >
        {button}
        <ChevronDown className="h-3 w-3 ml-0.5 opacity-60" />
      </button>
      {open && (
        <div className={`absolute top-full left-0 mt-1 z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-xl p-2 ${panelClassName ?? ""}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/* ── Farb-Kaestchen ─────────────────────────────────────────────── */
function Swatch({ color, onPick, size = 16 }: { color: string; onPick: (c: string) => void; size?: number }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onPick(color)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={color}
      style={{
        width: size, height: size, background: color,
        border: hover ? "2px solid #E8A33D" : "1px solid rgba(0,0,0,0.25)",
        borderRadius: 2,
      }}
    />
  );
}

/* ── Schriftfarbe (Split-Button + Office-Raster) ────────────────── */
export function FontColorControl({ editor }: { editor: Editor }) {
  const [lastColor, setLastColor] = useState("#C00000"); // Word-Default: Rot
  const [hoverA, setHoverA] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  const apply = (c: string, close?: () => void) => {
    setLastColor(c);
    editor.chain().focus().setColor(c).run();
    close?.();
  };

  return (
    <div className="flex items-center">
      {/* Linke Haelfte: zuletzt gewaehlte Farbe direkt anwenden (wie Word) */}
      <button
        type="button"
        data-tooltip="Schriftfarbe"
        data-tooltip-side="bottom"
        onClick={() => apply(lastColor)}
        onMouseEnter={() => setHoverA(true)}
        onMouseLeave={() => setHoverA(false)}
        className="p-1.5 pr-0.5 rounded-l-md"
        style={{ background: hoverA ? "rgba(0,0,0,0.07)" : "transparent" }}
      >
        <span className="block text-[13px] font-bold leading-none px-0.5" style={{ color: "#111" }}>A</span>
        <span className="block h-[3px] mt-0.5 rounded-sm mx-0.5" style={{ background: lastColor }} />
      </button>
      <RibbonDropdown tooltip="Weitere Schriftfarben" button={<span className="sr-only">Farbraster</span>} panelClassName="w-[228px]">
        {(close) => (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => { editor.chain().focus().unsetColor().run(); setLastColor("#000000"); close(); }}
              className="w-full text-left text-[12px] px-1.5 py-1 rounded hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14] flex items-center gap-2"
            >
              <span className="inline-block h-4 w-4 rounded-sm border border-border" style={{ background: "#000" }} /> Automatisch
            </button>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Designfarben</p>
              <div className="flex gap-[5px]">
                {THEME_COLUMNS.map((col, i) => (
                  <div key={i} className="flex flex-col gap-[5px]">
                    {col.map((c, j) => <Swatch key={j} color={c} onPick={(x) => apply(x, close)} />)}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Standardfarben</p>
              <div className="flex gap-[5px]">
                {STANDARD_COLORS.map((c) => <Swatch key={c} color={c} onPick={(x) => apply(x, close)} />)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => customRef.current?.click()}
              className="w-full text-left text-[12px] px-1.5 py-1 rounded hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
            >
              Weitere Farben…
            </button>
            <input
              ref={customRef}
              type="color"
              className="sr-only"
              value={lastColor}
              onChange={(e) => apply(e.target.value, close)}
            />
          </div>
        )}
      </RibbonDropdown>
    </div>
  );
}

/* ── Textmarker (Word-Palette) ──────────────────────────────────── */
export function HighlightControl({ editor }: { editor: Editor }) {
  const [lastColor, setLastColor] = useState("#FFFF00"); // Word-Default: Gelb
  const [hoverA, setHoverA] = useState(false);
  const active = editor.isActive("highlight");

  const apply = (c: string, close?: () => void) => {
    setLastColor(c);
    editor.chain().focus().setHighlight({ color: c }).run();
    close?.();
  };

  return (
    <div className="flex items-center">
      <button
        type="button"
        data-tooltip="Texthervorhebungsfarbe"
        data-tooltip-side="bottom"
        onClick={() => (active ? editor.chain().focus().unsetHighlight().run() : apply(lastColor))}
        onMouseEnter={() => setHoverA(true)}
        onMouseLeave={() => setHoverA(false)}
        className="p-1.5 pr-0.5 rounded-l-md"
        style={{ background: active ? "rgba(47,84,150,0.16)" : hoverA ? "rgba(0,0,0,0.07)" : "transparent" }}
      >
        <Highlighter className="h-4 w-4" />
        <span className="block h-[3px] mt-0.5 rounded-sm" style={{ background: lastColor }} />
      </button>
      <RibbonDropdown tooltip="Weitere Markerfarben" button={<span className="sr-only">Markerfarben</span>} panelClassName="w-[132px]">
        {(close) => (
          <div className="space-y-2">
            <div className="grid grid-cols-5 gap-[5px]">
              {HIGHLIGHT_COLORS.map((c) => <Swatch key={c} color={c} onPick={(x) => apply(x, close)} size={18} />)}
            </div>
            <button
              type="button"
              onClick={() => { editor.chain().focus().unsetHighlight().run(); close(); }}
              className="w-full text-left text-[12px] px-1.5 py-1 rounded hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
            >
              Keine Farbe
            </button>
          </div>
        )}
      </RibbonDropdown>
    </div>
  );
}

/* ── Zeilenabstand ──────────────────────────────────────────────── */
const LINE_SPACINGS = ["1.0", "1.15", "1.5", "2.0", "2.5", "3.0"];

export function LineSpacingControl({ editor }: { editor: Editor }) {
  return (
    <RibbonDropdown tooltip="Zeilenabstand" button={<MoveVertical className="h-4 w-4" />} panelClassName="w-28">
      {(close) => (
        <div>
          {LINE_SPACINGS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { editor.chain().focus().setLineHeight(s === "1.0" ? "1" : s).run(); close(); }}
              className="w-full text-left text-[12px] px-1.5 py-1 rounded hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { editor.chain().focus().unsetLineHeight().run(); close(); }}
            className="w-full text-left text-[12px] px-1.5 py-1 rounded hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14] border-t border-border mt-1 pt-1.5"
          >
            Standard
          </button>
        </div>
      )}
    </RibbonDropdown>
  );
}
