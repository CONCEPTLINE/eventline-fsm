// Getränke-Catering — Kategorien der Getränkekarte (client- und serverseitig nutzbar).
export const KATEGORIE_REIHENFOLGE = ["aperitif", "weisswein", "rotwein", "bier", "softdrink"] as const;
export type KartenKategorie = (typeof KATEGORIE_REIHENFOLGE)[number];
export const KATEGORIE_TITEL: Record<KartenKategorie, string> = {
  aperitif: "Aperitif",
  weisswein: "Weisswein",
  rotwein: "Rotwein",
  bier: "Bier",
  softdrink: "Mineral & Softdrinks",
};
