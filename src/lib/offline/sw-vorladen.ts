"use client";

// Vorladen der HTML-Huelle von Feld-Seiten durch den Service Worker.
//
// Next-Soft-Navigation (Heute → Einsatz → Rapport) holt nur die RSC-Antwort
// (?_rsc=); die HTML-Huelle laeuft nie durch den navigate-Zweig des SW und
// laege offline nicht im Cache → der Nutzer landet auf /offline. Darum
// melden die Feld-Seiten dem SW die Pfade, die gleich gebraucht werden
// koennten (Nachricht {typ: "SEITE_VORLADEN", pfad}); der SW holt die Huelle
// (ein Skeleton ohne Nutzerdaten — die Client-Komponenten lesen aus
// IndexedDB/Supabase) und legt sie unter dem Pfad ab. Angenommen werden nur
// Feld-Seiten (istFeldSeite in src/app/sw.js/route.ts).
//
// No-op ohne Controller (SW noch nicht aktiv, Dev-Modus) oder offline. Jeder
// Pfad wird je Seitenlauf nur einmal gemeldet (Realtime-Nachlader rufen gern
// wiederholt). Wechselt der Controller (neuer Build → activate raeumt den
// alten Cache samt der dort vorgeladenen Seiten ab), werden alle bisher
// gemeldeten Pfade sofort beim neuen SW erneut gemeldet — sonst waeren
// Auftrag und Rapport nach jedem Deploy offline weg, bis die Seite neu laedt.

const gemeldet = new Set<string>();
let controllerBeobachtet = false;

function beobachteController(): void {
  if (controllerBeobachtet) return;
  controllerBeobachtet = true;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const alle = [...gemeldet];
    gemeldet.clear();
    seitenVorladen(alle);
  });
}

/** Meldet dem SW einen Pfad zum Vorladen — still, hoechstens einmal je Pfad. */
export function seiteVorladen(pfad: string): void {
  try {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    if (navigator.onLine === false) return;
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;
    const pathname = new URL(pfad, window.location.origin).pathname;
    if (gemeldet.has(pathname)) return;
    gemeldet.add(pathname);
    beobachteController();
    sw.postMessage({ typ: "SEITE_VORLADEN", pfad: pathname });
  } catch {
    /* best effort — Vorladen darf die Seite nie stoeren */
  }
}

export function seitenVorladen(pfade: string[]): void {
  for (const p of pfade) seiteVorladen(p);
}
