// Doppel-Pruefung der lokalen KI (docs/lokale-ki/SPEC.md §7 2026-10-15, Migration 330). Rein, ohne I/O —
// geteilt von den Routen (POST /api/ki/doppel vom Rig, GET/POST /api/ablage/doppel) und der NAS-Seite.
//
// Das Rig (rig/eventline-ki/dienst/app/duplikate.py) vergleicht alle NAS-Dateien lokal und meldet NUR Pfade,
// Groessen, Zeiten und Aehnlichkeitswerte, nie Text:
//   art «gleich»  — Gruppe gleicher Dateien: exakt gleiche Bytes (gleiche `kopie`) oder gleicher Inhalt in
//                   anderer Form (DOCX ↔ PDF, Scan, umbenannt — andere `kopie`).
//   art «fassung» — Paar neu → alt (`rolle`): dasselbe Dokument in einer neueren Fassung.
// Nichts wird automatisch verschoben: «Doppel entfernen» verschiebt nur auf Klick in den Quarantaene-Ordner
// 99_System/Duplikate/<Datum>/<Ordner> (nie endgueltig loeschen); «Als neue Fassung ablegen» legt die alte Datei in
// den Historie-Ordner daneben und die neue an ihren Platz.

import { KI_PFAD_MAX } from "./konstanten";
import { hatZzSegment } from "./pfade";

/** Quarantaene fuer entfernte Doppel (99_System ist vom Scan ausgeschlossen — taucht nie in Auswahl/Suche auf). */
export const DOPPEL_QUARANTAENE = "99_System/Duplikate";
/** Hoechstens so viele Gruppen je Meldung des Rigs (Paket; das Rig schickt 150). */
export const DOPPEL_MAX_GRUPPEN = 300;
/** Hoechstens so viele Mitglieder je Gruppe. */
export const DOPPEL_MAX_MITGLIEDER = 50;

export type DoppelArt = "gleich" | "fassung";

export interface DoppelMitgliedRig {
  pfad: string;
  groesse: number | null;
  geaendert: string | null;
  kopie: number | null;
  rolle: "neu" | "alt" | null;
  aehnlichkeit: number | null;
}

export interface DoppelGruppeRig {
  gruppe: string;
  art: DoppelArt;
  mitglieder: DoppelMitgliedRig[];
}

export interface DoppelMeldung {
  lauf_id: string;
  letzter: boolean;
  gruppen: DoppelGruppeRig[];
}

/** Ein Mitglied, wie GET /api/ablage/doppel es liefert (Pfad in der Schreibweise des Datei-Index). */
export interface DoppelMitglied {
  pfad: string;
  name: string;
  ordner: string;
  groesse: number | null;
  geaendert: string | null;
  kopie: number | null;
  rolle: "neu" | "alt" | null;
  aehnlichkeit: number | null;
  /** Liegt im Rueckstau (ZZ_*-Ordner). */
  zz: boolean;
}

export interface DoppelGruppe {
  gruppe: string;
  art: DoppelArt;
  mitglieder: DoppelMitglied[];
}

/** Ergebnis des Rigs fuer eine neu abgelegte Datei (ablage_analyse, Feld `doppel`). */
export interface AblageDoppel {
  art: "exakt" | "inhalt" | "fassung";
  pfad: string;
  aehnlichkeit: number;
}

const GRUPPE_RE = /^[gf]:[0-9a-f]{8,32}$/;
const LAUF_RE = /^[0-9A-Za-z_-]{6,40}$/;

/** NAS-Pfad vom Rig: relativ, ohne «..», ohne Steuerzeichen, nicht im Systembereich, hoechstens KI_PFAD_MAX. NFC. */
export function leseDoppelPfad(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const p = roh.normalize("NFC").trim();
  if (!p || p.length > KI_PFAD_MAX || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) return null;
  const teile = p.split("/");
  if (teile.length < 2 || teile.some((t) => !t || t === "." || t === "..")) return null;
  if (teile[0] === "99_System") return null;
  return p;
}

