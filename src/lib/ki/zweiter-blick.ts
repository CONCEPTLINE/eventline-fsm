// Zweiter Blick (Migration 347, 16.10.2026): nachts liest das Hauptmodell der lokalen KI (Gemma 4 26B, auf dem Rig
// nur im Nachtfenster) Dokumente im Rueckstau ZZ mit offenem, unentschiedenem Vorschlag nochmals. Ist sein Beschrieb
// inhaltlich anders oder vollstaendiger als der des schnellen Modells, meldet das Rig ihn mit dem Rezept des Beschriebs
// plus «+zb» (z. B. «zz/v4+zb», rig/eventline-ki/dienst/app/jobs/zweiter_blick.py). Die Warteschlange fragt Claude
// erneut und ersetzt den offenen Vorschlag — nur, wenn er noch offen und nie entschieden ist.
//
// Rein (getestet). Regeln:
//  - Ein Vorschlag aus dem zweiten Blick wird nie von einem Beschrieb des schnellen Modells DESSELBEN Rezepts ersetzt
//    (das kleine Modell ueberstimmt das grosse nicht); ein neueres Rezept ersetzt ihn wie jeden aelteren.
//  - Wartet fuer dieselbe Datei schon der zweite Blick, ist der Beschrieb des schnellen Modells ueberholt — die
//    Warteschlange fragt Claude dafuer nicht mehr (spart einen Aufruf).

export const ZWEITER_BLICK_ZUSATZ = "+zb";

export function istZweiterBlick(rezept: string | null | undefined): boolean {
  return typeof rezept === "string" && rezept.length > ZWEITER_BLICK_ZUSATZ.length && rezept.endsWith(ZWEITER_BLICK_ZUSATZ);
}

/** «zz/v4+zb» → «zz/v4»; ohne Zusatz unveraendert. */
export function basisRezept(rezept: string): string {
  return istZweiterBlick(rezept) ? rezept.slice(0, -ZWEITER_BLICK_ZUSATZ.length) : rezept;
}

/** true = der offene Vorschlag (Rezept `alt`) ist der zweite Blick desselben Rezepts wie der neue Beschrieb des
 *  schnellen Modells (`neu`) — er bleibt (doppelt). */
export function zweiterBlickBleibt(alt: string | null | undefined, neu: string): boolean {
  return !istZweiterBlick(neu) && alt === neu + ZWEITER_BLICK_ZUSATZ;
}

/** Schluessel Datei-Inhalt + Rezept (ohne Zusatz) — damit ein wartender zweiter Blick den Beschrieb des schnellen
 *  Modells derselben Datei findet. */
export function zweiterBlickSchluessel(pfad: string, sha256: string | null, rezept: string): string {
  return `${pfad.normalize("NFC")}\u0000${sha256 ?? ""}\u0000${basisRezept(rezept)}`;
}

/** Text fuer das Kennzeichen «zweiter Blick» in der Liste (Tooltip): was es heisst und ob sich der Vorschlag
 *  dadurch geaendert hat (ersetzt_* aus Migration 347; null = es gab keinen offenen Vorschlag davor). */
export function zweiterBlickHinweis(v: {
  ziel_ordner: string;
  name_vorschlag: string | null;
  ersetzt_ziel: string | null;
  ersetzt_name: string | null;
}): string {
  const basis = "Nachts nochmals gelesen vom grossen Modell der lokalen KI — genauerer Beschrieb, Claude hat neu vorgeschlagen";
  if (v.ersetzt_ziel === null) return basis;
  const ordner = v.ersetzt_ziel.normalize("NFC") !== v.ziel_ordner.normalize("NFC");
  const name = (v.ersetzt_name ?? "").normalize("NFC") !== (v.name_vorschlag ?? "").normalize("NFC");
  if (!ordner && !name) return `${basis} · Ordner und Name wie vorher`;
  const teile = [
    ordner ? `Ordner vorher: ${v.ersetzt_ziel}` : null,
    name ? (v.ersetzt_name ? `Name vorher: ${v.ersetzt_name}` : "vorher ohne neuen Namen") : null,
  ];
  return `${basis} · ${teile.filter(Boolean).join(" · ")}`;
}
