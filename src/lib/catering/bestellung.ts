// Getränke-Catering — Bestellliste: wie viel von welchem Getränk eingekauft werden muss.
// Reiner Rechenkern. Grundlage ist die erwartete Getränkemenge der Kalkulation (alle Phasen) und der Mix der Karte:
// jede aktive Karten-Zeile mit Mix-Anteil trägt diesen Anteil der Gesamtmenge. Wein im Glas wird in Flaschen umgerechnet,
// sobald die Karte dieselbe Sorte auch als Flasche führt.
import { KATEGORIE_REIHENFOLGE } from "./kategorien";
import type { KartenZeile } from "./daten";

export interface BestellZeile {
  name: string;
  kategorie: string;
  /** Verkaufseinheit laut Karte, z. B. «33 cl» oder «Glas · 1 dl». */
  einheit: string;
  /** Erwartete Getränke (Gläser, Flaschen, Spritz …) laut Mix, auf eine Dezimalstelle. */
  erwartet: number;
  /** Einzukaufende Menge ohne Reserve, aufgerundet. */
  menge: number;
  /** Einzukaufende Menge mit Reserve, aufgerundet. */
  mengeMitReserve: number;
  /** Was gezählt wird: «Flaschen», «Gläser», «Spritz», «Stück». */
  zaehleinheit: string;
  /** Kurzer Hinweis, z. B. «= 26 Gläser à 1 dl». */
  hinweis: string;
}

interface Mass { typ: "glas" | "flasche" | "andere"; cl: number | null }

/** «Glas · 1 dl» → Glas 10 cl; «Flasche · 75 cl» → Flasche 75 cl; «20 cl» → andere 20 cl. */
export function leseMass(einheit: string): Mass {
  const t = einheit.toLowerCase();
  const m = t.match(/([\d.,]+)\s*(cl|dl|l)\b/);
  let cl: number | null = null;
  if (m) {
    const n = Number(m[1].replace(",", "."));
    if (Number.isFinite(n)) cl = m[2] === "cl" ? n : m[2] === "dl" ? n * 10 : n * 100;
  }
  return { typ: t.includes("flasche") ? "flasche" : t.includes("glas") ? "glas" : "andere", cl };
}

const aufrunden = (n: number) => Math.ceil(Math.round(n * 1000) / 1000);

export function erstelleBestellung(karte: KartenZeile[], getraenkeGesamt: number, reserve = 0.1): BestellZeile[] {
  const r = Math.max(0, reserve);
  const reihenfolge = (k: string) => {
    const i = (KATEGORIE_REIHENFOLGE as readonly string[]).indexOf(k);
    return i < 0 ? 99 : i;
  };
  const zeilen: BestellZeile[] = [];
  for (const z of [...karte].sort((a, b) => reihenfolge(a.kategorie) - reihenfolge(b.kategorie))) {
    if (z.mixAnteil == null || z.mixAnteil <= 0) continue; // Flaschen-Zeilen ohne Mix gehören zum Glas derselben Sorte
    const erwartet = getraenkeGesamt * z.mixAnteil;
    const mass = leseMass(z.einheit);
    const flasche = mass.typ === "glas"
      ? karte.find((k) => k.name === z.name && k.kategorie === z.kategorie && leseMass(k.einheit).typ === "flasche" && leseMass(k.einheit).cl)
      : undefined;
    if (flasche && mass.cl) {
      const flCl = leseMass(flasche.einheit).cl as number;
      const proFlasche = flCl / mass.cl; // Gläser pro Flasche, z. B. 75 cl ÷ 10 cl = 7.5
      zeilen.push({
        name: z.name, kategorie: z.kategorie, einheit: flasche.einheit, erwartet: Math.round(erwartet * 10) / 10,
        menge: aufrunden(erwartet / proFlasche), mengeMitReserve: aufrunden((erwartet * (1 + r)) / proFlasche),
        zaehleinheit: "Flaschen", hinweis: `= ${Math.round(erwartet)} Gläser (${proFlasche} Gläser pro Flasche)`,
      });
      continue;
    }
    const istSpritz = z.kategorie === "aperitif";
    zeilen.push({
      name: z.name, kategorie: z.kategorie, einheit: z.einheit, erwartet: Math.round(erwartet * 10) / 10,
      menge: aufrunden(erwartet), mengeMitReserve: aufrunden(erwartet * (1 + r)),
      zaehleinheit: istSpritz ? "Spritz" : mass.typ === "glas" ? "Gläser" : "Stück",
      hinweis: istSpritz ? "Zutaten: Aperol, Prosecco, Soda, Orange" : "",
    });
  }
  return zeilen;
}

/** Bestellliste als Text zum Kopieren (eine Zeile pro Getränk). */
export function bestellungAlsText(zeilen: BestellZeile[], mitReserve: boolean): string {
  return zeilen
    .map((z) => `${mitReserve ? z.mengeMitReserve : z.menge} ${z.zaehleinheit} ${z.name} (${z.einheit})`)
    .join("\n");
}
