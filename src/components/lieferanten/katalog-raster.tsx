"use client";

/**
 * Katalog-Raster — Produktkarten (Bild, Kapitel, Name, Kurzpreis) mit
 * Detail-Fenster (grosses Bild, Preise, Beschreibung, Set-Inhalt). Eine
 * Darstellung fuer das Lieferantenportal (Reiter «Katalog») und das
 * Katalog-Fenster auf /lieferanten.
 *
 * Bildflaechen: Die Produktfotos sind auf Weiss fotografiert. Im Dunkelmodus
 * daempft ein Helligkeitsfilter die ganze Kachel (Grund + Bild gleich stark),
 * damit keine grellweissen Flaechen aus der dunklen Seite leuchten.
 */

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { formatChf } from "@/lib/format";
import { ImageOff } from "lucide-react";

export type KatalogArtikel = {
  id: string;
  hauptkategorie: string;
  kategorie: string;
  name: string;
  beschreibung: string | null;
  inhalt: string | null;
  preis_chf: number | null;
  preis_text: string | null;
};

/** Volle Preisangabe: Betrag aus preis_chf, sonst der Preis-Text. */
export function preisLabel(a: KatalogArtikel): string | null {
  if (a.preis_chf !== null) {
    const n = Number(a.preis_chf);
    return formatChf(n, { stellen: Number.isInteger(n) ? 0 : 2 });
  }
  return a.preis_text;
}

/** Kurzpreis fuer die Karte: preis_text kann ganze Staffel-Absaetze
 *  enthalten (bis >1000 Zeichen) — auf der Karte nur der erste Betrag
 *  (mit «ab», wenn es mehrere/Varianten gibt); alles Weitere im Detail. */
function kurzPreis(a: KatalogArtikel): string | null {
  if (a.preis_chf !== null) return preisLabel(a);
  const t = a.preis_text;
  if (!t) return null;
  const m = t.match(/CHF\s*([\d'’]+(?:\.\d{1,2})?)/i);
  if (m) {
    const mehrere = (t.match(/CHF/gi) ?? []).length > 1 || t.length > 30;
    return `${mehrere ? "ab " : ""}CHF ${m[1]}`;
  }
  return t.length > 26 ? t.slice(0, 24) + "…" : t;
}

/** Suche ueber Name, Kapitel, Beschreibung und Set-Inhalt (Kleinschreibung). */
export function artikelPasst(a: KatalogArtikel, suche: string): boolean {
  const q = suche.trim().toLowerCase();
  if (!q) return true;
  return [a.name, a.beschreibung, a.inhalt, a.kategorie, a.hauptkategorie].some((t) => t?.toLowerCase().includes(q));
}

/** Harte 2-Zeilen-Begrenzung als Inline-Style — unabhaengig von CSS-Klassen. */
const CLAMP2: React.CSSProperties = {
  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
};

/** Weisse Bildflaeche, im Dunkelmodus gedaempft (siehe Kopfkommentar). Weiss
 *  als Inline-Style: die Klasse bg-white faerbt globals.css im Dunkelmodus
 *  global dunkel um — die Fotos brauchen aber ihren weissen Grund. */
const BILDFLAECHE = "dark:brightness-[0.8]";
const BILDGRUND: React.CSSProperties = { background: "#fff" };

export function KatalogRaster({
  artikel,
  bilder,
  rasterKlasse = "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
}: {
  artikel: KatalogArtikel[];
  bilder: Record<string, string>;
  /** Spalten des Rasters (Portal-Seite breit, Fenster schmaler). */
  rasterKlasse?: string;
}) {
  const [detail, setDetail] = useState<KatalogArtikel | null>(null);
  const detailPreis = detail ? preisLabel(detail) : null;

  return (
    <>
      <div className={`grid gap-3 ${rasterKlasse}`}>
        {artikel.map((a) => {
          const preis = kurzPreis(a);
          const bild = bilder[a.id];
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setDetail(a)}
              className="rounded-2xl border bg-card overflow-hidden text-left flex flex-col card-hover"
            >
              <div className={`h-36 flex items-center justify-center overflow-hidden ${BILDFLAECHE}`} style={BILDGRUND}>
                {bild ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bild} alt={a.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                ) : (
                  <ImageOff className="h-7 w-7 text-neutral-300" />
                )}
              </div>
              <div className="p-3 flex-1 flex flex-col gap-1 min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{a.kategorie}</p>
                <p className="text-sm font-medium leading-snug" style={CLAMP2}>{a.name}</p>
                {preis && <p className="text-sm font-semibold tabular-nums mt-auto pt-1 truncate">{preis}</p>}
              </div>
            </button>
          );
        })}
      </div>

      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.name} size="lg">
          <div className="space-y-3">
            {bilder[detail.id] && (
              <div className={`rounded-xl border border-border overflow-hidden flex items-center justify-center p-3 ${BILDFLAECHE}`} style={BILDGRUND}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={bilder[detail.id]} alt={detail.name} className="max-h-72 max-w-full object-contain" />
              </div>
            )}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {detail.hauptkategorie} · {detail.kategorie}
              </p>
              {detail.preis_chf !== null && detailPreis && (
                <span className="text-base font-semibold tabular-nums bg-foreground/[0.05] dark:bg-foreground/[0.1] rounded-lg px-3 py-1">
                  {detailPreis}
                </span>
              )}
            </div>
            {/* Lange Preis-Texte (Staffeln/Varianten) vollstaendig, sauber umgebrochen */}
            {detail.preis_chf === null && detail.preis_text && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Preise</p>
                <p className="text-sm text-foreground/90 whitespace-pre-wrap bg-muted/30 rounded-xl px-3 py-2.5">
                  {detail.preis_text.replace(/;\s*/g, "\n")}
                </p>
              </div>
            )}
            {detail.beschreibung && <p className="text-sm text-foreground/90">{detail.beschreibung}</p>}
            {detail.inhalt && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Set-Inhalt</p>
                <pre className="text-[13px] text-foreground/85 whitespace-pre-wrap font-sans bg-muted/30 rounded-xl px-3 py-2.5">{detail.inhalt}</pre>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
