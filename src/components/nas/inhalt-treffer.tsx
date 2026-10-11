"use client";

// NAS-Suche nach Inhalt (docs/lokale-ki/MASTERPLAN.md §3.3 MP-3, Paket E3.1):
// Gruppe «Im Inhalt gefunden · lokale KI» unter den Namenstreffern der
// Suchkarte. Der Suchbegriff geht als Auftrag `nas_suche` an die lokale KI
// im Buero (POST /api/ki/suche wartet bis 8 s); zurueck kommen nur Pfad,
// Seite und Score — nie Text. Die Seite zeigt die Gruppe nur, wenn das Rig
// die Art meldet (MP-1); sonst rendert sie diese Komponente gar nicht.
//
// Ablauf: 700 ms nach der letzten Eingabe suchen (ein Auftrag je Pause, nie
// je Tastendruck), laufende Suche bei neuer Eingabe abbrechen, Zeitlimit im
// Browser 16 s (Route: maxDuration 15). Fehler als Toast, dazu eine Zeile
// mit «Nochmals suchen». Ergebnisse je Begriff 2 min im Speicher des Tabs
// (nie in Storage/URL — Suchbegriffe koennen Personalakten betreffen).

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronRight, Cpu, Download, FileSearch, FileText, Loader2, RotateCcw } from "lucide-react";
import type { NasSucheTrefferAnzeige } from "@/lib/ki/typen";
import { KI_SUCHE_Q_MAX as Q_MAX, KI_SUCHE_Q_MIN as Q_MIN } from "@/lib/ki/konstanten";
import { dateiTyp } from "./ki-hilfen";

type Zustand =
  | { art: "laeuft"; seit: number }
  | { art: "fertig"; treffer: NasSucheTrefferAnzeige[]; gelesenAnteil: number | null }
  | { art: "belegt" }
  | { art: "aus" }
  | { art: "fehler" };

const VERZOEGERUNG_MS = 700;
const ZEITLIMIT_MS = 16_000;
const CACHE_MS = 120_000;

/** Datum + Zeit in Europe/Zurich, gleiche Form wie fmtWann der NAS-Seite. */
const WANN = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
function fmtWann(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : WANN.format(d);
}

