// PDF-Text zeilenweise (für das Altbestand-Werkzeug und Prüfskripte).
//
//   import { pdfZeilen } from "./lohn-pdf-text.mjs";
//   const zeilen = await pdfZeilen(buffer);   // [{ y, text, teile: [{x, text}] }]
//
// Standalone: node scripts/lohn-pdf-text.mjs <datei.pdf>
// pdfjs-Falle (Memory «pdfjs-Fallen»): Daten immer als Kopie übergeben (.slice(0)).

import fs from "node:fs";
import { fileURLToPath } from "node:url";

let pdfjs;
async function lade() {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/** Textzeilen einer PDF (alle Seiten), von oben nach unten, Teile von links nach rechts. */
export async function pdfZeilen(daten) {
  const { getDocument } = await lade();
  const bytes = new Uint8Array(daten).slice(0);
  const aufgabe = getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await aufgabe.promise;
  const alle = [];
  for (let s = 1; s <= doc.numPages; s++) {
    const seite = await doc.getPage(s);
    const inhalt = await seite.getTextContent();
    const zeilen = new Map();
    for (const it of inhalt.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      const y = Math.round(it.transform[5]);
      const x = it.transform[4];
      let z = null;
      for (const [k, v] of zeilen) if (Math.abs(k - y) <= 1.5) { z = v; break; }
      if (!z) { z = []; zeilen.set(y, z); }
      z.push({ x, text: it.str });
    }
    const sortiert = [...zeilen.entries()].sort((a, b) => b[0] - a[0]);
    for (const [y, teile] of sortiert) {
      teile.sort((a, b) => a.x - b.x);
      alle.push({ seite: s, y, text: teile.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim(), teile });
    }
  }
  await aufgabe.destroy();
  return alle;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const datei = process.argv[2];
  if (!datei) {
    console.error("Aufruf: node scripts/lohn-pdf-text.mjs <datei.pdf>");
    process.exit(1);
  }
  for (const z of await pdfZeilen(fs.readFileSync(datei))) console.log(z.text);
}
