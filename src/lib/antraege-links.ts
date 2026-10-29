// Seite «Anträge» (/antraege): Reiter «Rechte & Lohndaten» (Vier Augen bei
// Rechten und Lohndaten, früher eigene Seite /rechte-antraege). Eine Quelle für
// alle Links dorthin — Glocke, Toast-Aktionen, Dashboard, Befehlspalette — und
// für die Umleitung der alten Adresse. Rein (Browser + Server).

/** Wert von ?tab= für den Reiter «Rechte & Lohndaten». */
export const ANTRAEGE_TAB_RECHTE = "rechte";

/** /antraege?tab=rechte[&id=…][&from=…] — `id` markiert einen Antrag (Deep-Link). */
export function rechteAntraegeHref(opts: { id?: string | null; from?: string } = {}): string {
  const p = new URLSearchParams({ tab: ANTRAEGE_TAB_RECHTE });
  if (opts.id) p.set("id", opts.id);
  if (opts.from) p.set("from", opts.from);
  return `/antraege?${p.toString()}`;
}
