"use client";

/**
 * Lieferantenportal › Katalog — der Mietkatalog als Produktkarten
 * (KatalogRaster, gleiche Darstellung wie im Katalog-Fenster auf
 * /lieferanten). Artikel, Bild-URLs und PDF-URL kommen aus
 * /api/lieferant/katalog — das Portal liest nichts direkt aus der Datenbank
 * und hat keine Storage-Rechte.
 *
 * Filter (Kategorie, Unterkategorie, Suche) stehen in der URL
 * (?kat=…&unter=…&q=…) und ueberleben so einen Reload (§10).
 * Zustaende: Laden (Skeleton) · Ladefehler (Hinweis + «Erneut laden» +
 * Toast) · Katalog leer («wird aufbereitet») · keine Treffer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SearchableSelect } from "@/components/searchable-select";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { KatalogRaster, artikelPasst, type KatalogArtikel } from "@/components/lieferanten/katalog-raster";
import { AlertTriangle, BookOpen, Download, Loader2, RotateCw, Search } from "lucide-react";
import { toast } from "sonner";

type Laden =
  | { status: "laedt" }
  | { status: "fehler" }
  | { status: "ok"; artikel: KatalogArtikel[]; bilder: Record<string, string>; pdfUrl: string | null };

/** Filter in die URL schreiben (ohne Navigation) — leere Werte fallen weg. */
function filterInUrl(werte: { kat: string; unter: string; q: string }) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(werte)) {
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  window.history.replaceState({}, "", url.toString());
}

export default function LieferantKatalogPage() {
  const searchParams = useSearchParams();
  const [laden, setLaden] = useState<Laden>({ status: "laedt" });
  const [suche, setSuche] = useState(() => searchParams.get("q") ?? "");
  const [haupt, setHaupt] = useState(() => searchParams.get("kat") ?? "");
  const [unter, setUnter] = useState(() => searchParams.get("unter") ?? "");

  // Setzt nur Ergebnis/Fehler — den Lade-Zustand setzt der Aufrufer (Start
  // = Initialwert, «Erneut laden» = Klick), damit im Effekt kein synchrones
  // setState laeuft.
  const katalogLaden = useCallback(async () => {
    try {
      const res = await fetch("/api/lieferant/katalog", { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Katalog konnte nicht geladen werden");
      setLaden({ status: "ok", artikel: (j.artikel ?? []) as KatalogArtikel[], bilder: j.bilder ?? {}, pdfUrl: j.pdf_url ?? null });
    } catch (e) {
      setLaden({ status: "fehler" });
      toast.error(e instanceof Error ? e.message : "Katalog konnte nicht geladen werden");
    }
  }, []);

  useEffect(() => { void katalogLaden(); }, [katalogLaden]);

  useEffect(() => { filterInUrl({ kat: haupt, unter, q: suche.trim() }); }, [haupt, unter, suche]);

  const artikel = useMemo(() => (laden.status === "ok" ? laden.artikel : []), [laden]);

  const hauptItems = useMemo(() => {
    const seen: string[] = [];
    for (const a of artikel) if (!seen.includes(a.hauptkategorie)) seen.push(a.hauptkategorie);
    return seen.map((k) => ({ id: k, label: k }));
  }, [artikel]);

  // Unterkapitel-Optionen folgen der gewaehlten Hauptkategorie.
  const unterItems = useMemo(() => {
    const seen: string[] = [];
    for (const a of artikel) {
      if (haupt && a.hauptkategorie !== haupt) continue;
      if (!seen.includes(a.kategorie)) seen.push(a.kategorie);
    }
    return seen.map((k) => ({ id: k, label: k }));
  }, [artikel, haupt]);

  const sichtbar = useMemo(
    () => artikel.filter((a) => (!haupt || a.hauptkategorie === haupt) && (!unter || a.kategorie === unter) && artikelPasst(a, suche)),
    [artikel, suche, haupt, unter],
  );

  const filterAktiv = !!(haupt || unter || suche.trim());
  function filterZuruecksetzen() {
    setSuche("");
    setHaupt("");
    setUnter("");
  }

  const pdfUrl = laden.status === "ok" ? laden.pdfUrl : null;
  const untertitel =
    laden.status === "laedt" ? "Katalog wird geladen…"
    : laden.status === "fehler" ? "Nicht geladen"
    : sichtbar.length === artikel.length ? `${artikel.length} Artikel`
    : `${sichtbar.length} von ${artikel.length} Artikeln`;

  return (
    <div className="space-y-4 page-enter">
      {/* Kompletter Kopf (Titel + PDF + Filter) bleibt beim Scrollen stehen —
          gleicher Rahmen und Titel wie im Partnerportal. */}
      <StickyFilterBar offset="portal" className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Katalog</h1>
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
              {laden.status === "laedt" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {untertitel}
            </p>
          </div>
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="kasten kasten-muted" data-tooltip="Original-Katalog als PDF" data-tooltip-side="bottom">
              <Download className="h-3.5 w-3.5" /> PDF
            </a>
          )}
        </div>

        {laden.status === "ok" && artikel.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={suche}
                onChange={(e) => setSuche(e.target.value)}
                placeholder="Artikel suchen…"
                className="pl-9 h-9"
                aria-label="Artikel suchen"
              />
            </div>
            <div className="w-full sm:w-56">
              <SearchableSelect
                value={haupt}
                onChange={(v) => { setHaupt(v); setUnter(""); }}
                items={hauptItems}
                placeholder="Alle Kategorien"
                active={!!haupt}
              />
            </div>
            <div className="w-full sm:w-56">
              <SearchableSelect
                value={unter}
                onChange={setUnter}
                items={unterItems}
                placeholder="Alle Unterkategorien"
                active={!!unter}
              />
            </div>
          </div>
        )}
      </StickyFilterBar>

      {laden.status === "laedt" ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-2xl" />
            ))}
          </div>
        </div>
      ) : laden.status === "fehler" ? (
        <EmptyState
          icon={AlertTriangle}
          title="Katalog konnte nicht geladen werden"
          description="Bitte versuche es nochmals. Bleibt der Fehler, melde dich bei EVENTLINE."
          action={
            <button type="button" onClick={() => { setLaden({ status: "laedt" }); void katalogLaden(); }} className="kasten kasten-muted">
              <RotateCw className="h-3.5 w-3.5" /> Erneut laden
            </button>
          }
        />
      ) : artikel.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="Dein Katalog wird gerade aufbereitet"
          description="EVENTLINE schaltet die Artikel in Kürze frei."
          action={pdfUrl ? (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="kasten kasten-muted">
              <Download className="h-3.5 w-3.5" /> PDF ansehen
            </a>
          ) : undefined}
        />
      ) : sichtbar.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Keine Artikel gefunden"
          description="Andere Suche oder Kategorie wählen."
          action={filterAktiv ? (
            <button type="button" onClick={filterZuruecksetzen} className="kasten kasten-muted">
              Filter zurücksetzen
            </button>
          ) : undefined}
        />
      ) : (
        <KatalogRaster artikel={sichtbar} bilder={laden.bilder} />
      )}
    </div>
  );
}
