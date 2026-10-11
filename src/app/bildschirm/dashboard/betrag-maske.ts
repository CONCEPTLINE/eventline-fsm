// Geldbetraege in Freitext (Todo-Titel) fuer den Buero-Bildschirm maskieren.
// Der Monitor ist fuer alle im Buero sichtbar — CHF-Betraege sind dort tabu.
// Serverseitig aufgerufen (/api/bildschirm/daten), bevor ein Titel die
// Datenbank-Seite verlaesst. Bewusst ohne Abhaengigkeiten (auch per
// node --experimental-strip-types testbar).
//
// Maskiert wird nur ein Betrag MIT Waehrung (davor oder danach); eine nackte
// Zahl bleibt stehen — sonst verschwaenden Jahreszahlen, Uhrzeiten und
// Auftragsnummern.
//
//   "Offerte CHF 1'250.50 nachfassen"   → "Offerte CHF … nachfassen"
//   "Anzahlung 2'000.– CHF pruefen"     → "Anzahlung CHF … pruefen"
//   "Fr. 350.- an Lieferant"            → "CHF … an Lieferant"
//   "Spesen 1 250 Franken"              → "Spesen CHF …"
//   "Rechnung € 99,90 / 45 EUR"         → "Rechnung CHF … / CHF …"
//   "Budget 2026"                       → unveraendert (keine Waehrung)
//   "Abbau 12.30 Uhr" / "INT-26311"     → unveraendert
//   "Lieferung Fr 17.10."               → unveraendert (Freitag, kein Betrag)
//   "Aufbau Fr 12.30 Uhr" / "Fr 9:00"   → unveraendert (Freitag + Uhrzeit)

const MASKE = "CHF …";

/** Zahl: 1250 · 1'250 · 1’250 · 1 250 · 1.250,50 · 1'250.50 · 2'000.– · 350.- · 5k · 1.2 Mio. */
const ZAHL =
  String.raw`(?:\d{1,3}(?:['’   .]\d{3})+|\d+)` +
  String.raw`(?:[.,](?:\d{1,2}|[-–—]{1,2}))?` +
  String.raw`(?!\d)` +
  String.raw`(?:\s?(?:k|Mio\.?|Mrd\.?|Tsd\.?)(?![A-Za-zÄÖÜäöü]))?`;

/** Waehrungswoerter (ohne €, das kein Wortzeichen ist). Laengere zuerst. */
const WORT = String.raw`(?:CHF|SFr\.?|Franken|Fr\.?|EUR|Euro)`;
const KEIN_BUCHSTABE_DAVOR = String.raw`(?<![A-Za-zÄÖÜäöüß\d])`;
const KEIN_BUCHSTABE_DANACH = String.raw`(?![A-Za-zÄÖÜäöüß])`;

/** Waehrung vor dem Betrag: "CHF 1'250.50", "Fr.350.-", "€ 99,90", "CHF: 500". */
const VORNE = new RegExp(
  String.raw`(?:${KEIN_BUCHSTABE_DAVOR}(${WORT})|(€))\s*:?\s*(${ZAHL})`,
  "giu",
);
/** Waehrung nach dem Betrag: "2'000.– CHF", "45 EUR", "99,90€". Kein Treffer
 *  mitten in einer Kennung ("INT-26311 CHF" → davor steht "-"/Ziffer) und
 *  nicht bei "2 Euro-Paletten". */
const HINTEN = new RegExp(
  String.raw`(?<![\w\-'’.,])(${ZAHL})\s*(?:(?:CHF|SFr\.?|Franken|Fr\.?|EUR)${KEIN_BUCHSTABE_DANACH}|Euro(?![A-Za-zÄÖÜäöüß\-])|€)`,
  "giu",
);

/** "Fr" ist auch die Abkuerzung fuer Freitag: "Fr 17.10." / "Fr. 17.10" /
 *  "Fr 17." sind Daten, "Fr 12.30 Uhr" / "Fr 9:00" Uhrzeiten — keine Betraege. */
function istFreitag(waehrung: string, zahl: string, rest: string): boolean {
  if (!/^fr\.?$/i.test(waehrung)) return false;
  if (/^:\d/.test(rest)) return true;
  const zeit = /^(\d{1,2})[.,](\d{2})$/.exec(zahl);
  if (zeit && /^\s*h?\s*Uhr/i.test(rest) && Number(zeit[1]) <= 23 && Number(zeit[2]) <= 59) return true;
  const datum = /^(\d{1,2})\.(\d{1,2})$/.exec(zahl);
  if (datum) return Number(datum[1]) >= 1 && Number(datum[1]) <= 31 && Number(datum[2]) >= 1 && Number(datum[2]) <= 12;
  const tag = /^(\d{1,2})$/.exec(zahl);
  return !!tag && (rest.charAt(0) === "." || /^\s*Uhr/i.test(rest)) && Number(tag[1]) >= 0 && Number(tag[1]) <= 31;
}

export function betraegeMaskieren(text: string): string {
  const vorne = text.replace(VORNE, (treffer: string, wort: string | undefined, _euro: string | undefined, zahl: string, pos: number, ganz: string) => {
    if (wort && istFreitag(wort, zahl, ganz.slice(pos + treffer.length))) return treffer;
    return MASKE;
  });
  return vorne.replace(HINTEN, MASKE);
}
