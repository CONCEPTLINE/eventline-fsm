// Gleiche Frist aus mehreren Dokumenten = EIN Sachverhalt (Migration 321).
//
// Ursache der Doppel-Fristen (Okt. 2026): die Nachtarbeit prueft «schon
// bekannt» nur je DATEI (Pfad, Ablage-Eintrag, sha256). Liegt derselbe
// Vertrag mehrfach auf dem NAS — .docx und .pdf, Entwurf V02 und eine Kopie
// unter «Historie» —, liefert jede Datei dieselbe Frist, und jede wurde eine
// eigene Zeile (SCALA BASEL: 4× «Kündigung · 31.12.2027»).
//
// Sachverhalt = Art + Vertragspartei (normalisiert); zusammen mit dem Datum
// ist er der fachliche Schluessel einer Frist. Ohne Partei (Personalakten,
// KI ohne Partei — die Bezeichnung traegt dann den Dateinamen) gibt es
// keinen Sachverhalt: zusammengefuehrt wird nur, was sicher dasselbe ist.
//
// Rein (kein I/O, keine Laufzeit-Importe) — damit auch das Bereinigungs-
// Skript (scripts/fristen-duplikate.mjs) dieses Modul direkt laden kann.

import type { FristArt } from "./typen";

/** Rechtsform-Woerter, die fuer «dieselbe Partei» nichts zaehlen
 *  («Verein SCALA BASEL» = «SCALA BASEL» = «Scala Basel GmbH»). */
const RECHTSFORMEN = new Set([
  "verein", "gmbh", "ag", "sa", "sarl", "kg", "kollektivgesellschaft", "genossenschaft", "stiftung",
  "einzelfirma", "gbr", "ltd", "inc", "llc", "co",
]);

/** Kern einer Parteibezeichnung: ohne Akzente, klein, nur Buchstaben/Ziffern,
 *  ohne Rechtsform-Woerter. «» = nichts Brauchbares. */
export function parteiKern(partei: string): string {
  return partei
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\be\.\s?v\./g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !RECHTSFORMEN.has(w))
    .join(" ");
}

/** Sachverhalt einer Frist («kuendigung:scala basel») oder null ohne Partei. */
export function fristSachverhalt(art: FristArt | string, partei: string | null | undefined): string | null {
  if (!partei) return null;
  const kern = parteiKern(partei);
  return kern ? `${art}:${kern}` : null;
}

/** Schluessel Sachverhalt + Datum (so eindeutig wie der Unique-Index 321). */
export const sachSchluessel = (sachverhalt: string, datum: string) => `${sachverhalt}\u0000${datum}`;

/** Bezeichnungs-Maximum (Spalte bezeichnung, check <= 120). */
const BEZEICHNUNG_MAX = 120;

function dateiname(pfad: string | null): string {
  return pfad ? pfad.slice(pfad.lastIndexOf("/") + 1) : "";
}

/** Sachverhalt einer BESTEHENDEN Zeile: aus der Spalte, sonst aus der
 *  KI-Bezeichnung «<Art> · <Partei>». Traegt die Bezeichnung den Dateinamen
 *  (Rueckfall ohne Partei, ggf. auf 120 Zeichen gekappt), gibt es keinen. */
export function sachverhaltDerZeile(z: {
  quelle: string;
  art: string;
  bezeichnung: string;
  pfad: string | null;
  sachverhalt?: string | null;
}): string | null {
  if (z.sachverhalt) return z.sachverhalt;
  if (z.quelle !== "ki") return null;
  const i = z.bezeichnung.indexOf(" · ");
  if (i < 0) return null;
  const partei = z.bezeichnung.slice(i + 3).trim();
  const datei = dateiname(z.pfad);
  if (!partei || partei === datei) return null;
  if (z.bezeichnung.length >= BEZEICHNUNG_MAX && datei.startsWith(partei)) return null;
  return fristSachverhalt(z.art, partei);
}

/** Alle Quell-Dokumente einer Frist (Hauptpfad zuerst, ohne Doppel). */
export function quellPfade(z: { pfad: string | null; weitere_pfade?: readonly string[] | null }): string[] {
  const aus: string[] = [];
  const gesehen = new Set<string>();
  for (const p of [z.pfad, ...(z.weitere_pfade ?? [])]) {
    if (!p) continue;
    const k = p.normalize("NFC");
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    aus.push(p);
  }
  return aus;
}

// ── Bereinigung bestehender Doppel (einmalig nach Migration 321) ──────────

