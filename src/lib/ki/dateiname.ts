// Neuer Dateiname fuer die NAS-Ablage (Migration 329): Namensvorschlag der
// Nachtarbeit (Rig, `name_vorschlag`) und der Name, den ein Admin beim
// «Uebernehmen» eintippt. Rein und ohne Server-Importe — dieselbe Pruefung
// laeuft im Browser (Hinweis unter dem Eingabefeld), in POST
// /api/ki/nachtarbeit und in /api/ablage/nas-vorschlaege.
//
// Regeln:
//  - trim + NFC; keine / \ : * ? " < > |, keine Steuerzeichen, nicht mit
//    «.» beginnen, hoechstens 160 Zeichen.
//  - Endung (case-insensitiv) gleich der des Originals — sonst oeffnet die
//    Datei nicht mehr. Gleich dem Originalnamen -> kein neuer Name.
//  - Inhalts-Filter (Mischa): ein Dateiname nennt nie Inhaltsdetails.
//    Betraege, Prozent, IBAN, AHV, Telefon, E-Mail, lange Zahlen (ausser
//    Datum), Nummern (Nr./No./#), Adressen (Strasse + Hausnummer bis 3 Ziffern, PLZ + Ort)
//    und Gesundheits-/Kuendigungsgrund-Woerter -> der Name wird VERWORFEN,
//    nie «repariert».
//  - Grenzen der Heuristik: «PLZ + Ort» laesst 1900–2099 als Jahr durch
//    (sonst fiele «2025_Arbeitsvertrag» weg); Woerter wie «Krankenkasse»
//    fallen bewusst mit weg (lieber kein neuer Name als ein falscher).

export const DATEINAME_MAX = 160;

export type DateinamePruefung = { ok: true; name: string } | { ok: false; grund: string };

