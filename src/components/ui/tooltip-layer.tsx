"use client";

/**
 * TooltipLayer — die EINE globale Tooltip-Ebene der App.
 *
 * Vorher zeichnete CSS (::after) den Tooltip am Element selbst — der hing
 * damit im Stacking-Kontext/Overflow seines Containers fest und wurde von
 * Sticky-Headern verdeckt oder an Kartenraendern abgeschnitten (mehrfach
 * passiert; Leo 2026-09-19: "mache einfach, dass diese Texte immer im
 * Vordergrund sind"). Diese Komponente rendert stattdessen EIN fixed-Div
 * direkt unter <body> mit maximalem z-Index und positioniert es per
 * getBoundingClientRect:
 *  - Standard oberhalb des Elements; zu wenig Platz → automatisch unterhalb
 *    (und umgekehrt bei data-tooltip-side="bottom").
 *  - Horizontal an den Viewport geklemmt (8px Rand) — nie abgeschnitten.
 *  - data-tooltip-align="end" verankert an der rechten Elementkante.
 * API unveraendert: data-tooltip="…" (+ optionale side/align-Hints) —
 * kein Aufrufer musste angefasst werden. Versteckt bei Scroll/Klick/Leave.
 */

import { useEffect, useRef, useState } from "react";

type Tip = { text: string; x: number; y: number; below: boolean };

const GAP = 6;
const MARGIN = 8;

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function show(el: Element) {
      const text = el.getAttribute("data-tooltip");
      if (!text) return;
      anchorRef.current = el;
      const r = el.getBoundingClientRect();
      const preferBelow = el.getAttribute("data-tooltip-side") === "bottom";
      // Erst rendern (unsichtbar messen waere Overkill) — Breite wird nach
      // dem ersten Paint geklemmt; fuer die Seitenwahl reicht eine
      // Hoehenschaetzung (eine Zeile ≈ 26px inkl. Padding).
      const estH = 26;
      let below = preferBelow;
      if (!preferBelow && r.top - estH - GAP < MARGIN) below = true;
      if (preferBelow && r.bottom + estH + GAP > window.innerHeight - MARGIN && r.top - estH - GAP > MARGIN) below = false;
      const alignEnd = el.getAttribute("data-tooltip-align") === "end";
      setTip({
        text,
        x: alignEnd ? r.right : r.left + r.width / 2,
        y: below ? r.bottom + GAP : r.top - GAP,
        below,
      });
    }
    const hide = () => { anchorRef.current = null; setTip(null); };

    function onOver(e: Event) {
      const t = (e.target as Element | null)?.closest?.("[data-tooltip]");
      if (t && t !== anchorRef.current) show(t);
      else if (!t && anchorRef.current) hide();
    }
    function onFocus(e: Event) {
      const t = (e.target as Element | null)?.closest?.("[data-tooltip]");
      if (t) show(t);
    }
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("mousedown", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("mousedown", hide, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  // Nach dem Paint horizontal in den Viewport klemmen (lange Texte).
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !tip) return;
    const r = box.getBoundingClientRect();
    let dx = 0;
    if (r.left < MARGIN) dx = MARGIN - r.left;
    else if (r.right > window.innerWidth - MARGIN) dx = window.innerWidth - MARGIN - r.right;
    if (dx !== 0) box.style.transform = `translate(calc(-50% + ${dx}px), ${tip.below ? "0" : "-100%"})`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      style={{
        position: "fixed",
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
        zIndex: 20000,
        pointerEvents: "none",
        background: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "4px 8px",
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1.3,
        maxWidth: 320,
        boxShadow: "0 4px 10px -2px rgba(0,0,0,0.18)",
        whiteSpace: "pre-line",
        animation: "tooltip-fade-in 120ms ease-out",
      }}
    >
      {tip.text}
    </div>
  );
}
