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

function farbe(l: AkquiseLocation): string {
  if (l.angepinnt_am) return "#f59e0b";           // angepinnt sticht vor
  if (l.prioritaet === "A") return "#16a34a";
  if (l.prioritaet === "B") return "#eab308";
  return "#94a3b8";
}

export function Karte({
  locations, gewaehlt, onWaehlen,
}: {
  locations: AkquiseLocation[];
  gewaehlt: string | null;
  onWaehlen: (id: string) => void;
}) {
  const halter = useRef<HTMLDivElement>(null);
  const karte = useRef<LeafletMap | null>(null);
  const marker = useRef<LayerGroup | null>(null);

  // Karte einmal aufbauen.
  useEffect(() => {
    if (!halter.current || karte.current) return;
    let abgebrochen = false;

    (async () => {
      const L = await import("leaflet");
      if (abgebrochen || !halter.current || karte.current) return;

      const m = L.map(halter.current, { scrollWheelZoom: false }).setView(SCHWEIZ, 8);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(m);
      marker.current = L.layerGroup().addTo(m);
      karte.current = m;
    })();

    return () => {
      abgebrochen = true;
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
        L.circleMarker([l.lat, l.lng], {
          radius: aktiv ? 10 : 7,
          color: aktiv ? "#2563eb" : farbe(l),
          weight: aktiv ? 3 : 2,
          fillColor: farbe(l),
          fillOpacity: 0.75,
        })
          .bindTooltip(
            `<strong>${l.name}</strong><br>${l.ort}` +
            (l.prioritaet ? ` · Priorität ${l.prioritaet}` : ""),
            { direction: "top" },
          )
          .on("click", () => onWaehlen(l.id))
          .addTo(marker.current!);
      }

      // Auf die Treffer zoomen — ohne das steht die Karte irgendwo in
      // den Alpen, während die Häuser in einer Stadt liegen.
      if (punkte.length === 1) {
        karte.current.setView(punkte[0], 14);
      } else if (punkte.length > 1) {
        karte.current.fitBounds(L.latLngBounds(punkte), { padding: [30, 30], maxZoom: 15 });
      }
    })();

    return () => { abgebrochen = true; };
  }, [locations, gewaehlt, onWaehlen]);

  const verortet = locations.filter((l) => l.lat !== null && l.lng !== null).length;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div ref={halter} className="h-[22rem] w-full bg-muted" />
      {verortet < locations.length && (
        <p className="border-t border-border px-3 py-1.5 text-[12px] text-foreground/65">
          {verortet} von {locations.length} verortet — ohne belegbare Adresse kein Punkt.
        </p>
      )}
    </div>
  );
}
