"use client";

// Kleine Dokumentenvorschau in den Einsortier-Vorschlaegen (Rueckstau ZZ) und
// in «Doppelte»: links in jeder Zeile ein Feld (Icon), bei Hover-Absicht
// (>= 500 ms) wird EIN Vorschaubild geholt: die lokale KI rendert die erste
// Seite als kleines JPEG (≤ 900 px) direkt vom NAS (GET /api/ablage/vorschau,
// Auftragsart «vorschau», Zwischenspeicher nur auf dem Rig) — in Sekunden statt
// der ganzen Datei ueber den NAS-Sync (bis ~1 Min.). PDF, Bilder und
// Office-Dateien mit eingebettetem Vorschaubild; sonst «Keine Vorschau».
// Ist die lokale KI offline (503), wie bisher die ganze Datei ueber den Sync
// (holeNasDatei + erzeugeThumb, nur PDF/Bilder).
// Danach Mini-Bild + vergroesserte Vorschau beim Darueberfahren (Portal,
// position fixed, nie ueber den Fensterrand — Muster thumbGross der NAS-Seite).
// Lazy: nichts wird vorab geladen; hoechstens 2 Abrufe gleichzeitig;
// Ergebnis je Pfad fuer die Sitzung gecacht (nur im Speicher, Objekt-URL) —
// das zweite Mal sofort. Scheitert ein Abruf, darf der naechste Hover es
// erneut versuchen. Beim ersten Darueberfahren wird das Rig geweckt (schneller
// Abholtakt, weckeKi — gedrosselt).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FileText, Loader2 } from "lucide-react";
import { blobFuerVorschau, erzeugeThumb, holeNasDatei, weckeKi } from "./ki-hilfen";

const HOVER_ABSICHT_MS = 500;
const MAX_PARALLEL = 2;
/** Groesse der Vergroesserung (max-w 300 + Rand, max-h 380 + Rand). */
const GROSS_B = 312;
const GROSS_H = 392;

type Stand = { art: "laedt" } | { art: "bild"; src: string } | { art: "keins" } | { art: "fehler" };

/** Dateitypen mit Vorschau (Rig: PDF Seite 1, Bilder, eingebettetes Office-Vorschaubild). */
const MIT_VORSCHAU = /\.(pdf|png|jpe?g|gif|webp|tiff?|bmp|docx|docm|xlsx|xlsm|pptx|odt|ods|odp|pages|numbers|key)$/i;
/** Bisheriger Weg (ganze Datei ueber den NAS-Sync) — nur, wenn die lokale KI nicht verfuegbar ist; nur PDF/Bilder. */
const ALTER_WEG = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** Vorschau holen: Rig zuerst, offline → bisheriger Weg. Objekt-URL, null = keine Vorschau, "fehler" = neu versuchen. */
async function holeVorschau(supabase: SupabaseClient, pfad: string): Promise<string | null | "fehler"> {
  try {
    const res = await fetch(`/api/ablage/vorschau?pfad=${encodeURIComponent(pfad)}`, { cache: "no-store" });
    if (res.status === 200) return URL.createObjectURL(await res.blob());
    if (res.status === 204 || res.status === 404 || res.status === 400) return null;
    if (res.status !== 503) return "fehler";
  } catch {
    return "fehler";
  }
  if (!ALTER_WEG.test(pfad)) return null;
  const { blob, name } = await holeNasDatei(supabase, pfad);
  return erzeugeThumb(blobFuerVorschau(blob, name));
}

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
    p = mitPlatz(() => holeVorschau(supabase, pfad)).then(
      (src) => {
        if (src === "fehler") {
          cache.delete(pfad);
          return src;
        }
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
      // Abholtakt des Rigs beschleunigen, waehrend die Hover-Absicht laeuft (gedrosselt, Fehler egal).
      weckeKi();
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
                    {stand?.art === "laedt" ? "Vorschau wird geladen …" : "Kurz verweilen für die Vorschau"}
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
