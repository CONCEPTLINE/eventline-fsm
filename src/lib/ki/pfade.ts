// Pfad-Regeln der lokalen KI, die Server UND Browser teilen (rein, kein I/O).
//
// Unicode (docs/lokale-ki/MASTERPLAN.md §3.0): Das Rig meldet Pfade in NFC.
// Auf dem NAS (Linux) stehen Namen aber byte-genau so, wie sie angelegt
// wurden — vom Mac oft zerlegt (NFD, z. B. «a» + Umlaut-Punkte), und der
// Datei-Index (ablage_datei_index) sowie die Ordnerliste (ablage_ordner)
// speichern genau diese Bytes. Deshalb gilt im FSM:
//   - VERGLICHEN wird immer in NFC,
//   - GESPEICHERT (nas_vorschlaege, ablage_fristen, ablage_moves) wird die
//     Schreibweise aus Index bzw. Ordnerliste — sonst findet der NAS-Sync die
//     Quelle nicht oder legt per mkdir -p einen Zwillingsordner an.

import { istSystemPfad } from "./bereinigen";

/** Hat der Ordner-Pfad irgendwo ein ZZ_*-Segment (jede Tiefe, ohne
 *  Ruecksicht auf Gross-/Kleinschreibung)? */
export function hatZzSegment(ordner: string): boolean {
  return ordner.split("/").some((s) => /^zz_/i.test(s));
}

/** Nie ein Ziel fuer Vorschlaege und Entscheide: ZZ_*-Segment oder
 *  Systembereich (99_System — Papierkorb, Sync-Interna). */
export function zielGesperrt(ordner: string): boolean {
  return hatZzSegment(ordner) || istSystemPfad(ordner);
}

/** NFC-Schluessel -> gespeicherte Schreibweise. Gibt es zu einem Schluessel
 *  mehrere Schreibweisen (Zwillinge auf dem NAS), gewinnt die, die schon NFC
 *  ist; mehrere andere ohne NFC-Form sind mehrdeutig und fallen weg. */
export function nfcZuRoh(pfade: Iterable<string>): Map<string, string> {
  const kandidaten = new Map<string, string[]>();
  for (const p of pfade) {
    const k = p.normalize("NFC");
    const liste = kandidaten.get(k);
    if (liste) {
      if (!liste.includes(p)) liste.push(p);
    } else kandidaten.set(k, [p]);
  }
  const aus = new Map<string, string>();
  for (const [k, liste] of kandidaten) {
    const roh = liste.includes(k) ? k : liste.length === 1 ? liste[0] : null;
    if (roh !== null) aus.set(k, roh);
  }
  return aus;
}

/** Hoechstens so viele Schreibweisen je Pfad werden abgefragt. */
const MAX_SCHREIBWEISEN = 16;

/** Moegliche gespeicherte Schreibweisen eines NFC-Pfads fuer die Abfrage im
 *  Datei-Index: jedes Segment, das sich in NFD unterscheidet, einmal NFC und
 *  einmal NFD (Mac-Ordner mit Windows-Datei darin = gemischt). Bei mehr als
 *  vier solchen Segmenten nur ganz NFC und ganz NFD. */
export function pfadSchreibweisen(nfc: string): string[] {
  const segmente = nfc.split("/");
  const varianten = segmente.map((s) => {
    const d = s.normalize("NFD");
    return d === s ? [s] : [s, d];
  });
  const anzahl = varianten.reduce((n, v) => n * v.length, 1);
  if (anzahl > MAX_SCHREIBWEISEN) return [nfc, nfc.normalize("NFD")];
  let aus: string[] = [""];
  varianten.forEach((v, i) => {
    aus = aus.flatMap((basis) => v.map((s) => (i === 0 ? s : `${basis}/${s}`)));
  });
  return aus;
}

/** Hoechstlaenge eines neuen Ordnernamens (ein Segment). */
export const ORDNER_NAME_MAX = 80;

/** Name EINES neuen Ordners (Segment), wie beim «Ordner anlegen» im
 *  NAS-Tab: getrimmt, Leerraum zusammengefasst; hoechstens 80 Zeichen,
 *  keine / \ : * ? " < > | und Steuerzeichen, nicht mit @ . # beginnend,
 *  kein «..». Ungueltig -> null. Geteilt von der NAS-Seite und
 *  /api/ablage/nas-vorschlaege (neuer Ordner aus einem Claude-Vorschlag). */
export function leseOrdnerName(roh: string): string | null {
  const name = roh.trim().replace(/\s+/g, " ");
  if (!name || name.length > ORDNER_NAME_MAX || /[\/:*?"<>|\u0000-\u001f]/.test(name) || /^[@.#]/.test(name) || name.includes("..")) return null;
  return name;
}
