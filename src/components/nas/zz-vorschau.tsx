"use client";

// Kleine Dokumentenvorschau in den Einsortier-Vorschlaegen (Rueckstau ZZ):
// links in jeder Zeile ein Feld (Icon), bei Hover-Absicht (>= 500 ms) wird
// die Datei EINMAL vom NAS geholt — gleiche Mechanik wie der Download-Knopf
// (holeNasDatei: Abruf-Zeile, der NAS-Sync laedt die Datei in den
// Uebergabe-Bucket, bis ~1 Min.) und dieselbe Mini-Vorschau wie beim
// Ablegen (erzeugeThumb: Bild direkt, PDF Seite 1). Danach Mini-Bild +
// vergroesserte Vorschau beim Darueberfahren (Portal, position fixed, nie
// ueber den Fensterrand — Muster thumbGross der NAS-Seite).
// Lazy: nichts wird vorab geladen; hoechstens 2 Abrufe gleichzeitig;
// Ergebnis je Pfad fuer die Sitzung gecacht (nur im Speicher). Nur PDF und
// Bilder werden geholt (andere Typen haetten keine Vorschau — kein unnoetiger
// Upload ueber den Sync); scheitert ein Abruf, darf der naechste Hover es
// erneut versuchen.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FileText, Loader2 } from "lucide-react";
import { blobFuerVorschau, erzeugeThumb, holeNasDatei } from "./ki-hilfen";

const HOVER_ABSICHT_MS = 500;
const MAX_PARALLEL = 2;
/** Groesse der Vergroesserung (max-w 300 + Rand, max-h 380 + Rand). */
const GROSS_B = 312;
const GROSS_H = 392;

type Stand = { art: "laedt" } | { art: "bild"; src: string } | { art: "keins" } | { art: "fehler" };

/** Dateitypen mit Vorschau (erzeugeThumb: PDF Seite 1, Bilder direkt). */
const MIT_VORSCHAU = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** Sitzungs-Cache je Pfad (auch fuer laufende Abrufe); `fehler` = Abruf
 *  gescheitert (nicht gecacht, naechster Hover versucht es erneut). */
const cache = new Map<string, Promise<string | null | "fehler">>();
const fertig = new Map<string, string | null>();
let laufend = 0;
const warteschlange: (() => void)[] = [];

async function mitPlatz<T>(f: () => Promise<T>): Promise<T> {
  if (laufend >= MAX_PARALLEL) await new Promise<void>((r) => warteschlange.push(r));
  laufend++;
  try {
    return await f();
  } finally {
    laufend--;
    warteschlange.shift()?.();
  }
}

function ladeVorschau(supabase: SupabaseClient, pfad: string): Promise<string | null | "fehler"> {
  let p = cache.get(pfad);
  if (!p) {
    p = mitPlatz(async () => {
      const { blob, name } = await holeNasDatei(supabase, pfad);
      return erzeugeThumb(blobFuerVorschau(blob, name));
    }).then(
      (src) => {
        fertig.set(pfad, src);
        return src;
      },
      () => {
        cache.delete(pfad);
        return "fehler" as const;
      },
    );
    cache.set(pfad, p);
  }
  return p;
}

function alsStand(src: string | null | "fehler"): Stand {
  return src === "fehler" ? { art: "fehler" } : src ? { art: "bild", src } : { art: "keins" };
}

function anfangsStand(pfad: string): Stand | null {
  if (!MIT_VORSCHAU.test(pfad)) return { art: "keins" };
  if (!fertig.has(pfad)) return cache.has(pfad) ? { art: "laedt" } : null;
  return alsStand(fertig.get(pfad) ?? null);
}

export function ZzVorschau({ supabase, pfad }: { supabase: SupabaseClient; pfad: string }) {
  const [stand, setStand] = useState<Stand | null>(() => anfangsStand(pfad));
  const [gross, setGross] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lebt = useRef(true);

  useEffect(() => {
    lebt.current = true;
    // Laeuft der Abruf schon (andere Zeile/Gruppe), Ergebnis abholen.
    const p = cache.get(pfad);
    if (p) void p.then((src) => { if (lebt.current) setStand(alsStand(src)); });
    return () => {
      lebt.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [pfad]);

  function starte() {
    setStand({ art: "laedt" });
    void ladeVorschau(supabase, pfad).then((src) => {
      if (lebt.current) setStand(alsStand(src));
    });
  }

  function rein(e: React.MouseEvent<HTMLSpanElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    // Rechts daneben; reicht der Platz nicht, links. Vertikal geklemmt.
    const left = r.right + 10 + GROSS_B <= window.innerWidth ? r.right + 10 : Math.max(8, r.left - 10 - GROSS_B);
    const top = Math.max(8, Math.min(r.top - 8, window.innerHeight - GROSS_H - 8));
    setGross({ top, left });
    if ((!stand || stand.art === "fehler") && !timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        starte();
      }, HOVER_ABSICHT_MS);
    }
  }

  function raus() {
    setGross(null);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  return (
    <span
      className="relative shrink-0 h-6 w-6 overflow-hidden rounded border border-border bg-muted/40 dark:bg-muted/70 flex items-center justify-center cursor-zoom-in"
      onMouseEnter={rein}
      onMouseLeave={raus}
      data-testid="zz-vorschau"
    >
      {stand?.art === "bild" ? (
        // eslint-disable-next-line @next/next/no-img-element -- Data-URL aus pdfjs, kein next/image
        <img src={stand.src} alt="" className="h-full w-full object-cover bg-white" />
      ) : stand?.art === "laedt" ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      {gross && typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none rounded-lg border border-border bg-white shadow-2xl p-1"
            style={{ position: "fixed", top: gross.top, left: gross.left, zIndex: 60 }}
            data-testid="zz-vorschau-gross"
          >
            {stand?.art === "bild" ? (
              // eslint-disable-next-line @next/next/no-img-element -- s. o.
              <img src={stand.src} alt="" className="block max-w-[300px] max-h-[380px] w-auto h-auto rounded-md" />
            ) : (
              <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-neutral-600">
                {stand?.art === "keins" ? (
                  "Keine Vorschau für diese Datei"
                ) : stand?.art === "fehler" ? (
                  "Vorschau konnte nicht geholt werden — kurz verweilen für einen neuen Versuch"
                ) : (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {stand?.art === "laedt" ? "Vorschau wird vom NAS geholt …" : "Kurz verweilen für die Vorschau"}
                  </>
                )}
              </p>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