const RE_VERBOTEN = /[/\\:*?"<>|]/;
const RE_STEUER = /[\u0000-\u001f\u007f]/;
/** Endung: letzter Punkt (nicht an Stelle 0), danach 1–10 Buchstaben/Ziffern. */
const RE_ENDUNG = /(?<=.)\.([A-Za-z0-9]{1,10})$/;

/** Endung in Kleinbuchstaben ohne Punkt, "" ohne Endung. */
export function dateiEndung(name: string): string {
  const m = RE_ENDUNG.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// ── Inhalts-Filter ──────────────────────────────────────────────────────
// Dateinamen trennen mit _ - . und Leerzeichen; `\b` taugt nicht (_ ist ein
// Wortzeichen), daher eigene Grenzen per Lookaround.
const S = "[\\s_.\\-]*";
const INHALT: readonly { re: RegExp; grund: string }[] = [
  { re: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, grund: "E-Mail-Adresse" },
  { re: /(?<![A-Za-z0-9])(?:CH|LI|DE|AT|FR|IT|NL|BE|LU|ES|GB)\d{2}(?:[\s_\-]?[0-9A-Z]){12,}/, grund: "Kontonummer (IBAN)" },
  { re: /(?<!\d)756[.\s_\-]?\d{4}[.\s_\-]?\d{4}[.\s_\-]?\d{2}(?!\d)/, grund: "AHV-Nummer" },
  { re: /(?:\+|(?<!\d)00)\d{2}(?:[\s_.\-]?\d){6,}/, grund: "Telefonnummer" },
  { re: /(?<!\d)0\d{2}[\s_.\-]?\d{3}[\s_.\-]?\d{2}[\s_.\-]?\d{2}(?!\d)/, grund: "Telefonnummer" },
  { re: new RegExp(`(?<!\\p{L})(?:CHF|SFR|EUR|USD)${S}\\d`, "iu"), grund: "Betrag" },
  { re: new RegExp(`\\d${S}(?:CHF|SFR|EUR|USD)(?!\\p{L})`, "iu"), grund: "Betrag" },
  { re: new RegExp(`(?<!\\p{L})S?Fr${S}\\d`, "u"), grund: "Betrag" },
  { re: new RegExp(`\\d${S}S?Fr(?!\\p{L})`, "u"), grund: "Betrag" },
  { re: /[€$£]\s*\d|\d\s*[€$£]/, grund: "Betrag" },
  { re: /\d\.[–—-]/, grund: "Betrag" },
  { re: /\d\s*%|%\s*\d|prozent/i, grund: "Prozentangabe" },
  { re: new RegExp(`(?:(?<!\\p{L})(?:Nr|No)|nummer)${S}:?${S}\\d`, "iu"), grund: "Nummer (Nr./No.)" },
  { re: /#\s*\d/, grund: "Nummer (#)" },
  { re: new RegExp(`(?:strasse|straße|str\\.?|weg|gasse|platz|allee)${S}\\d{1,3}(?!\\d)`, "iu"), grund: "Adresse" },
  { re: /(?<![A-Za-z])CH[\s\-]?\d{4}(?!\d)/, grund: "Adresse (PLZ)" },
  {
    re: /krank|arzt|ärzt|diagnose|therapie|schwanger|burn[\s_\-]?out|unfallhergang|kündigungsgrund|kuendigungsgrund|fristlos[\s_\-]+wegen/iu,
    grund: "Gesundheits- oder Kündigungsangabe",
  },
];

/** Gueltiges Datum aus Jahr/Monat/Tag (Kalender, keine Uhrzeit). */
function istDatum(j: number, m: number, t: number): boolean {
  if (m < 1 || m > 12 || t < 1) return false;
  return t <= new Date(Date.UTC(j, m, 0)).getUTCDate();
}

/** Ziffernfolgen ab 5 Ziffern — erlaubt nur ein Datum: YYYYMMDD (19xx/20xx)
 *  ueberall, YYMMDD nur am Anfang des Namens. */
function hatLangeZahl(stamm: string): boolean {
  for (const m of stamm.matchAll(/\d{5,}/g)) {
    const z = m[0];
    if (z.length === 8 && /^(19|20)/.test(z) && istDatum(+z.slice(0, 4), +z.slice(4, 6), +z.slice(6, 8))) continue;
    if (z.length === 6 && m.index === 0 && istDatum(2000 + +z.slice(0, 2), +z.slice(2, 4), +z.slice(4, 6))) continue;
    return true;
  }
  return false;
}

/** PLZ (1000–9999, ohne 1900–2099 = Jahr) + Ortsname mit Grossbuchstaben. */
function hatPlzOrt(stamm: string): boolean {
  for (const m of stamm.matchAll(/(?<![\d.])([1-9]\d{3})[\s_\-]+\p{Lu}\p{Ll}{2,}/gu)) {
    const plz = +m[1];
    if (plz < 1900 || plz > 2099) return true;
  }
  return false;
}

/** Inhaltsangabe im Namen? Liefert den Grund oder null. */
export function inhaltImNamen(name: string): string | null {
  const stamm = name.normalize("NFC");
  for (const { re, grund } of INHALT) if (re.test(stamm)) return grund;
  if (hatLangeZahl(stamm)) return "lange Zahl (Nummer)";
  if (hatPlzOrt(stamm)) return "Adresse (PLZ und Ort)";
  return null;
}

/** Prueft einen neuen Dateinamen gegen den aktuellen. `grund` ist eine
 *  kurze deutsche Meldung fuer die Oberflaeche. */
export function pruefeDateiname(roh: unknown, originalName: string): DateinamePruefung {
  if (typeof roh !== "string") return { ok: false, grund: "kein Name" };
  const name = roh.trim().normalize("NFC");
  const original = originalName.normalize("NFC");
  if (!name) return { ok: false, grund: "leer" };
  if (name === original) return { ok: false, grund: "unverändert" };
  if (RE_VERBOTEN.test(name)) return { ok: false, grund: 'unerlaubtes Zeichen (/ \\ : * ? " < > |)' };
  if (RE_STEUER.test(name)) return { ok: false, grund: "unerlaubtes Steuerzeichen" };
  if (name.startsWith(".")) return { ok: false, grund: "darf nicht mit einem Punkt beginnen" };
  if (name.length > DATEINAME_MAX) return { ok: false, grund: `höchstens ${DATEINAME_MAX} Zeichen` };
  const endung = dateiEndung(original);
  if (dateiEndung(name) !== endung) return { ok: false, grund: endung ? `Endung muss .${endung} bleiben` : "ohne Endung lassen" };
  const stamm = endung ? name.slice(0, -(endung.length + 1)) : name;
  if (!stamm.trim()) return { ok: false, grund: "leer" };
  const inhalt = inhaltImNamen(stamm);
  if (inhalt) return { ok: false, grund: `enthält Inhaltsangabe: ${inhalt}` };
  return { ok: true, name };
}

/** Neuer Dateiname oder null (ungueltig, Inhaltsangabe, unveraendert). */
export function pruefeNeuenDateinamen(roh: unknown, originalName: string): string | null {
  const r = pruefeDateiname(roh, originalName);
  return r.ok ? r.name : null;
}