/** Sekunden seit Start — tickt nur hier, nicht die ganze Seite. */
export function Sekunden({ seit }: { seit: number }) {
  const [sek, setSek] = useState(0);
  useEffect(() => {
    const tick = () => setSek(Math.max(0, Math.floor((Date.now() - seit) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [seit]);
  return <span className="tabular-nums">{sek} s</span>;
}

export function InhaltTreffer({
  q,
  ausblenden,
  onOrdnerZeigen,
  onAbrufen,
  abrufLaeuft,
}: {
  /** Suchbegriff (roh aus dem Suchfeld). */
  q: string;
  /** Pfade, die schon als Namenstreffer darueber stehen — nicht doppelt zeigen. */
  ausblenden: Set<string>;
  /** Titel-Klick: in den Ordner-Explorer springen (wie die Namenstreffer). */
  onOrdnerZeigen: (ordner: string) => void;
  /** Download-Knopf: bestehender NAS-Abruf der Seite. */
  onAbrufen: (pfad: string) => void;
  abrufLaeuft: Record<string, boolean>;
}) {
  const begriff = q.trim();
  const gueltig = begriff.length >= Q_MIN && begriff.length <= Q_MAX;
  /** Zustand gehoert immer zu genau einem Begriff — passt er nicht zum
   *  aktuellen, laeuft gerade die Eingabe-Pause (Anzeige «sucht…»). */
  const [stand, setStand] = useState<{ q: string; z: Zustand } | null>(null);
  /** «Nochmals suchen»: Zaehler je Begriff (sofort, ohne Cache). */
  const [nochmalsFuer, setNochmalsFuer] = useState<{ q: string; n: number }>({ q: "", n: 0 });
  const cacheRef = useRef<Map<string, { zeit: number; treffer: NasSucheTrefferAnzeige[]; gelesenAnteil: number | null }>>(new Map());
  /** Zeile unter der Maus — gleiches State-Hover wie die Namenstreffer der
   *  Seite (bg-muted/60, Download-Knopf nur bei Hover oder laufendem Abruf). */
  const [hoverPfad, setHoverPfad] = useState<string | null>(null);

  useEffect(() => {
    if (!gueltig) return;
    const sofort = nochmalsFuer.q === begriff && nochmalsFuer.n > 0;
    const cache = sofort ? undefined : cacheRef.current.get(begriff);
    const ausCache = cache && Date.now() - cache.zeit < CACHE_MS ? cache : undefined;
    const ctrl = new AbortController();
    let zeitlimit = false;
    const setze = (z: Zustand) => setStand({ q: begriff, z });
    const t = setTimeout(async () => {
      if (ausCache) {
        setze({ art: "fertig", treffer: ausCache.treffer, gelesenAnteil: ausCache.gelesenAnteil });
        return;
      }
      setze({ art: "laeuft", seit: Date.now() });
      const limit = setTimeout(() => { zeitlimit = true; ctrl.abort(); }, ZEITLIMIT_MS);
      try {
        const res = await fetch("/api/ki/suche", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: begriff }),
          signal: ctrl.signal,
        });
        const json = await res.json().catch(() => null);
        if (ctrl.signal.aborted && !zeitlimit) return;
        if (res.ok && json?.success && Array.isArray(json.treffer)) {
          const treffer = (json.treffer as NasSucheTrefferAnzeige[]).filter((x) => x && typeof x.pfad === "string" && typeof x.name === "string");
          const gelesenAnteil = typeof json.gelesen_anteil === "number" ? json.gelesen_anteil : null;
          cacheRef.current.set(begriff, { zeit: Date.now(), treffer, gelesenAnteil });
          setze({ art: "fertig", treffer, gelesenAnteil });
          return;
        }
        if (res.status === 503) {
          // Rig offline oder Art abgeschaltet — kein Fehler des Nutzers.
          setze({ art: "aus" });
          return;
        }
        if (res.status === 504 || json?.zeitueberschreitung) {
          toast.error("Inhaltssuche gerade belegt — gleich nochmals versuchen");
          setze({ art: "belegt" });
          return;
        }
        toast.error(json?.error ?? `Inhaltssuche fehlgeschlagen (HTTP ${res.status})`);
        setze({ art: "fehler" });
      } catch {
        if (zeitlimit) {
          toast.error("Inhaltssuche dauert zu lange — gleich nochmals versuchen");
          setze({ art: "belegt" });
          return;
        }
        if (ctrl.signal.aborted) return; // neue Eingabe — still
        toast.error("Inhaltssuche fehlgeschlagen — Netzwerkfehler");
        setze({ art: "fehler" });
      } finally {
        clearTimeout(limit);
      }
    }, sofort || ausCache ? 0 : VERZOEGERUNG_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [begriff, gueltig, nochmalsFuer]);

  const nochmals = useCallback(() => {
    setNochmalsFuer((v) => ({ q: begriff, n: v.q === begriff ? v.n + 1 : 1 }));
  }, [begriff]);

  if (!gueltig) return null;
  const zustand: Zustand | { art: "wartet" } = stand && stand.q === begriff ? stand.z : { art: "wartet" };

  const sichtbar = zustand.art === "fertig" ? zustand.treffer.filter((x) => !ausblenden.has(x.pfad)) : [];
  const anteil =
    zustand.art === "fertig" && zustand.gelesenAnteil !== null && zustand.gelesenAnteil < 1
      ? Math.max(0, Math.floor(zustand.gelesenAnteil * 100))
      : null;

  return (
    <section className="mt-3 pt-3 border-t border-border" aria-label="Im Inhalt gefunden" data-testid="inhalt-treffer">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <FileSearch className="h-3.5 w-3.5" />
          Im Inhalt gefunden{zustand.art === "fertig" ? ` (${sichtbar.length})` : ""}
        </h3>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
          data-tooltip="Die lokale KI im Büro durchsucht die Inhalte — kein Cloud-Dienst"
        >
          <Cpu className="h-3 w-3" /> lokale KI
        </span>
        {(zustand.art === "laeuft" || zustand.art === "wartet") && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground" role="status">
            <Loader2 className="h-3 w-3 animate-spin" /> sucht…{zustand.art === "laeuft" && <> <Sekunden seit={zustand.seit} /></>}
          </span>
        )}
        {anteil !== null && (
          <span
            className="text-[11px] text-muted-foreground"
            data-tooltip="Die lokale KI liest das Archiv nachts nach und nach — noch nicht alle Dateien sind durchsuchbar"
          >
            {anteil} % des Archivs gelesen
          </span>
        )}
      </div>

      {zustand.art === "aus" && (
        <p className="text-[11px] text-muted-foreground py-1">Inhaltssuche nur mit lokaler KI — gerade nicht verfügbar.</p>
      )}
      {(zustand.art === "belegt" || zustand.art === "fehler") && (
        <p className="text-[11px] text-muted-foreground py-1 flex items-center gap-2 flex-wrap">
          {zustand.art === "belegt" ? "Inhaltssuche gerade belegt." : "Inhaltssuche fehlgeschlagen."}
          <button type="button" onClick={nochmals} className="inline-flex items-center gap-1 underline underline-offset-2">
            <RotateCcw className="h-3 w-3" /> Nochmals suchen
          </button>
        </p>
      )}
      {zustand.art === "fertig" && sichtbar.length === 0 && (
        <p className="text-[11px] text-muted-foreground py-1">
          {zustand.treffer.length > 0 ? "Nur Dateien, die schon oben stehen." : "Im Inhalt nichts gefunden."}
        </p>
      )}
      {sichtbar.length > 0 && (
        <ul>
          {sichtbar.map((x) => {
            const typ = dateiTyp(x.name);
            const laedt = !!abrufLaeuft[x.pfad];
            return (
              <li
                key={x.pfad}
                onMouseEnter={() => setHoverPfad(x.pfad)}
                onMouseLeave={() => setHoverPfad((h) => (h === x.pfad ? null : h))}
                className={`py-2 px-2 -mx-2 rounded-lg flex items-start gap-2.5 ${hoverPfad === x.pfad ? "bg-muted/60" : ""}`}
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOrdnerZeigen(x.ordner)}
                    aria-label={`${x.name} im Explorer zeigen`}
                    className="block max-w-full truncate text-sm text-left"
                  >
                    {x.name}
                  </button>
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
                    <span className="font-mono min-w-0 break-all">{x.ordner || "(Hauptebene)"}</span>
                    {x.seite !== null && (
                      <>
                        <ChevronRight className="h-3 w-3 shrink-0" />
                        Seite {x.seite}
                      </>
                    )}
                    {x.geaendert && (
                      <>
                        <ChevronRight className="h-3 w-3 shrink-0" />
                        {fmtWann(x.geaendert)}
                      </>
                    )}
                  </p>
                </div>
                {typ && (
                  <span className="shrink-0 hidden sm:inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground font-mono">
                    {typ}
                  </span>
                )}
                <span
                  className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                  data-tooltip={`Im Inhalt gefunden${x.seite !== null ? ` (Seite ${x.seite})` : ""} · Relevanz ${Math.round(x.score * 100)} %`}
                >
                  <Check className="h-2.5 w-2.5" /> Inhalt
                </span>
                <span className="w-7 shrink-0 flex justify-end">
                  {(hoverPfad === x.pfad || laedt) && (
                    <button
                      type="button"
                      onClick={() => onAbrufen(x.pfad)}
                      className="icon-btn"
                      aria-label="Herunterladen"
                    >
                      {laedt
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Download className="h-4 w-4 animate-bounce text-blue-600 dark:text-blue-400" />}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
