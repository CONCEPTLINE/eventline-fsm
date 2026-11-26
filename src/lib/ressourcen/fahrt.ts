// Fahrt mit dem Auto vom Büro zu einer Location (Vertrieb › Ressourcen).
//
// Büro-Adresse = Firmen-Stammdaten (company_settings), Rückfall auf die
// Adresse im Handelsregister. Koordinaten über den bestehenden Geocoder
// (Nominatim), Route über OSRM (OpenStreetMap, ohne Schlüssel): schnellste
// Strecke nach Strassennetz, OHNE aktuelle Verkehrslage. Für die Verkehrslage
// verlinkt die Ansicht zusätzlich Google Maps.
//
// Nur serverseitig (API-Route): so trifft nicht jeder Browser einzeln die
// öffentlichen Dienste, und die Antworten werden zwischengespeichert.
// Fehlschläge werden NICHT gespeichert (die Cache-Funktion wirft dann).

import { unstable_cache } from "next/cache";
import { geocodeAddress } from "@/lib/geocode";
import { cachedCompanySettings } from "@/lib/cached";

export type Punkt = { lat: number; lng: number };
export type Buero = Punkt & { adresse: string };
export type Fahrt = {
  /** Strecke in Kilometern. */
  km: number;
  /** Fahrzeit in Minuten, ohne Verkehrslage. */
  minuten: number;
  /** Linie der Strecke als [lat, lng]-Paare (für die Karte). */
  linie: [number, number][];
};

const RUECKFALL = { street: "St. Jakobs-Strasse 200", zip: "4052", city: "Basel" };
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const TAG = 60 * 60 * 24;

const bueroCache = unstable_cache(
  async (street: string, zip: string, city: string): Promise<Buero> => {
    const p = await geocodeAddress(street, zip, city);
    if (!p) throw new Error("Büro-Adresse nicht gefunden");
    return { ...p, adresse: `${street}, ${zip} ${city}` };
  },
  ["ressourcen-buero-v1"],
  { revalidate: 30 * TAG },
);

/** Koordinaten des Büros, oder null wenn die Adresse nicht auflösbar ist. */
export async function ladeBuero(): Promise<Buero | null> {
  const c = await cachedCompanySettings().catch(() => null);
  const a = c?.street && c?.city ? { street: c.street, zip: c.zip, city: c.city } : RUECKFALL;
  try {
    return await bueroCache(a.street, a.zip, a.city);
  } catch {
    return null;
  }
}

const fahrtCache = unstable_cache(
  async (vonLat: number, vonLng: number, nachLat: number, nachLng: number): Promise<Fahrt> => {
    const url = `${OSRM}/${vonLng},${vonLat};${nachLng},${nachLat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const res = await fetch(url, { headers: { "User-Agent": "FSM/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Routendienst antwortet mit ${res.status}`);
    const json = (await res.json()) as {
      code?: string;
      routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    };
    const r = json.routes?.[0];
    if (json.code !== "Ok" || !r) throw new Error("Keine Strecke gefunden");
    return {
      km: Math.round(r.distance / 100) / 10,
      minuten: Math.max(1, Math.round(r.duration / 60)),
      linie: r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]),
    };
  },
  ["ressourcen-fahrt-v1"],
  { revalidate: 7 * TAG },
);

/** Schnellste Autostrecke. Wirft, wenn der Routendienst nicht antwortet. */
export function ladeFahrt(von: Punkt, nach: Punkt): Promise<Fahrt> {
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return fahrtCache(r(von.lat), r(von.lng), r(nach.lat), r(nach.lng));
}

/** Google-Maps-Link für dieselbe Fahrt (mit aktueller Verkehrslage). */
export function googleMapsLink(von: Punkt, nach: Punkt): string {
  const p = new URLSearchParams({
    api: "1",
    origin: `${von.lat},${von.lng}`,
    destination: `${nach.lat},${nach.lng}`,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${p}`;
}
