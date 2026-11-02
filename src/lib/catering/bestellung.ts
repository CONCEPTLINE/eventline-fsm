// Getränke-Catering — Bestellliste: wie viel von welchem Getränk eingekauft werden muss.
// Reiner Rechenkern. Grundlage ist die erwartete Getränkemenge der Kalkulation (alle Phasen) und der Mix der Karte:
// jede aktive Karten-Zeile mit Mix-Anteil trägt diesen Anteil der Gesamtmenge. Wein im Glas wird in Flaschen umgerechnet,
// sobald die Karte dieselbe Sorte auch als Flasche führt. Hat die Zeile ein Gebinde (z. B. Harass à 24), wird auf ganze
// Gebinde aufgerundet; ungeöffnete Gebinde nimmt der Lieferant zurück, der Überschuss ist also kein Verlust.
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
  /** Gebinde laut Karte (z. B. «Harass» à 24); null = einzeln bestellbar. */
  gebindeName: string | null;
  gebindeStueck: number | null;
  /** Ganze Gebinde mit Reserve (bei Gebinde), sonst null. */
  gebindeAnzahl: number | null;
  /** Tatsächlich bestellte Stück = Gebinde × Stück pro Gebinde (ohne Gebinde = mengeMitReserve). */
  bestellStueck: number;
  /** Bestellte Stück abzüglich erwarteter Menge: ungeöffnet retour, soweit es der Lieferant zurücknimmt. */
  ueberschuss: number;
  /** Einkaufspreis pro gezählte Einheit (Flasche, Glas, Spritz, Stück). */
  einzelpreis: number;
  /** Wert der Bestellung zum Einkaufspreis (bestellte Stück × Einzelpreis); Depot nicht eingerechnet. */
  bestellWert: number;
  /** Wert der erwarteten Menge zum Einkaufspreis: das ist der Einkauf, mit dem die Kalkulation rechnet. */
  verbrauchWert: number;
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

function gebindeFuer(zeile: KartenZeile | undefined): { name: string; stueck: number } | null {
  if (!zeile || !zeile.gebindeStueck || zeile.gebindeStueck < 1) return null;
  return { name: zeile.gebindeName?.trim() || "Gebinde", stueck: zeile.gebindeStueck };
}

function mitGebinde(
  basis: Omit<BestellZeile, "gebindeName" | "gebindeStueck" | "gebindeAnzahl" | "bestellStueck" | "ueberschuss" | "einzelpreis" | "bestellWert" | "verbrauchWert">,
  geb: { name: string; stueck: number } | null,
  erwartetStueck: number,
  einzelpreis: number,
): BestellZeile {
  const rund = (n: number) => Math.round(n * 100) / 100;
  const preise = (stueck: number) => ({ einzelpreis, bestellWert: rund(stueck * einzelpreis), verbrauchWert: rund(erwartetStueck * einzelpreis) });
  if (!geb) {
    return { ...basis, ...preise(basis.mengeMitReserve), gebindeName: null, gebindeStueck: null, gebindeAnzahl: null, bestellStueck: basis.mengeMitReserve, ueberschuss: Math.max(0, Math.round((basis.mengeMitReserve - erwartetStueck) * 10) / 10) };
  }
  const anzahl = aufrunden(basis.mengeMitReserve / geb.stueck);
  const bestell = anzahl * geb.stueck;
  return { ...basis, ...preise(bestell), gebindeName: geb.name, gebindeStueck: geb.stueck, gebindeAnzahl: anzahl, bestellStueck: bestell, ueberschuss: Math.round((bestell - erwartetStueck) * 10) / 10 };
}

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
      zeilen.push(mitGebinde({
        name: z.name, kategorie: z.kategorie, einheit: flasche.einheit, erwartet: Math.round(erwartet * 10) / 10,
        menge: aufrunden(erwartet / proFlasche), mengeMitReserve: aufrunden((erwartet * (1 + r)) / proFlasche),
        zaehleinheit: "Flaschen", hinweis: `= ${Math.round(erwartet)} Gläser (${proFlasche} Gläser pro Flasche)`,
      }, gebindeFuer(flasche) ?? gebindeFuer(z), erwartet / proFlasche, flasche.einkauf));
      continue;
    }
    const istSpritz = z.kategorie === "aperitif";
    zeilen.push(mitGebinde({
      name: z.name, kategorie: z.kategorie, einheit: z.einheit, erwartet: Math.round(erwartet * 10) / 10,
      menge: aufrunden(erwartet), mengeMitReserve: aufrunden(erwartet * (1 + r)),
      zaehleinheit: istSpritz ? "Spritz" : mass.typ === "glas" ? "Gläser" : "Stück",
      hinweis: istSpritz ? "Zutaten: Aperol, Prosecco, Soda, Orange" : "",
    }, gebindeFuer(z), erwartet, z.einkauf));
  }
  return zeilen;
}

/** Bestellliste als Text zum Kopieren (eine Zeile pro Getränk, bei Gebinde in ganzen Gebinden). */
export function bestellungAlsText(zeilen: BestellZeile[], mitReserve: boolean): string {
  return zeilen
    .map((z) => {
      if (z.gebindeAnzahl != null && z.gebindeStueck != null && mitReserve) {
        return `${z.gebindeAnzahl} ${z.gebindeName} à ${z.gebindeStueck} ${z.name} (${z.einheit}) = ${z.bestellStueck} ${z.zaehleinheit}`;
      }
      return `${mitReserve ? z.mengeMitReserve : z.menge} ${z.zaehleinheit} ${z.name} (${z.einheit})`;
    })
    .join("\n");
}

/** Summen der Bestellliste: Bestellwert, Wert des erwarteten Verbrauchs (= Einkauf der Kalkulation) und was ungeöffnet retour geht. */
export function bestellSummen(zeilen: BestellZeile[]) {
  const rund = (n: number) => Math.round(n * 100) / 100;
  const bestellWert = rund(zeilen.reduce((s, z) => s + z.bestellWert, 0));
  const verbrauchWert = rund(zeilen.reduce((s, z) => s + z.verbrauchWert, 0));
  return { bestellWert, verbrauchWert, retour: rund(bestellWert - verbrauchWert) };
}
