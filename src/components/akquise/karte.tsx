"use client";

/**
 * Karte der Akquise-Kandidaten.
 *
 * Zweck ist der Überblick, den eine Liste nicht gibt: wo die Häuser
 * stehen, wie weit sie auseinanderliegen, welche nah beieinander sind
 * (ein Termin, zwei Besuche). Die Marker tragen die Priorität als Farbe,
 * damit sich A-Ziele auf einen Blick finden.
 *
 * Leaflet läuft nur im Browser — die Komponente wird deshalb in der
 * Seite dynamisch und ohne SSR geladen. Kartenkacheln kommen von
 * OpenStreetMap (kein Schlüssel nötig, Namensnennung Pflicht).
 */

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { AkquiseLocation } from "@/types/akquise";
import "leaflet/dist/leaflet.css";

/** Mitte der Schweiz — Startpunkt, wenn noch nichts verortet ist. */
const SCHWEIZ: [number, number] = [46.8, 8.23];

/**
 * EVENTLINE-Rot aus dem Akquise-Auftrag. Die Priorität steckt nicht in
 * der Farbe, sondern im Buchstaben auf dem Fähnchen und in der Sättigung:
 * fünf verschiedenfarbige Pins auf einer Karte sind Dekoration, eine
 * Markenfarbe mit lesbarer Abstufung ist Information.
 */
const ROT = "#e0312f";

function farbe(l: AkquiseLocation): string {
  if (l.angepinnt_am) return "#f59e0b";        // angepinnt sticht bewusst heraus
  if (l.prioritaet === "A") return ROT;
  if (l.prioritaet === "B") return "#e8716f";  // dasselbe Rot, heller
  return "#f0a9a8";                            // blass für C und Unbewertetes
}

export function Karte({
  locations, gewaehlt, onWaehlen, fuellend = false,
}: {
  locations: AkquiseLocation[];
  gewaehlt: string | null;
  onWaehlen: (id: string) => void;
  /** true = füllt den Platz des Elternteils (Mittelspalte), statt eine
   *  feste Höhe zu haben. */
  fuellend?: boolean;
}) {
  const halter = useRef<HTMLDivElement>(null);
  const karte = useRef<LeafletMap | null>(null);
  const marker = useRef<LayerGroup | null>(null);

  // Karte einmal aufbauen.
  useEffect(() => {
    if (!halter.current || karte.current) return;
    let abgebrochen = false;
    let aufraeumen: (() => void) | null = null;

    (async () => {
      const L = await import("leaflet");
      if (abgebrochen || !halter.current || karte.current) return;

      const m = L.map(halter.current, { scrollWheelZoom: false }).setView(SCHWEIZ, 8);
      // Carto «Positron»: zurückhaltende, helle Grundkarte. Die
      // Standard-OSM-Kacheln sind bunt und laut — darauf gehen rote
      // Fähnchen unter. Kostenlos und ohne Schlüssel, Namensnennung
      // bleibt Pflicht.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap · © CARTO",
        subdomains: "abcd",
        maxZoom: 20,
      }).addTo(m);
      marker.current = L.layerGroup().addTo(m);
      karte.current = m;

      // Der Container bekommt seine Hoehe erst durch das Flex-Layout;
      // ohne invalidateSize misst Leaflet 0px und zeigt nur Grau.
      const beobachter = new ResizeObserver(() => m.invalidateSize());
      beobachter.observe(halter.current!);
      aufraeumen = () => beobachter.disconnect();
    })();

    return () => {
      abgebrochen = true;
      aufraeumen?.();
      karte.current?.remove();
      karte.current = null;
      marker.current = null;
    };
  }, []);

  // Marker bei jeder Änderung neu setzen.
  useEffect(() => {
    if (!karte.current || !marker.current) return;
    let abgebrochen = false;

    (async () => {
      const L = await import("leaflet");
      if (abgebrochen || !karte.current || !marker.current) return;
      marker.current.clearLayers();

      const punkte: [number, number][] = [];
      for (const l of locations) {
        if (l.lat === null || l.lng === null) continue;
        punkte.push([l.lat, l.lng]);
        const aktiv = gewaehlt === l.id;
        const f = farbe(l);

        // Fähnchen statt Punkt: ein Pin zeigt, wo genau etwas steht, und
        // trägt die Priorität als Buchstabe — so ist die Karte ohne
        // Hover lesbar.
        const pin = L.divIcon({
          className: "",
          html: `
            <div style="
              position:relative;width:26px;height:34px;
              ${aktiv ? "filter:drop-shadow(0 2px 5px rgba(224,49,47,.6));" : "filter:drop-shadow(0 1px 2px rgba(0,0,0,.25));"}
            ">
              <svg viewBox="0 0 26 34" width="26" height="34">
                <path d="M13 0C5.8 0 0 5.8 0 13c0 9.2 13 21 13 21s13-11.8 13-21C26 5.8 20.2 0 13 0z"
                      fill="${f}" stroke="${aktiv ? "#1c1b19" : "rgba(0,0,0,.2)"}" stroke-width="${aktiv ? 2.5 : 1}"/>
                <circle cx="13" cy="13" r="8" fill="rgba(255,255,255,.92)"/>
              </svg>
              <span style="
                position:absolute;inset:0;top:3px;display:flex;align-items:center;
                justify-content:center;font:700 11px/1 system-ui,sans-serif;color:${f};
              ">${l.prioritaet ?? "·"}</span>
            </div>`,
          iconSize: [26, 34],
          iconAnchor: [13, 34],
          tooltipAnchor: [0, -30],
        });

        L.marker([l.lat, l.lng], { icon: pin, zIndexOffset: aktiv ? 1000 : 0 })
          .bindTooltip(
            `<strong>${l.name}</strong><br>${l.ort}` +
            (l.kapazitaet ? ` · ${l.kapazitaet} Plätze` : "") +
            (l.prioritaet ? `<br>Priorität ${l.prioritaet}` : ""),
            { direction: "top" },
          )
          .on("click", () => onWaehlen(l.id))
          .addTo(marker.current!);
      }

      // Auf die Treffer zoomen — ohne das steht die Karte irgendwo in
      // den Alpen, während die Häuser in einer Stadt liegen. Bei einem
      // einzelnen Punkt bewusst weit (Zoom 13): man will die Stadt
      // sehen, in der er liegt, nicht die Hausnummer.
      if (punkte.length === 1) {
        karte.current.setView(punkte[0], 13);
      } else if (punkte.length > 1) {
        karte.current.fitBounds(L.latLngBounds(punkte), { padding: [40, 40], maxZoom: 14 });
      }
    })();

    return () => { abgebrochen = true; };
  }, [locations, gewaehlt, onWaehlen]);

  const verortet = locations.filter((l) => l.lat !== null && l.lng !== null).length;

  return (
    <div className={fuellend
      ? "flex h-full flex-col"
      : "overflow-hidden rounded-lg border border-border"}>
      <div ref={halter} className={`w-full bg-muted ${fuellend ? "min-h-0 flex-1" : "h-[22rem]"}`} />
      {verortet < locations.length && (
        <p className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-[12px] text-foreground/65">
          {verortet} von {locations.length} verortet — ohne belegbare Adresse kein Punkt.
        </p>
      )}
    </div>
  );
}