function zahlOderNull(x: unknown, min: number, max: number): number | null {
  const n = typeof x === "number" ? x : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Body von POST /api/ki/doppel pruefen. Ungueltige Mitglieder fallen weg, Gruppen mit weniger als zwei auch. */
export function leseDoppelMeldung(body: unknown): { ok: true; meldung: DoppelMeldung } | { ok: false; fehler: string } {
  if (!body || typeof body !== "object") return { ok: false, fehler: "Body fehlt" };
  const b = body as Record<string, unknown>;
  const lauf = typeof b.lauf_id === "string" ? b.lauf_id : "";
  if (!LAUF_RE.test(lauf)) return { ok: false, fehler: "lauf_id fehlt oder ist ungültig" };
  if (!Array.isArray(b.gruppen)) return { ok: false, fehler: "gruppen fehlt" };
  if (b.gruppen.length > DOPPEL_MAX_GRUPPEN) return { ok: false, fehler: `höchstens ${DOPPEL_MAX_GRUPPEN} Gruppen je Meldung` };
  const gruppen: DoppelGruppeRig[] = [];
  for (const g of b.gruppen as unknown[]) {
    if (!g || typeof g !== "object") continue;
    const r = g as Record<string, unknown>;
    const art = r.art === "gleich" || r.art === "fassung" ? r.art : null;
    const schluessel = typeof r.gruppe === "string" && GRUPPE_RE.test(r.gruppe) ? r.gruppe : null;
    if (!art || !schluessel || !Array.isArray(r.mitglieder)) continue;
    const gesehen = new Set<string>();
    const mitglieder: DoppelMitgliedRig[] = [];
    for (const m of (r.mitglieder as unknown[]).slice(0, DOPPEL_MAX_MITGLIEDER)) {
      if (!m || typeof m !== "object") continue;
      const x = m as Record<string, unknown>;
      const pfad = leseDoppelPfad(x.pfad);
      if (!pfad || gesehen.has(pfad)) continue;
      gesehen.add(pfad);
      const mtime = zahlOderNull(x.mtime, 0, 4_102_444_800); // bis 2100
      const rolle = art === "fassung" && (x.rolle === "neu" || x.rolle === "alt") ? x.rolle : null;
      if (art === "fassung" && !rolle) continue;
      mitglieder.push({
        pfad,
        groesse: zahlOderNull(x.groesse, 0, Number.MAX_SAFE_INTEGER),
        geaendert: mtime === null ? null : new Date(mtime * 1000).toISOString(),
        kopie: art === "gleich" ? zahlOderNull(x.kopie, 1, 100) : null,
        rolle,
        aehnlichkeit: zahlOderNull(x.aehnlichkeit, 0, 1),
      });
    }
    if (mitglieder.length < 2) continue;
    if (art === "fassung" && (mitglieder.length !== 2 || mitglieder[0].rolle === mitglieder[1].rolle)) continue;
    gruppen.push({ gruppe: schluessel, art, mitglieder });
  }
  return { ok: true, meldung: { lauf_id: lauf, letzter: b.letzter === true, gruppen } };
}

/** Feld `doppel` eines ablage_analyse-Ergebnisses (Upload/Mail-Eingang) pruefen. */
export function leseAblageDoppel(roh: unknown): AblageDoppel | null {
  if (!roh || typeof roh !== "object") return null;
  const r = roh as Record<string, unknown>;
  const art = r.art === "exakt" || r.art === "inhalt" || r.art === "fassung" ? r.art : null;
  const pfad = leseDoppelPfad(r.pfad);
  const wert = zahlOderNull(r.aehnlichkeit, 0, 1);
  if (!art || !pfad) return null;
  return { art, pfad, aehnlichkeit: wert ?? (art === "exakt" ? 1 : 0) };
}

/** Datum im Format JJJJ-MM-TT in Europe/Zurich (Name des Quarantaene-Unterordners). */
export function datumZuerich(jetzt: Date): string {
  const t = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" });
  return t.format(jetzt);
}

/** Zielordner der Quarantaene: 99_System/Duplikate/<Datum>/<bisheriger Ordner> — die Herkunft bleibt sichtbar. */
export function quarantaeneOrdner(ordner: string, jetzt: Date): string {
  const basis = `${DOPPEL_QUARANTAENE}/${datumZuerich(jetzt)}`;
  return ordner ? `${basis}/${ordner}` : basis;
}

const HISTORIE_RE = /histor/i;
const NUMMER_RE = /^(\d{2})_/;

/** Historie-Ordner fuer eine Datei im Ordner `ordner`, nach der Benennung im Haus («Historie», «02_Historie»,
 *  «03_Inventarliste_Historie»): gibt es schon einen Unterordner mit «Historie», wird er genommen; sonst neu —
 *  tragen alle Unterordner eine Nummer «NN_», dann «<naechste Nummer>_Historie», sonst «Historie».
 *  `unterordner` = direkte Unterordner (volle Pfade). Nie ein ZZ_-Name (sonst landete die alte Fassung im Rueckstau). */
export function historieFuer(ordner: string, unterordner: readonly string[]): { pfad: string; neu: boolean } {
  const direkt = unterordner
    .filter((p) => p.startsWith(ordner + "/") && !p.slice(ordner.length + 1).includes("/"))
    .map((p) => p.slice(ordner.length + 1));
  const vorhanden = direkt.find((n) => HISTORIE_RE.test(n) && !/^zz_/i.test(n));
  if (vorhanden) return { pfad: `${ordner}/${vorhanden}`, neu: false };
  const nummern = direkt.map((n) => NUMMER_RE.exec(n)?.[1]).filter((x): x is string => !!x).map(Number);
  if (direkt.length > 0 && nummern.length === direkt.length) {
    const naechste = String(Math.min(99, Math.max(...nummern) + 1)).padStart(2, "0");
    return { pfad: `${ordner}/${naechste}_Historie`, neu: true };
  }
  return { pfad: `${ordner}/Historie`, neu: true };
}

/** Liegt die Datei schon in einem Historie-Ordner? (Dann bleibt sie dort; die neue kommt in den Ordner darueber.) */
export function liegtInHistorie(pfad: string): boolean {
  return pfad.split("/").slice(0, -1).some((s) => HISTORIE_RE.test(s));
}

/** Schluessel eines «Beide behalten»-Paars (Reihenfolge egal, NFC). */
export function behaltenPaar(a: string, b: string): [string, string] {
  const x = a.normalize("NFC");
  const y = b.normalize("NFC");
  return x <= y ? [x, y] : [y, x];
}

export function ordnerVonPfad(pfad: string): string {
  const i = pfad.lastIndexOf("/");
  return i === -1 ? "" : pfad.slice(0, i);
}

export function nameVonPfad(pfad: string): string {
  return pfad.slice(pfad.lastIndexOf("/") + 1);
}

/** Hinweis fuer EINE Datei (Zeile im Rueckstau ZZ): exakt vor gleichem Inhalt vor Fassung. `andere` = die anderen
 *  Dateien, einsortierte zuerst (ausserhalb ZZ). null = kein Doppel bekannt. */
export type DoppelHinweis =
  | { art: "exakt" | "inhalt"; andere: DoppelMitglied[] }
  | { art: "fassung_neu" | "fassung_alt"; andere: DoppelMitglied[] };

export function hinweisFuer(pfad: string, gruppen: readonly DoppelGruppe[]): DoppelHinweis | null {
  const ich = pfad.normalize("NFC");
  const nachRang = (a: DoppelMitglied, b: DoppelMitglied) => Number(a.zz) - Number(b.zz) || a.pfad.localeCompare(b.pfad, "de");
  let exakt: DoppelMitglied[] = [];
  let inhalt: DoppelMitglied[] = [];
  const neuer: DoppelMitglied[] = [];
  const aelter: DoppelMitglied[] = [];
  for (const g of gruppen) {
    const meins = g.mitglieder.find((m) => m.pfad.normalize("NFC") === ich);
    if (!meins) continue;
    const andere = g.mitglieder.filter((m) => m !== meins);
    if (g.art === "gleich") {
      exakt = exakt.concat(andere.filter((m) => m.kopie !== null && m.kopie === meins.kopie));
      inhalt = inhalt.concat(andere.filter((m) => m.kopie === null || m.kopie !== meins.kopie));
    } else if (meins.rolle === "neu") {
      aelter.push(...andere);
    } else {
      neuer.push(...andere);
    }
  }
  if (exakt.length) return { art: "exakt", andere: exakt.sort(nachRang) };
  if (inhalt.length) return { art: "inhalt", andere: inhalt.sort(nachRang) };
  if (aelter.length) return { art: "fassung_neu", andere: aelter.sort(nachRang) };
  if (neuer.length) return { art: "fassung_alt", andere: neuer.sort(nachRang) };
  return null;
}

/** Ist der Pfad im Rueckstau (ZZ_*-Ordner)? */
export function imRueckstau(pfad: string): boolean {
  return hatZzSegment(ordnerVonPfad(pfad));
}
