/**
 * Vertrieb › Kampagnen: wann ist bei einem Kontakt «Nachfassen» fällig?
 *
 * Fällig, wenn: Status «Angeschrieben» (gesendet), noch keine Antwort,
 * weniger als NACHFASS_MAX Runden, und die letzte Mail (Erstmail bzw. das
 * letzte Nachfassen) ist älter als NACHFASS_TAGE. Die Datenbank bekommt
 * die Schwelle als Parameter (vertrieb_kampagne_liste/_uebersicht,
 * Migration 366) — die Regel lebt nur hier.
 */

export const NACHFASS_TAGE = 10;
export const NACHFASS_MAX = 2;

const TAG = 24 * 60 * 60 * 1000;

export interface NachfassFelder {
  status: string;
  antworten_anzahl: number;
  nachfass_anzahl: number;
  mail_gesendet_am: string | null;
  nachgefasst_am: string | null;
}

/** Zeitpunkt, vor dem die letzte Mail liegen muss, damit Nachfassen fällig ist. */
export function faelligVor(jetzt: Date = new Date()): string {
  return new Date(jetzt.getTime() - NACHFASS_TAGE * TAG).toISOString();
}

export interface NachfassStand {
  /** Kommt Nachfassen für diesen Kontakt überhaupt (noch) in Frage? */
  moeglich: boolean;
  faellig: boolean;
  /** Ab wann fällig (ISO) — null, wenn nicht möglich. */
  faelligAb: string | null;
  /** Alle Runden gemacht. */
  fertig: boolean;
}

export function nachfassStand(k: NachfassFelder, jetzt: Date = new Date()): NachfassStand {
  const fertig = k.nachfass_anzahl >= NACHFASS_MAX;
  const basis = k.nachgefasst_am ?? k.mail_gesendet_am;
  const t = basis ? Date.parse(basis) : NaN;
  const moeglich = k.status === "gesendet" && k.antworten_anzahl === 0 && !fertig && !Number.isNaN(t);
  if (!moeglich) return { moeglich: false, faellig: false, faelligAb: null, fertig };
  const ab = t + NACHFASS_TAGE * TAG;
  return { moeglich, faellig: ab < jetzt.getTime(), faelligAb: new Date(ab).toISOString(), fertig };
}

// ── Nachfass-Text (KI-Vorschlag) prüfen ────────────────────────────────

/** Raumnamen, die in Akquise-Mails nie vorkommen dürfen (Leo). */
export const VERBOTENE_RAUMNAMEN = /\b(bau\s?3|barakuba|scala|tanzhaus)\b/i;

const GRUSS_ZEILE = /^\s*(freundliche[n]? grüsse|beste grüsse|herzliche grüsse|liebe grüsse|mit freundlichen grüssen|viele grüsse|grüsse|kind regards|best regards|regards|best|cordiali saluti|distinti saluti|meilleures salutations|cordialement|bien à vous)\b/i;

/**
 * KI-Text in die Hausregeln bringen: ß → ss, Gruss/Signatur am Ende weg,
 * Leerraum aufräumen. Gibt `raumname: true` zurück, wenn ein verbotener
 * Raumname drinsteht (dann neu erzeugen statt ausliefern).
 */
export function bereinigeNachfassText(text: string): { text: string; raumname: boolean } {
  const zeilen = text.replace(/ß/g, "ss").replace(/\r\n?/g, "\n").split("\n");
  const gruss = zeilen.findIndex((z, i) => i > 0 && GRUSS_ZEILE.test(z));
  const bis = gruss >= 0 ? gruss : zeilen.length;
  const sauber = zeilen.slice(0, bis).map((z) => z.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: sauber, raumname: VERBOTENE_RAUMNAMEN.test(sauber) };
}
