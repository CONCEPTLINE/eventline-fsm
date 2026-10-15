// Grenzen fuer «Mein Wissen» im Lieferantenportal — eine Quelle fuer die
// Eingabefelder (maxLength/max) und die Pruefung in /api/lieferant/wissen.
// Das Stichwort wird als Teilwort gegen neue Technik-Positionen geprueft
// (passendeRegeln in src/lib/technik.ts): mit nur einem Zeichen passte es
// auf fast jede Position, darum mindestens zwei.
export const WISSEN_GRENZEN = {
  stichwortMin: 2,
  stichwortMax: 60,
  hinweisMax: 300,
  bezeichnungMax: 120,
  kategorieMax: 60,
  mengeMax: 999,
  positionenMax: 20,
} as const;
