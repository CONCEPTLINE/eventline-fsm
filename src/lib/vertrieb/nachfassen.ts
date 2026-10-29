/**
 * Vertrieb › Kampagnen: wann ist bei einem Kontakt «Nachfassen» fällig?
 *
 * Fällig, wenn: Status «Angeschrieben» (gesendet), noch keine Antwort,
 * weniger als NACHFASS_MAX Runden, und die letzte Mail (Erstmail bzw. das
 * letzte Nachfassen) ist älter als NACHFASS_TAGE. Die Datenbank bekommt
 * NACHFASS_TAGE/NACHFASS_MAX als Parameter (vertrieb_kampagne_liste/
 * _uebersicht, Migration 366) und rechnet mit der DB-Zeit. nachfassStand()
 * dient nur der Anzeige im Detail.
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

// ── Datenschutz: Anrede und Namen vor dem KI-Aufruf neutralisieren (Audit M3) ──

const ANREDE_ZEILE = /^\s*(sehr geehrte[rsn]?|geehrte[rsn]?|geschätzte[rsn]?|liebe[rsn]?|hallo|guten tag|grüezi|grüss gott|dear|hello|hi|bonjour|madame|monsieur|chère|cher|buongiorno|buonasera|gentile|gentili|egregio|spettabile)\b/i;
const TITEL = new Set(["herr", "frau", "dr", "dr.", "prof", "prof.", "mr", "mrs", "ms", "mme", "m.", "sig.", "sig.ra", "dott."]);

export interface Neutralisiert {
  text: string;
  betreff: string;
  /** [Platzhalter, Original] — zum Wiedereinsetzen. */
  ersetzungen: [string, string][];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Ersetzt die Anrede-Zeile durch {ANREDE} und den Namen der Ansprechperson
 * (ganz und je Namensteil) durch {NAME}/{NAME2}… — so geht an die KI kein
 * Personenname. wiederEinsetzen() macht es rückgängig.
 */
export function neutralisiere(text: string, betreff: string, ansprechperson: string | null): Neutralisiert {
  const ersetzungen: [string, string][] = [];
  const zeilen = text.replace(/\r\n?/g, "\n").split("\n");
  const erste = zeilen.findIndex((z) => z.trim() !== "");
  if (erste >= 0 && ANREDE_ZEILE.test(zeilen[erste])) {
    ersetzungen.push(["{ANREDE}", zeilen[erste].trim()]);
    zeilen[erste] = "{ANREDE}";
  }
  let t = zeilen.join("\n");
  let b = betreff;
  const teile = (ansprechperson ?? "").split(/[\s,]+/).filter((x) => x.length >= 2 && !TITEL.has(x.toLowerCase()));
  const namen = [teile.join(" "), ...teile].filter((n, i, alle) => n && alle.indexOf(n) === i);
  namen.forEach((n, i) => {
    const platz = i === 0 ? "{NAME}" : `{NAME${i + 1}}`;
    const muster = `(?<![\\p{L}])${escapeRe(n)}(?![\\p{L}])`;
    const re = new RegExp(muster, "giu");
    const kommtVor = new RegExp(muster, "iu");
    if (kommtVor.test(t) || kommtVor.test(b)) {
      ersetzungen.push([platz, n]);
      t = t.replace(re, platz);
      b = b.replace(re, platz);
    }
  });
  return { text: t, betreff: b, ersetzungen };
}

/** Platzhalter zurück. Fehlt {ANREDE} im KI-Text, wird die Anrede vorangestellt. */
export function wiederEinsetzen(text: string, ersetzungen: [string, string][], istText = true): string {
  let t = text;
  const anrede = ersetzungen.find(([p]) => p === "{ANREDE}");
  if (istText && anrede && !t.includes("{ANREDE}")) t = `{ANREDE}\n\n${t.trimStart()}`;
  // Längere Platzhalter zuerst ({NAME2} vor {NAME}).
  for (const [platz, original] of [...ersetzungen].sort((a, b) => b[0].length - a[0].length)) {
    t = t.split(platz).join(original);
  }
  // Übrig gebliebene, unbekannte Platzhalter nie ausliefern.
  return t.replace(/\{(ANREDE|NAME\d*)\}/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
