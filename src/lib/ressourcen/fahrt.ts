// Fahrzeit mit dem Auto vom Büro zu den Locations (Ressourcen › Planungsbrett).
//
// Büro-Adresse = Firmen-Stammdaten (company_settings), Rückfall auf die
// Adresse im Handelsregister. Koordinaten über den bestehenden Geocoder
// (Nominatim), Fahrzeiten über OSRM (OpenStreetMap, ohne Schlüssel): schnellste
// Strecke nach Strassennetz, OHNE aktuelle Verkehrslage. EINE Anfrage für alle
// Ziele (OSRM «table»), damit das Brett auch mit 50 Häusern schnell bleibt.
//
// Nur serverseitig (API-Route), mit Zwischenspeicher. Fehlschläge werden
// NICHT gespeichert (die Cache-Funktion wirft dann).

import { unstable_cache } from "next/cache";
import { geocodeAddress } from "@/lib/geocode";
import { cachedCompanySettings } from "@/lib/cached";

export type Punkt = { lat: number; lng: number };
export type Buero = Punkt & { adresse: string };
/** Fahrt ab Büro: Minuten ohne Verkehrslage, Strecke in Kilometern. */
export type Fahrzeit = { minuten: number; km: number };

const RUECKFALL = { street: "St. Jakobs-Strasse 200", zip: "4052", city: "Basel" };
const OSRM = "https://router.project-osrm.org/table/v1/driving";
const TAG = 60 * 60 * 24;
/** OSRM (öffentlicher Dienst) nimmt höchstens 100 Koordinaten je Anfrage. */
const MAX_ZIELE = 99;

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

const tabelleCache = unstable_cache(
  async (koordinaten: string): Promise<(Fahrzeit | null)[]> => {
    const url = `${OSRM}/${koordinaten}?sources=0&annotations=duration,distance`;
    const res = await fetch(url, { headers: { "User-Agent": "FSM/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Routendienst antwortet mit ${res.status}`);
    const json = (await res.json()) as { code?: string; durations?: (number | null)[][]; distances?: (number | null)[][] };
    const d = json.durations?.[0];
    const s = json.distances?.[0];
    if (json.code !== "Ok" || !d || !s) throw new Error("Keine Fahrzeiten erhalten");
    // Index 0 ist das Büro selbst.
    return d.slice(1).map((sek, i) => {
      const meter = s[i + 1];
      if (sek == null || meter == null) return null;
      return { minuten: Math.max(1, Math.round(sek / 60)), km: Math.round(meter / 100) / 10 };
    });
  },
  ["ressourcen-fahrzeiten-v1"],
  { revalidate: 7 * TAG },
);

/**
 * Fahrzeiten vom Büro zu allen Zielen in einer Anfrage. Liefert eine Map
 * id → Fahrzeit; Ziele ohne Strecke fehlen. Wirft, wenn der Routendienst
 * nicht antwortet.
 */
export async function ladeFahrzeiten(von: Punkt, ziele: readonly (Punkt & { id: string })[]): Promise<Map<string, Fahrzeit>> {
  const r = (n: number) => (Math.round(n * 1e5) / 1e5).toFixed(5);
  const out = new Map<string, Fahrzeit>();
  for (let i = 0; i < ziele.length; i += MAX_ZIELE) {
    const teil = ziele.slice(i, i + MAX_ZIELE);
    const koordinaten = [von, ...teil].map((p) => `${r(p.lng)},${r(p.lat)}`).join(";");
    const zeiten = await tabelleCache(koordinaten);
    teil.forEach((z, j) => { const f = zeiten[j]; if (f) out.set(z.id, f); });
  }
  return out;
}
