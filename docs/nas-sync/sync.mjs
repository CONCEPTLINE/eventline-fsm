// EVENTLINE NAS-Sync-Client — laeuft auf dem UGREEN-NAS (Docker) oder
// einem Buero-PC und holt die im FSM abgelegten Dokumente in die lokale
// Ordnerstruktur. Pollt die Abhol-API; das NAS braucht dafuer KEINE
// Erreichbarkeit aus dem Internet (nur ausgehende Verbindungen).
//
// Ablauf pro Durchlauf:
//   1. GET  /api/ablage/sync            → Liste {id, ordner, dateiname, url}
//   2. Datei herunterladen → <NAS_BASIS>/<ordner>/<dateiname>
//      (erst .part-Datei, dann umbenennen — nie halbe Dateien)
//   3. POST /api/ablage/sync {ids}      → bestaetigt; FSM zeigt "Auf NAS"
//      und raeumt den Uebergabe-Speicher auf.
//
// Konfiguration via Umgebungsvariablen:
//   FSM_URL            z.B. https://eventline-fsm-usyk.vercel.app
//   ABLAGE_SYNC_TOKEN  das Sync-Secret (gleicher Wert wie im FSM/Vercel)
//   NAS_BASIS          Zielbasis, z.B. /daten  (Docker-Volume auf die Freigabe)
//   INTERVALL_S        Poll-Intervall in Sekunden (Default 60)

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

const FSM_URL = (process.env.FSM_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.ABLAGE_SYNC_TOKEN ?? "";
const BASIS = process.env.NAS_BASIS ?? "";
const INTERVALL = Math.max(15, parseInt(process.env.INTERVALL_S ?? "60", 10) || 60) * 1000;

if (!FSM_URL || !TOKEN || !BASIS) {
  console.error("FSM_URL, ABLAGE_SYNC_TOKEN und NAS_BASIS muessen gesetzt sein.");
  process.exit(1);
}

function sichererZielpfad(ordner, dateiname) {
  // Verteidigung in der Tiefe: die API liefert nur gepflegte Ordner,
  // trotzdem lassen wir keinerlei Pfad-Ausbrueche zu.
  const rel = normalize(join(ordner, dateiname));
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("Unsicherer Pfad: " + rel);
  return join(BASIS, rel);
}

async function durchlauf() {
  const res = await fetch(`${FSM_URL}/api/ablage/sync`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Liste: HTTP ${res.status}`);
  const { items } = await res.json();
  if (!items || items.length === 0) return 0;

  const fertig = [];
  for (const item of items) {
    try {
      const ziel = sichererZielpfad(item.ordner, item.dateiname);
      await mkdir(dirname(ziel), { recursive: true });
      const dl = await fetch(item.url);
      if (!dl.ok) throw new Error(`Download HTTP ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const part = ziel + ".part";
      await writeFile(part, buf);
      await rename(part, ziel);
      fertig.push(item.id);
      console.log(`[${new Date().toISOString()}] abgelegt: ${item.ordner}/${item.dateiname}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] FEHLER bei ${item.dateiname}:`, e.message);
      // nicht bestaetigen → kommt beim naechsten Durchlauf wieder
    }
  }

  if (fertig.length > 0) {
    const best = await fetch(`${FSM_URL}/api/ablage/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: fertig }),
    });
    if (!best.ok) throw new Error(`Bestätigung: HTTP ${best.status}`);
  }
  return fertig.length;
}

console.log(`EVENTLINE NAS-Sync gestartet — Ziel: ${BASIS}, Intervall: ${INTERVALL / 1000}s`);
for (;;) {
  try {
    const n = await durchlauf();
    if (n > 0) console.log(`${n} Datei(en) uebertragen.`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Durchlauf fehlgeschlagen:`, e.message);
  }
  await new Promise((r) => setTimeout(r, INTERVALL));
}
