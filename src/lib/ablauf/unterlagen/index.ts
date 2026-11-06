// Statische Unterlagen zur Privatvermietung barakuba (Basils Originale, unverändert) — nur serverseitig.
// Die PDFs liegen neben dieser Datei; next.config (outputFileTracingIncludes) nimmt sie ins Vercel-Bündel
// der Ablauf-Routen mit. Gelesen wird über process.cwd(), wie bei den Lohn-Vorlagen.
//
//   infoblatt.pdf         «Informationen für Privatvermietungen» (Ausstattung Bar/Mobiliar, mitbringen)
//   checkliste.pdf        verbindliche Checkliste (Vertragsbestandteil, Stand 24-12)
//   poller-merkblatt.pdf  Merkblatt Poller Einfahrt Süd (Kantensprung AG, v190506)
//   barakuba-kopf.pdf     Logo + Adresse aus Basils Vertragsvorlage (Vektor), Kopf des Vertrags-PDFs
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

export const UNTERLAGEN_ORDNER = "src/lib/ablauf/unterlagen";

export type UnterlageArt = "infoblatt" | "checkliste" | "poller";

/** Dateiname im Repo und Anzeigename als Mail-Anhang. */
export const UNTERLAGEN: Record<UnterlageArt, { datei: string; anhangName: string }> = {
  infoblatt: { datei: "infoblatt.pdf", anhangName: "Informationen für Privatvermietungen.pdf" },
  checkliste: { datei: "checkliste.pdf", anhangName: "Checkliste.pdf" },
  poller: { datei: "poller-merkblatt.pdf", anhangName: "Poller-Merkblatt.pdf" },
};

const cache = new Map<string, Uint8Array>();

async function lies(datei: string): Promise<Uint8Array> {
  const treffer = cache.get(datei);
  if (treffer) return treffer;
  const buf = await readFile(nodePath.join(process.cwd(), UNTERLAGEN_ORDNER, datei));
  const bytes = new Uint8Array(buf);
  cache.set(datei, bytes);
  return bytes;
}

export async function ladeUnterlage(art: UnterlageArt): Promise<{ name: string; bytes: Uint8Array }> {
  const u = UNTERLAGEN[art];
  return { name: u.anhangName, bytes: await lies(u.datei) };
}

/** Kopf (Logo + Adresse) aus Basils Vorlage als einseitiges Vektor-PDF. */
export function ladeBarakubaKopf(): Promise<Uint8Array> {
  return lies("barakuba-kopf.pdf");
}
