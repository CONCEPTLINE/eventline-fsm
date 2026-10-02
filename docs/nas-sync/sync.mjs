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
// Zusaetzlich spiegelt der Client die ORDNERSTRUKTUR des NAS ins FSM
// (Zielordner-Auswahl der Ablage pflegt sich selbst): beim Start und
// dann alle ~10 Minuten wird die Struktur bis SCAN_TIEFE Ebenen
// gescannt und an /api/ablage/ordner-sync gemeldet. Versteckte/System-
// Ordner (@…, .…, #…) sind immer ausgenommen.
//
// Und umgekehrt: im FSM neu angelegte Ordner kommen als `ordner`-Liste
// ueber die Abhol-API mit und werden hier physisch erstellt (mkdir)
// und zurueckbestaetigt.
//
// Konfiguration via Umgebungsvariablen:
//   FSM_URL            z.B. https://eventline-fsm-usyk.vercel.app
//   ABLAGE_SYNC_TOKEN  das Sync-Secret (gleicher Wert wie im FSM/Vercel)
//   NAS_BASIS          Zielbasis, z.B. /daten  (Docker-Volume auf die Freigabe)
//   INTERVALL_S        Poll-Intervall in Sekunden (Default 60)
//   SCAN_TIEFE         wie viele Ordner-Ebenen gemeldet werden (Default 3)
//   SCAN_AUSSCHLUSS    kommagetrennte Top-Ordner, die NICHT in die
//                      Ablage-Auswahl gehoeren (Default "99_System")

import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";

