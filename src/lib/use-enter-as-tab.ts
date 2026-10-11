"use client";

/**
 * Globaler Hook: Enter im Input/Select/Textarea springt zum nächsten fokussierbaren
 * Element im selben Form, statt das Form zu submitten.
 *
 * Verhalten:
 *   - Enter (ohne Modifier) → springt zum nächsten Feld
 *   - Shift+Enter           → newline in Textareas (Standard-Editor-Verhalten)
 *   - Ctrl/Cmd/Alt+Enter    → durchgereicht (z.B. "Send via Ctrl+Enter")
 *
 * Ausnahmen (Enter behält normales Verhalten):
 *   - <button>               → click
 *   - input[type=button|submit|checkbox|radio|...]
 *   - Wenn ein Element-eigener Handler bereits e.preventDefault() gerufen hat
 *     (z.B. Combobox-Komponenten, die Enter für "Vorschlag auswählen" nutzen)
 *   - <textarea> am Handy, wenn `zeilenumbruchAmHandy` gesetzt ist: die
 *     Handy-Tastatur hat kein Shift+Enter, Enter macht dort den Zeilenumbruch
 *     (sonst sprang der Fokus mitten im Tippen ins nächste Feld). Desktop
 *     (>= 768 px) unverändert.
 *
 * In einem `(app)/layout.tsx` einmal aufrufen — gilt dann app-weit.
 */

import { useEffect } from "react";
import { MOBILE_MEDIA_QUERY } from "@/lib/use-is-mobile";

const NON_INTERCEPTED_INPUT_TYPES = new Set([
  "button",
  "submit",
  "checkbox",
  "radio",
  "image",
  "reset",
  "file",
]);

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetParent || el.getClientRects().length);
}

interface EnterAsTabOptionen {
  /** Enter in <textarea> am Handy (MOBILE_MEDIA_QUERY) = Zeilenumbruch.
   *  Opt-in, damit die Portale (eigene Layouts) unverändert bleiben. */
  zeilenumbruchAmHandy?: boolean;
}

export function useEnterAsTab({ zeilenumbruchAmHandy = false }: EnterAsTabOptionen = {}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      // Custom-Komponente hat Enter schon gehandhabt (Combobox-Auswahl etc.)
      if (e.defaultPrevented) return;
      // Shift+Enter: newline in Textareas erlauben (Standard-Editor-Verhalten)
      if (e.shiftKey) return;
      // Ctrl/Cmd/Alt+Enter durchlassen (z.B. "Send via Ctrl+Enter")
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;

      if (tag === "BUTTON") return;
      if (tag === "INPUT") {
        const inputType = (target as HTMLInputElement).type;
        if (NON_INTERCEPTED_INPUT_TYPES.has(inputType)) return;
      } else if (tag === "TEXTAREA") {
        // Am Handy: Enter = Zeilenumbruch (Breite beim Tastendruck lesen —
        // Drehen/Fenstergrösse kann sich seit dem Mount geändert haben).
        if (zeilenumbruchAmHandy && window.matchMedia(MOBILE_MEDIA_QUERY).matches) return;
      } else if (tag !== "SELECT") {
        // andere Elemente (z.B. divs mit contentEditable) ignorieren wir hier
        return;
      }

      e.preventDefault();

      // Suche nächstes fokussierbares Element im selben Form (oder, falls keins,
      // im selben Document)
      const scope: Element = target.closest("form") ?? document.body;
      const focusables = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
        )
      ).filter(
        (el) =>
          !(el as HTMLInputElement).disabled &&
          el.tabIndex !== -1 &&
          isVisible(el)
      );

      const idx = focusables.indexOf(target);
      if (idx >= 0 && idx < focusables.length - 1) {
        focusables[idx + 1].focus();
      } else {
        // Letztes Feld: einfach blurren statt zu submitten
        target.blur();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [zeilenumbruchAmHandy]);
}