export interface FristZeileRoh {
  id: string;
  pfad: string | null;
  art: string;
  datum: string;
  bezeichnung: string;
  quelle: string;
  status: string;
  sicherheit: string | null;
  grundlage: unknown;
  weitere_pfade?: string[] | null;
  sachverhalt?: string | null;
}

export interface FristZusammenfuehrung {
  sachverhalt: string;
  datum: string;
  /** Bleibt — bekommt die anderen Dokumente als weitere_pfade. */
  behalten: FristZeileRoh;
  /** Werden geloescht (nur unbestaetigte KI-Vorschlaege). */
  weg: FristZeileRoh[];
  weitere_pfade: string[];
}

export interface FristBereinigung {
  gruppen: FristZusammenfuehrung[];
  /** Sachverhalt nachtragen (alle KI-Zeilen mit Partei, ausser den geloeschten). */
  setzen: { id: string; sachverhalt: string }[];
}

const RANG_SICHERHEIT: Record<string, number> = { hoch: 3, mittel: 2, niedrig: 1 };

function vollstaendigkeit(g: unknown): number {
  if (!g || typeof g !== "object" || Array.isArray(g)) return 0;
  return Object.values(g as Record<string, unknown>).filter((v) => v !== null && v !== undefined).length;
}

/** Ablage-Kopien («Historie», «backup», «alt») sind die schlechtere Quelle. */
function istKopie(pfad: string | null): boolean {
  return !!pfad && /(^|\/)(historie|backup|alt|archiv)(\/|$)/i.test(pfad);
}

/** Welche Zeile einer Gruppe bleibt: hoechste Sicherheit, vollstaendigste
 *  Bedingungen, keine Historie-/Backup-Kopie, kuerzester Pfad, dann ID. */
export function besteZeile<T extends FristZeileRoh>(zeilen: readonly T[]): T {
  return [...zeilen].sort((a, b) =>
    (RANG_SICHERHEIT[b.sicherheit ?? ""] ?? 0) - (RANG_SICHERHEIT[a.sicherheit ?? ""] ?? 0)
    || vollstaendigkeit(b.grundlage) - vollstaendigkeit(a.grundlage)
    || Number(istKopie(a.pfad)) - Number(istKopie(b.pfad))
    || (a.pfad ?? "").length - (b.pfad ?? "").length
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

/** Plant die Bereinigung: NUR unbestaetigte KI-Vorschlaege (quelle ki,
 *  status vorschlag) mit gleichem Sachverhalt UND gleichem Datum werden
 *  zusammengefuehrt. Bestaetigte, erledigte, verworfene und von Hand bzw.
 *  beim Ablegen erfasste Fristen bleiben unberuehrt. */
export function planeBereinigung(zeilen: readonly FristZeileRoh[]): FristBereinigung {
  const gruppen = new Map<string, FristZeileRoh[]>();
  const sachJeId = new Map<string, string>();
  for (const z of zeilen) {
    const s = sachverhaltDerZeile(z);
    if (!s) continue;
    sachJeId.set(z.id, s);
    if (z.quelle !== "ki" || z.status !== "vorschlag") continue;
    const k = sachSchluessel(s, z.datum);
    gruppen.set(k, [...(gruppen.get(k) ?? []), z]);
  }
  const aus: FristBereinigung = { gruppen: [], setzen: [] };
  const geloescht = new Set<string>();
  for (const liste of gruppen.values()) {
    if (liste.length < 2) continue;
    const behalten = besteZeile(liste);
    const weg = liste.filter((z) => z.id !== behalten.id).sort((a, b) => (a.pfad ?? "").localeCompare(b.pfad ?? ""));
    const alle = quellPfade({ pfad: behalten.pfad, weitere_pfade: [...(behalten.weitere_pfade ?? []), ...weg.flatMap((z) => quellPfade(z))] });
    for (const z of weg) geloescht.add(z.id);
    aus.gruppen.push({ sachverhalt: sachJeId.get(behalten.id)!, datum: behalten.datum, behalten, weg, weitere_pfade: alle.slice(1) });
  }
  aus.gruppen.sort((a, b) => a.datum.localeCompare(b.datum) || a.sachverhalt.localeCompare(b.sachverhalt));
  for (const z of zeilen) {
    const s = sachJeId.get(z.id);
    if (s && !geloescht.has(z.id) && z.sachverhalt !== s) aus.setzen.push({ id: z.id, sachverhalt: s });
  }
  return aus;
}
