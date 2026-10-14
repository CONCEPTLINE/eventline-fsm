// Fragen-Erkennung fuer die NAS-Suche: Ist der Suchtext eine Frage an den
// INHALT der Dokumente (→ automatisch die lokale KI fragen) oder nur ein
// Stichwort (→ nur Suche)? Bewusst deterministisch und streng — jede erkannte
// Frage ist ein Auftrag an das Rig. Regeln:
//  - mindestens 3 Woerter (Stichworte wie «Mietvertrag Scala» sind nie Fragen),
//  - UND endet auf «?» ODER beginnt mit einem Fragewort/-muster.
// Fragewoerter als feste Liste statt «wo…»/«w…»: sonst waeren «Wohnung»,
// «Woche» oder «Werkvertrag» Fragen.

import { KI_ARCHIV_FRAGE_MAX, KI_ARCHIV_FRAGE_MIN } from "@/lib/ki/konstanten";

const MIN_WOERTER = 3;

const FRAGE_ANFANG = new RegExp(
  "^(" +
    [
      // W-Woerter (inkl. «wie viel(e)», «wie hoch», «wie lange» über «wie»)
      "wer", "wen", "wem", "wessen", "was", "wann", "wo", "wie", "warum", "wieso", "weshalb", "weswegen",
      "welche[rsmn]?", "wofür", "woher", "wohin", "womit", "wozu", "worüber", "worauf", "woran", "wovon",
      "wodurch", "worin", "wonach",
      // Zeit-Muster
      "bis wann", "seit wann", "ab wann",
      // «gibt es …» und Ja/Nein-Fragen mit Hilfs-/Modalverb am Anfang
      "gibt es", "gab es", "hat", "haben", "hatte", "hatten", "ist", "sind", "war", "waren", "wird", "werden",
      "wurde", "wurden", "kann", "können", "muss", "müssen", "darf", "dürfen", "soll", "sollen", "gilt",
    ].join("|") +
    ")(?=[\\s,.:;!?]|$)",
  "i",
);

/** Gleiche Normalisierung wie beim Absenden der Frage (Leerraum zusammenfassen). */
export function normalisiereFrage(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function woerter(text: string): number {
  return text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Ist der Suchtext eine Frage an die Dokumente? (siehe Regeln oben) */
export function istArchivFrage(text: string): boolean {
  const t = normalisiereFrage(text);
  if (t.length < KI_ARCHIV_FRAGE_MIN || t.length > KI_ARCHIV_FRAGE_MAX) return false;
  if (woerter(t) < MIN_WOERTER) return false;
  return t.endsWith("?") || FRAGE_ANFANG.test(t);
}
