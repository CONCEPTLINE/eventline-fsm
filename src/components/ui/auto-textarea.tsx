"use client";

/**
 * AutoTextarea — wächst mit dem Inhalt statt zu scrollen. Für Notizen,
 * Beschreibungen, Protokolle: kein interner Scrollbalken, sondern das
 * Textarea passt seine Höhe an.
 *
 * Muster: onInput -> style.height auf scrollHeight setzen. Läuft in allen
 * Browsern (field-sizing:content ist noch nicht überall unterstützt).
 */

import { useCallback, useEffect, useRef, forwardRef, type TextareaHTMLAttributes } from "react";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Mindesthöhe in px (default 60). Setzt eine untere Schranke, damit
   *  das Feld nicht auf 1 Zeile kollabiert wenn leer. */
  minHeight?: number;
};

export const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea(
  { minHeight = 60, className = "", value, onChange, ...rest },
  externalRef,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (typeof externalRef === "function") externalRef(el);
    else if (externalRef) externalRef.current = el;
  };

  const resize = useCallback(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(minHeight, el.scrollHeight) + "px";
  }, [minHeight]);

  // Wenn value von aussen gesetzt/geändert wird: Höhe neu berechnen
  useEffect(() => { resize(); }, [value, resize]);

  return (
    <textarea
      ref={setRefs}
      value={value}
      onChange={(e) => { onChange?.(e); resize(); }}
      style={{ minHeight, overflow: "hidden", resize: "none" }}
      className={className}
      {...rest}
    />
  );
});
