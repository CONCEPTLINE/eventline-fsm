"use client";

/**
 * Lieferantenportal: Tab "Katalog" — der Mietkatalog als Produktkarten-
 * Raster: Bild (aus dem PDF extrahiert), Name, Kategorie, Preis; Klick
 * oeffnet die Detail-Ansicht (grosses Bild, Beschreibung, Set-Inhalt).
 * Filter: zwei SearchableSelect-Dropdowns (Hauptkategorie + Unterkapitel)
 * plus Volltextsuche. Bild-URLs signiert via /api/lieferant/katalog —
 * der Portal-User hat keinerlei direkte Storage-Rechte.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SearchableSelect } from "@/components/searchable-select";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { Modal } from "@/components/ui/modal";
import { BookOpen, Download, ImageOff, Loader2, Search } from "lucide-react";

type Artikel = {
  id: string;
  hauptkategorie: string;
  kategorie: string;
  name: string;
  beschreibung: string | null;
  inhalt: string | null;
  preis_chf: number | null;
  preis_text: string | null;
  sort: number;
};

function preisLabel(a: Artikel): string | null {
  if (a.preis_chf !== null) {
    const n = Number(a.preis_chf);
    return `CHF ${Number.isInteger(n) ? n.toLocaleString("de-CH") : n.toLocaleString("de-CH", { minimumFractionDigits: 2 })}`;
  }
  return a.preis_text;
}

/** Kurzpreis fuer die Karte: preis_text kann ganze Staffel-Absaetze
 *  enthalten (bis >1000 Zeichen) — auf der Karte nur der erste Betrag
 *  (mit «ab», wenn es mehrere/Varianten gibt); Details in der Detail-Ansicht. */
function kurzPreis(a: Artikel): string | null {
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

/** Harte 2-Zeilen-Begrenzung als Inline-Style — unabhaengig von CSS-Klassen. */
const CLAMP2: React.CSSProperties = {
  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
};

export default function LieferantKatalogPage() {
  const supabase = useMemo(() => createClient(), []);
  const [artikel, setArtikel] = useState<Artikel[] | null>(null);
  const [bilder, setBilder] = useState<Record<string, string>>({});
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [suche, setSuche] = useState("");
  const [haupt, setHaupt] = useState("");
  const [unter, setUnter] = useState("");
  const [detail, setDetail] = useState<Artikel | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("lieferant_katalog_artikel")
        .select("id, hauptkategorie, kategorie, name, beschreibung, inhalt, preis_chf, preis_text, sort")
        .eq("is_active", true)
        .order("sort");
      setArtikel((data ?? []) as Artikel[]);
      try {
        const res = await fetch("/api/lieferant/katalog");
        const j = await res.json();
        if (res.ok && j.success) {
          if (j.url) setPdfUrl(j.url);
          if (j.bilder) setBilder(j.bilder);
        }
      } catch { /* Bilder/PDF sind Zusatz — Liste funktioniert auch ohne */ }
    })();
  }, [supabase]);

  const hauptItems = useMemo(() => {
    const seen: string[] = [];
    for (const a of artikel ?? []) if (!seen.includes(a.hauptkategorie)) seen.push(a.hauptkategorie);
    return seen.map((k) => ({ id: k, label: k }));
  }, [artikel]);

  // Unterkapitel-Optionen folgen der gewaehlten Hauptkategorie.
  const unterItems = useMemo(() => {
    const seen: string[] = [];
    for (const a of artikel ?? []) {
      if (haupt && a.hauptkategorie !== haupt) continue;
      if (!seen.includes(a.kategorie)) seen.push(a.kategorie);
    }
    return seen.map((k) => ({ id: k, label: k }));
  }, [artikel, haupt]);

  const sichtbar = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return (artikel ?? []).filter((a) => {
      if (haupt && a.hauptkategorie !== haupt) return false;
      if (unter && a.kategorie !== unter) return false;
      if (!q) return true;
      return [a.name, a.beschreibung, a.inhalt, a.kategorie].some((t) => t?.toLowerCase().includes(q));
    });
  }, [artikel, suche, haupt, unter]);

  if (artikel === null) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Katalog wird geladen…
      </div>
    );
  }

  if (artikel.length === 0) {
    return (
      <div className="py-20 text-center space-y-2">
        <BookOpen className="h-8 w-8 mx-auto text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">Dein Katalog wird gerade aufbereitet — EVENTLINE schaltet ihn in Kürze frei.</p>
      </div>
    );
  }

  const detailPreis = detail ? preisLabel(detail) : null;

  return (
    <div className="space-y-4">
      {/* Kompletter Kopf (Titel + PDF + Filter) bleibt beim Scrollen stehen. */}
      <StickyFilterBar className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-xl font-semibold flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-muted-foreground" /> Katalog
          </h1>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {sichtbar.length === artikel.length ? `${artikel.length} Artikel` : `${sichtbar.length} von ${artikel.length} Artikeln`}
          </p>
        </div>
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="kasten kasten-muted" data-tooltip="Original-Katalog als PDF" data-tooltip-side="bottom">
            <Download className="h-3.5 w-3.5" /> PDF
          </a>
        )}
      </div>

      {/* Filterzeile: Suche + zwei Dropdowns */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={suche}
            onChange={(e) => setSuche(e.target.value)}
            placeholder="Artikel suchen…"
            className="w-52 text-sm rounded-lg border border-border bg-card pl-8 pr-2.5 py-1.5 focus:outline-none focus:border-foreground/40"
          />
        </div>
        <div className="w-56">
          <SearchableSelect
            value={haupt}
            onChange={(v) => { setHaupt(v); setUnter(""); }}
            items={hauptItems}
            placeholder="Alle Kategorien"
            active={!!haupt}
          />
        </div>
        <div className="w-56">
          <SearchableSelect
            value={unter}
            onChange={setUnter}
            items={unterItems}
            placeholder="Alle Unterkategorien"
            active={!!unter}
          />
        </div>
      </div>
      </StickyFilterBar>

      {/* Produktkarten-Raster */}
      {sichtbar.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Keine Artikel für diese Auswahl.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {sichtbar.map((a) => {
            const preis = kurzPreis(a);
            const bild = bilder[a.id];
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setDetail(a)}
                className="rounded-2xl border border-border bg-card overflow-hidden text-left flex flex-col card-hover"
              >
                {/* Bildflaeche: Produktfotos auf Weiss (wie im Katalog) */}
                <div className="h-36 flex items-center justify-center overflow-hidden" style={{ background: "#fff" }}>
                  {bild ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={bild} alt={a.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                  ) : (
                    <ImageOff className="h-7 w-7" style={{ color: "#d4d4d4" }} />
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
      )}

      {/* Detail-Ansicht */}
      {detail && (
        <Modal open onClose={() => setDetail(null)} title={detail.name} size="lg">
          <div className="space-y-3">
            {bilder[detail.id] && (
              <div className="rounded-xl border border-border overflow-hidden flex items-center justify-center p-3" style={{ background: "#fff" }}>
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
    </div>
  );
}
