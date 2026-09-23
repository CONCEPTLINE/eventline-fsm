"use client";

/**
 * Auflistung der Laender aus denen unsere Kunden kommen — Flagge + Land + Anzahl.
 * Sortiert nach Kundenzahl (haeufigste zuerst).
 *
 * Flaggen via flag-icons (CSS, selbst-gehostet) — nicht via Emoji, weil Windows
 * keine Flag-Emoji-Font hat und die Codepoints stattdessen als ISO-Buchstaben-
 * paare gerendert werden.
 *
 * Komponentenname bleibt "CustomerWorldMap" fuer Import-Kompatibilitaet — die
 * urspruengliche Karte war zu fragil bei der Crop-Math, Liste ist deterministisch.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import "flag-icons/css/flag-icons.min.css";

type CountryDatum = { country: string; count: number };

// Lokalisiert via Intl — kein externes Mapping noetig. Fallback: ISO-Code.
const REGION_NAMES = typeof Intl !== "undefined" && "DisplayNames" in Intl
  ? new Intl.DisplayNames(["de"], { type: "region" })
  : null;

function countryName(iso: string): string {
  return REGION_NAMES?.of(iso.toUpperCase()) ?? iso;
}

export function CustomerWorldMap() {
  const [data, setData] = useState<CountryDatum[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    async function load() {
      // Server-seitig aggregiert via View customer_country_counts (075).
      // Vorher zog die Komponente ALLE customers nur fuer address_country —
      // bei 5-10k Kunden MB-Bereich pro /kunden-Mount.
      const { data: rows } = await supabase
        .from("customer_country_counts")
        .select("country, count");
      const sorted: CountryDatum[] = ((rows ?? []) as { country: string; count: number }[])
        .map((r) => ({ country: r.country.toUpperCase(), count: r.count }))
        .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
      setData(sorted);
      setLoading(false);
    }
    load();

    // COALESCED (leading + trailing, 2.5s-Fenster — Muster aus
    // use-nav-counts): customers:invalidate feuert bei JEDER customers-
    // Aenderung irgendeines Users; erstes Event laedt SOFORT, weitere im
    // Fenster werden zu 1 trailing Reload zusammengefasst.
    const WINDOW_MS = 2500;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trailingPending = false;
    const openWindow = () => {
      timer = setTimeout(() => {
        timer = null;
        if (trailingPending) {
          trailingPending = false;
          load();
          openWindow();
        }
      }, WINDOW_MS);
    };
    const handler = () => {
      if (timer) {
        trailingPending = true;
        return;
      }
      load();
      openWindow();
    };
    window.addEventListener("customers:invalidate", handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("customers:invalidate", handler);
    };
  }, []);

  if (loading || data.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="flex flex-wrap gap-2">
        {data.map((d) => (
          <div
            key={d.country}
            className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-muted/50 text-sm"
          >
            {/* flag-icons CSS-Klasse: fi-{iso2-lowercase}, default 4:3-Verhaeltnis.
                Inline-block mit fester em-Breite damit alle Flaggen gleich gross
                erscheinen unabhaengig vom rendering. */}
            <span
              className={`fi fi-${d.country.toLowerCase()} inline-block shrink-0 rounded-sm shadow-sm`}
              style={{ width: "1.4em", height: "1.05em" }}
              aria-hidden
            />
            <span className="font-medium">{countryName(d.country)}</span>
            <span className="text-muted-foreground tabular-nums text-xs">
              {d.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
