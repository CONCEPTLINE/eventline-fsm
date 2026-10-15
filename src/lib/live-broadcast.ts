/**
 * Helpers fuer die Live-Uebertragung im Developer-Mode.
 *
 * Kanal-Layout:
 *   live:<target_user_id> — Admin published, target-User subscribed.
 *   Privater Kanal (Migration 341): beitreten nur das Konto selbst und ein
 *   Admin mit Entwickler-Modus, senden nur dieser Admin.
 *
 * Events (broadcast payloads):
 *   session:start    { admin_name }        — Live-Session gestartet
 *   session:end      {}                    — Live-Session beendet
 *   session:heartbeat{}                    — alle 5s, damit User merkt wenn Admin's Tab weg ist
 *   cursor           { x, y }              — Viewport-Koordinaten (throttled ~50ms)
 *   click            { x, y, sel }         — Klick-Ereignis
 *   input            { sel, value }        — Form-Input geaendert
 *   focus            { sel }               — Fokus-Wechsel
 *   scroll           { sy, sx }            — Window-Scroll
 *   nav              { path }              — Route-Wechsel (window.location.pathname)
 */

export const LIVE_CHANNEL_PREFIX = "live:";
export const LIVE_HEARTBEAT_MS = 5000;
export const LIVE_HEARTBEAT_TIMEOUT_MS = 12000; // 2.4x heartbeat — vergisst Session wenn Tab weg
export const LIVE_CURSOR_THROTTLE_MS = 50; // 20fps reicht optisch fuer Cursor

export function liveChannelName(targetUserId: string): string {
  return `${LIVE_CHANNEL_PREFIX}${targetUserId}`;
}

/**
 * Baut einen halbwegs stabilen CSS-Selektor fuer ein Element. Wird gebraucht
 * um input/focus/click-Events auf der Empfaenger-Seite auf das gleiche
 * Element anzuwenden. Nicht perfekt (dynamische DOM-Aenderungen brechen es),
 * aber fuer die meisten Faelle (Formular-Inputs, Links, Buttons) stabil.
 *
 * Strategie:
 *   1) Wenn Element eine id hat: '#id'
 *   2) Sonst: tag + eindeutige klasse (falls vorhanden) + nth-of-type + Parent-Path
 *   3) Cap bei 5 Ebenen um String kurz zu halten
 */
export function cssPath(el: Element | null): string {
  if (!el || !(el instanceof Element)) return "";
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && depth < 5) {
    let sel = cur.tagName.toLowerCase();
    if (cur.id) {
      sel = `#${cssEscape(cur.id)}`;
      parts.unshift(sel);
      break;
    }
    // nth-of-type wenn Element Siblings des gleichen Tags hat
    let nth = 1;
    let sib: Element | null = cur.previousElementSibling;
    while (sib) {
      if (sib.tagName === cur.tagName) nth++;
      sib = sib.previousElementSibling;
    }
    sel += `:nth-of-type(${nth})`;
    parts.unshift(sel);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function cssEscape(v: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === "function") {
    return (globalThis as { CSS: { escape: (s: string) => string } }).CSS.escape(v);
  }
  return v.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/**
 * Setze einen input/textarea/select-Value so, dass React-controlled
 * Components den Change bemerken. Ohne den ProtoDescriptor-Trick sieht
 * React die Aenderung nicht (weil es einen eigenen Value-Setter hookt).
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const parentSetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "value")?.set;
  if (setter && setter !== parentSetter) {
    setter.call(el, value);
  } else if (parentSetter) {
    parentSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
