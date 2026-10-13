"use client";

/**
 * Browser-/Statusleistenfarbe folgt dem App-Theme (Mobile-Politur 2026-10-13).
 *
 * Vorher hingen zwei <meta name="theme-color"> an prefers-color-scheme (also
 * am Handy-Theme). Die App waehlt Hell/Dunkel aber selbst (next-themes,
 * theme-provider.tsx, Klasse am <html>) — Handy dunkel + App hell ergab am
 * Android eine schwarze Statusleiste ueber dem hellen Kopf. Jetzt gibt es
 * GENAU EIN theme-color-Meta ohne media, die Farbe kommt vom App-Theme.
 * Die viewport-Exports der Layouts setzen darum kein themeColor mehr (sonst
 * wuerden zwei Metas konkurrieren).
 *
 * Farbe = deckender Hintergrund des mobilen Kopfs (bg-background/95 ueber
 * der Shell) = --background in globals.css: hell oklch(0.985 0 0) = #fafafa,
 * dunkel oklch(0.1 0 0) = #030303.
 *
 * Erster Paint: das Inline-Script laeuft beim Parsen, direkt nach dem
 * next-themes-Script (ThemeProvider rendert es vor seinen Kindern), und
 * liest die html-Klasse, die next-themes gerade gesetzt hat — kein eigenes
 * localStorage-Lesen, keine zweite Wahrheit. Danach haelt der Effekt die
 * Farbe bei jedem Theme-Wechsel nach. Das Meta legt das Script per DOM an,
 * React besitzt es nicht: kein Hydrations-Konflikt, und Seitenwechsel
 * (Metadaten der Layouts) lassen es stehen.
 *
 * Muss innerhalb von <ThemeProvider> stehen (useTheme).
 */

import { useEffect } from "react";
import { useTheme } from "next-themes";

const FARBE_HELL = "#fafafa";
const FARBE_DUNKEL = "#030303";

/** Das eine theme-color-Meta ohne media holen oder anlegen und faerben. */
function farbeSetzen(farbe: string) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  if (meta.content !== farbe) meta.content = farbe;
}

// Gleiche Logik wie farbeSetzen, als Text fuers Inline-Script (laeuft vor
// React; try/catch, damit ein Fehler hier nie die Seite aufhaelt).
const SCRIPT = `(function(){try{var d=document,m=d.querySelector('meta[name="theme-color"]:not([media])');if(!m){m=d.createElement('meta');m.name='theme-color';d.head.appendChild(m);}m.content=d.documentElement.classList.contains('dark')?'${FARBE_DUNKEL}':'${FARBE_HELL}';}catch(e){}})();`;

export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!resolvedTheme) return;
    farbeSetzen(resolvedTheme === "dark" ? FARBE_DUNKEL : FARBE_HELL);
  }, [resolvedTheme]);

  // suppressHydrationWarning wie beim next-themes-Script: der Inhalt ist
  // auf Server und Client identisch, das Element wird nur hydriert.
  return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