const FSM_URL = (process.env.FSM_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.ABLAGE_SYNC_TOKEN ?? "";
const BASIS = process.env.NAS_BASIS ?? "";
const INTERVALL = Math.max(15, parseInt(process.env.INTERVALL_S ?? "60", 10) || 60) * 1000;

// Keine Tiefen-Beschraenkung mehr (Leo 2026-09-30): die ganze Struktur
// wird gespiegelt. SCAN_TIEFE/DATEI_TIEFE bleiben als Notbremse setzbar.
const SCAN_TIEFE = Math.max(1, parseInt(process.env.SCAN_TIEFE ?? "99", 10) || 99);
const SCAN_AUSSCHLUSS = new Set(
  (process.env.SCAN_AUSSCHLUSS ?? "99_System").split(",").map((s) => s.trim()).filter(Boolean),
);
// Ordner-Abgleich alle N Durchlaeufe (bei 60s-Intervall ≈ alle 10 Min).
const SCAN_JEDER_N = 10;

// Datei-Index: Dateinamen (nie Inhalte!) fuers Such-Register im FSM.
// Tiefer als die Ordner-Auswahl, weil Dokumente auch in Unter-Unter-
// Ordnern liegen (z.B. Personalakten).
const DATEI_TIEFE = Math.max(1, parseInt(process.env.DATEI_TIEFE ?? "99", 10) || 99);
const DATEI_MAX = 50000;

if (!FSM_URL || !TOKEN || !BASIS) {
  console.error("FSM_URL, ABLAGE_SYNC_TOKEN und NAS_BASIS muessen gesetzt sein.");
  process.exit(1);
}

function segmentOk(name) {
  return name.length > 0 && !/^[@.#]/.test(name);
}

/** Ordnerstruktur unter BASIS rekursiv einsammeln (relative Pfade). */
async function scanneOrdner(dir, tiefe, praefix, ergebnis) {
  let eintraege;
  try {
    eintraege = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // nicht lesbar → ueberspringen
  }
  for (const e of eintraege) {
    if (!e.isDirectory() || !segmentOk(e.name)) continue;
    if (praefix === "" && SCAN_AUSSCHLUSS.has(e.name)) continue;
    const rel = praefix === "" ? e.name : `${praefix}/${e.name}`;
    ergebnis.push(rel);
    if (ergebnis.length > 10000) return; // Server-Limit — Rest abschneiden
    if (tiefe > 1) await scanneOrdner(join(dir, e.name), tiefe - 1, rel, ergebnis);
  }
}

async function ordnerAbgleich() {
  const pfade = [];
  await scanneOrdner(BASIS, SCAN_TIEFE, "", pfade);
  if (pfade.length === 0) {
    console.warn(`[${new Date().toISOString()}] Ordner-Scan leer — Abgleich uebersprungen (Mount pruefen?)`);
    return;
  }
  pfade.sort();
  const res = await fetch(`${FSM_URL}/api/ablage/ordner-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pfade }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`Ordner-Abgleich: HTTP ${res.status} ${json?.error ?? ""}`);
  if (json.neu > 0 || json.entfernt > 0) {
    console.log(`[${new Date().toISOString()}] Ordnerstruktur abgeglichen: ${json.total} Ordner (+${json.neu}/−${json.entfernt})`);
  }
}

/** Alle Dateien (Name/Groesse/mtime, NIE Inhalte) rekursiv einsammeln. */
async function scanneDateien(dir, tiefe, praefix, ergebnis) {
  let eintraege;
  try {
    eintraege = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of eintraege) {
    if (!segmentOk(e.name)) continue;
    if (praefix === "" && SCAN_AUSSCHLUSS.has(e.name)) continue;
    const rel = praefix === "" ? e.name : `${praefix}/${e.name}`;
    if (e.isDirectory()) {
      if (tiefe > 1) await scanneDateien(join(dir, e.name), tiefe - 1, rel, ergebnis);
    } else if (e.isFile()) {
      if (ergebnis.length >= DATEI_MAX) return;
      let s = null;
      try { s = await stat(join(dir, e.name)); } catch { /* egal */ }
      ergebnis.push({
        pfad: rel,
        ordner: praefix,
        name: e.name,
        groesse: s ? s.size : null,
        geaendert: s ? new Date(s.mtimeMs).toISOString() : null,
      });
    }
  }
}

/** Datei-Index chunked ans FSM melden (Upsert + Aufraeumen am Ende). */
async function dateiIndexAbgleich() {
  const dateien = [];
  await scanneDateien(BASIS, DATEI_TIEFE, "", dateien);
  if (dateien.length === 0) {
    console.warn(`[${new Date().toISOString()}] Datei-Scan leer — Index-Abgleich uebersprungen (Mount pruefen?)`);
    return;
  }
  if (dateien.length >= DATEI_MAX) {
    console.warn(`[${new Date().toISOString()}] Datei-Scan bei ${DATEI_MAX} gekappt — Rest fehlt im Suchindex`);
  }
  const scanId = new Date().toISOString();
  const CHUNK = 800;
  for (let i = 0; i < dateien.length; i += CHUNK) {
    const fertig = i + CHUNK >= dateien.length;
    const res = await fetch(`${FSM_URL}/api/ablage/datei-index`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scanId, dateien: dateien.slice(i, i + CHUNK), fertig }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(`Datei-Index: HTTP ${res.status} ${json?.error ?? ""}`);
  }
  console.log(`[${new Date().toISOString()}] Datei-Index abgeglichen: ${dateien.length} Dateien`);
}

function sichererZielpfad(ordner, dateiname) {
  // Verteidigung in der Tiefe: die API liefert nur gepflegte Ordner,
  // trotzdem lassen wir keinerlei Pfad-Ausbrueche zu.
  const rel = normalize(join(ordner, dateiname));
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("Unsicherer Pfad: " + rel);
  return join(BASIS, rel);
}

async function durchlauf() {
  const res = await fetch(`${FSM_URL}/api/ablage/sync?i=${Math.round(INTERVALL / 1000)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Liste: HTTP ${res.status}`);
  const { items, ordner: neueOrdner, umbenennungen, verschiebungen, abrufe } = await res.json();

  // Datei-Abrufe (FSM will ein Dokument oeffnen): Datei vom NAS lesen
  // und direkt per signierter URL in den Uebergabe-Bucket hochladen.
  const abrufeFertig = [];
  for (const a of abrufe ?? []) {
    try {
      const quelle = sichererZielpfad(a.pfad, "");
      const buf = await readFile(quelle);
      const up = await fetch(a.url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      if (!up.ok) throw new Error(`Upload HTTP ${up.status}`);
      abrufeFertig.push({ id: a.id, ok: true });
      console.log(`[${new Date().toISOString()}] Abruf bereitgestellt: ${a.pfad}`);
    } catch (e) {
      abrufeFertig.push({ id: a.id, ok: false, fehler: e.message });
      console.error(`[${new Date().toISOString()}] FEHLER Abruf ${a?.pfad}:`, e.message);
    }
  }

  // Im FSM angelegte Ordner physisch erstellen (Leo 2026-09-30).
  // mkdir recursive ist idempotent — Bestaetigung ans FSM nimmt sie
  // aus der Liste, der naechste Struktur-Scan sieht sie regulaer.
  const ordnerFertig = [];
  for (const o of neueOrdner ?? []) {
    try {
      const ziel = sichererZielpfad(o, "");
      await mkdir(ziel, { recursive: true });
      ordnerFertig.push(o);
      console.log(`[${new Date().toISOString()}] Ordner angelegt: ${o}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] FEHLER Ordner ${o}:`, e.message);
    }
  }

  // Umbenennungs-Auftraege fuer Bestandsdateien (Namensschema-Aufraeumen
  // aus dem FSM): NIE ueberschreiben — existiert der Zielname schon,
  // bleibt der Auftrag liegen und wird im Log gemeldet.
  const umFertig = [];
  for (const u of umbenennungen ?? []) {
    try {
      if (!u?.pfad || !u?.neuer_name || u.neuer_name.includes("/") || u.neuer_name.includes("\\")) continue;
      const von = sichererZielpfad(u.pfad, "");
      const teile = u.pfad.split("/");
      teile[teile.length - 1] = u.neuer_name;
      const neuRel = teile.join("/");
      const ziel = sichererZielpfad(neuRel, "");
      let existiert = false;
      try { await access(ziel); existiert = true; } catch { /* frei */ }
      if (existiert) {
        console.error(`[${new Date().toISOString()}] Umbenennen uebersprungen — Ziel existiert schon: ${neuRel}`);
        continue;
      }
      await rename(von, ziel);
      umFertig.push({ pfad: u.pfad, neuer_pfad: neuRel });
      console.log(`[${new Date().toISOString()}] umbenannt: ${u.pfad} -> ${u.neuer_name}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] FEHLER Umbenennen ${u?.pfad}:`, e.message);
    }
  }

  // Verschiebe-Auftraege (anderer Ordner oder Papierkorb): mkdir -p am
  // Ziel, nie ueberschreiben (Kollision -> " (2)").
  const mvFertig = [];
  for (const m of verschiebungen ?? []) {
    try {
      if (!m?.pfad || !m?.ziel_ordner) continue;
      const von = sichererZielpfad(m.pfad, "");
      const name = m.pfad.split("/").pop();
      let neuRel = `${m.ziel_ordner}/${name}`;
      let ziel = sichererZielpfad(m.ziel_ordner, name);
      await mkdir(dirname(ziel), { recursive: true });
      const ext = extname(ziel);
      const basis = ziel.slice(0, ziel.length - ext.length);
      const basisRel = neuRel.slice(0, neuRel.length - ext.length);
      for (let n = 2; n < 100; n++) {
        try { await access(ziel); ziel = `${basis} (${n})${ext}`; neuRel = `${basisRel} (${n})${ext}`; } catch { break; }
      }
      await rename(von, ziel);
      mvFertig.push({ pfad: m.pfad, neuer_pfad: neuRel });
      console.log(`[${new Date().toISOString()}] verschoben: ${m.pfad} -> ${m.ziel_ordner}/`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] FEHLER Verschieben ${m?.pfad}:`, e.message);
    }
  }

  if ((!items || items.length === 0) && ordnerFertig.length === 0 && umFertig.length === 0 && mvFertig.length === 0 && abrufeFertig.length === 0) return 0;

  const fertig = [];
  for (const item of items ?? []) {
    try {
      let ziel = sichererZielpfad(item.ordner, item.dateiname);
      await mkdir(dirname(ziel), { recursive: true });
      // Kollisionsschutz: existiert der Name schon (z.B. zwei gleiche
      // Dokumente am selben Tag), " (2)", " (3)", … anhaengen statt
      // stillschweigend zu ueberschreiben.
      const ext = extname(ziel);
      const basis = ziel.slice(0, ziel.length - ext.length);
      for (let n = 2; n < 100; n++) {
        try { await access(ziel); ziel = `${basis} (${n})${ext}`; } catch { break; }
      }
      const dl = await fetch(item.url);
      if (!dl.ok) throw new Error(`Download HTTP ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const part = ziel + ".part";
      await writeFile(part, buf);
      await rename(part, ziel);
      fertig.push(item.id);
      console.log(`[${new Date().toISOString()}] abgelegt: ${ziel.slice(BASIS.length + 1)}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] FEHLER bei ${item.dateiname}:`, e.message);
      // nicht bestaetigen → kommt beim naechsten Durchlauf wieder
    }
  }

  if (fertig.length > 0 || ordnerFertig.length > 0 || umFertig.length > 0 || mvFertig.length > 0 || abrufeFertig.length > 0) {
    const best = await fetch(`${FSM_URL}/api/ablage/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: fertig, ordner: ordnerFertig, umbenannt: umFertig, verschoben: mvFertig, abrufe: abrufeFertig }),
    });
    if (!best.ok) throw new Error(`Bestätigung: HTTP ${best.status}`);
  }
  return fertig.length;
}

console.log(`EVENTLINE NAS-Sync gestartet — Ziel: ${BASIS}, Intervall: ${INTERVALL / 1000}s, Ordner-Scan: Tiefe ${SCAN_TIEFE}, ohne [${[...SCAN_AUSSCHLUSS].join(", ")}]`);
let runde = 0;
for (;;) {
  if (runde % SCAN_JEDER_N === 0) {
    try {
      await ordnerAbgleich();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Ordner-Abgleich fehlgeschlagen:`, e.message);
    }
    try {
      await dateiIndexAbgleich();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Datei-Index fehlgeschlagen:`, e.message);
    }
  }
  try {
    const n = await durchlauf();
    if (n > 0) console.log(`${n} Datei(en) uebertragen.`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Durchlauf fehlgeschlagen:`, e.message);
  }
  runde++;
  if (process.env.RUN_ONCE === "1") break;
  await new Promise((r) => setTimeout(r, INTERVALL));
}
