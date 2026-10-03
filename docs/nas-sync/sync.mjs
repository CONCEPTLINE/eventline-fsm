// EVENTLINE NAS-Sync-Client — laeuft auf dem Rig (Docker, NAS-Freigaben
// per CIFS eingehaengt), auf dem UGREEN-NAS (Docker) oder einem Buero-PC
// und holt die im FSM abgelegten Dokumente in die lokale Ordnerstruktur.
// Pollt die Abhol-API; das NAS braucht dafuer KEINE Erreichbarkeit aus
// dem Internet (nur ausgehende Verbindungen).
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
// Betrieb auf dem Rig (seit 2026-10-03): jede OBERSTE Ebene unter
// NAS_BASIS ist eine eigene NAS-Freigabe mit eigenem CIFS-Mount. Folgen:
//   * Verschieben/Umbenennen ueber Freigabe-Grenzen schlaegt mit EXDEV
//     fehl → kopieren (.part, mtime uebernehmen) + Quelle loeschen
//     (verschiebeDatei). Scheitert das Loeschen der Quelle NACH gelungener
//     Kopie, bleibt die Kopie bewusst stehen — die Datei liegt dann doppelt
//     (reparabel), statt verloren zu sein (nicht reparabel); das Loeschen
//     wird im naechsten Durchlauf wiederholt. Bei jedem anderen Fehler
//     bleibt die Quelle unangetastet.
//   * Auftraege sind idempotent (das FSM schickt sie bis zur Bestaetigung
//     erneut): fehlt die Quelle und liegt am Ziel schon eine Datei, gilt
//     der Auftrag als erledigt (bereitsErledigt).
//   * Neue OBERSTE Ordner kann der Client nicht anlegen (das waeren neue
//     Freigaben) → klarer Fehler im Log, der Auftrag bleibt im FSM offen.
//   * Das Mount-Skript legt in jedem Mountpunkt die Markerdatei
//     .nicht-eingehaengt ab; sie ist nur sichtbar, wenn die Freigabe NICHT
//     eingehaengt ist. Dann werden Struktur- und Datei-Scan uebersprungen
//     (sonst saehe das FSM diese Ordner und Dateien als geloescht) und
//     Auftraege in dieser Freigabe scheitern mit klarer Meldung.
//   * Ist eine Freigabe zwar eingehaengt, aber nicht lesbar (NAS gerade
//     weg, SMB-Sitzung tot), wird der GESAMTE Struktur-/Datei-Abgleich des
//     Durchlaufs abgebrochen — nie ein Teil-Scan ans FSM.
//   * Lehnt das FSM den Token ab (401) oder antwortet es 503 (nicht
//     konfiguriert bzw. voruebergehend nicht verfuegbar), laeuft der Client
//     im WARTEZUSTAND weiter (Backoff bis 5 Min) und beendet sich nicht.
//
// Konfiguration via Umgebungsvariablen:
//   FSM_URL            z.B. https://eventline-fsm-usyk.vercel.app
//   ABLAGE_SYNC_TOKEN  das Sync-Secret (gleicher Wert wie im FSM/Vercel)
//   NAS_BASIS          Zielbasis, z.B. /daten  (Docker-Volume auf die Freigabe(n))
//   INTERVALL_S        Poll-Intervall in Sekunden (Default 60)
//   SCAN_TIEFE         wie viele Ordner-Ebenen gemeldet werden (Default 99)
//   SCAN_AUSSCHLUSS    kommagetrennte Top-Ordner, die NICHT in die
//                      Ablage-Auswahl gehoeren (Default "99_System" — dort
//                      liegt der Papierkorb, der bleibt beschreibbar)

import { access, copyFile, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

// Markerdatei des Mount-Skripts (Rig): liegt UNTER dem Mount im Mountpunkt
// und ist deshalb nur sichtbar, solange die Freigabe nicht eingehaengt ist.
const MARKER = ".nicht-eingehaengt";

if (!FSM_URL || !TOKEN || !BASIS) {
  console.error("FSM_URL, ABLAGE_SYNC_TOKEN und NAS_BASIS muessen gesetzt sein.");
  process.exit(1);
}

const ts = () => new Date().toISOString();

/** FSM lehnt den Token ab (401) oder antwortet 503 (nicht konfiguriert / voruebergehend nicht verfuegbar). */
class FsmAuthFehler extends Error {
  constructor(status, wo, nichtKonfiguriert) {
    super(`${wo}: HTTP ${status}`);
    this.status = status;
    this.nichtKonfiguriert = nichtKonfiguriert;
  }
}
/**
 * 401/503 → FsmAuthFehler (Wartezustand). `body` = bereits gelesener Body
 * (Text oder JSON); fehlt er, wird er hier gelesen. Ein 503 gilt nur dann
 * als «Sync nicht konfiguriert», wenn das FSM das im Body sagt — jeder
 * andere 503 (Vercel/Proxy) ist ein voruebergehender Ausfall.
 */
async function pruefeAuth(res, wo, body) {
  if (res.status !== 401 && res.status !== 503) return;
  if (body === undefined) body = await res.text().catch(() => "");
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  throw new FsmAuthFehler(res.status, wo, res.status === 503 && /nicht konfiguriert/i.test(text));
}
/** Body einmal als Text lesen und zusaetzlich als JSON deuten (null, wenn kein JSON). */
async function liesJson(res) {
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON (z.B. Fehlerseite) */ }
  return { text, json };
}

// Wiederkehrende Fehler je Auftrag (z.B. Ordner nicht anlegbar, Ziel
// existiert schon) nur einmal pro Stunde melden — der Auftrag bleibt im
// FSM offen und kaeme sonst jede Minute ins Log.
const gemeldet = new Map();
function meldeGedrosselt(key, text) {
  const jetzt = Date.now();
  if (jetzt - (gemeldet.get(key) ?? 0) < 60 * 60 * 1000) return;
  gemeldet.set(key, jetzt);
  console.error(`${text} (Meldung wird erst in 1h wiederholt)`);
}

function segmentOk(name) {
  return name.length > 0 && !/^[@.#]/.test(name);
}

/** Oberster Ordner (= Freigabe auf dem Rig) eines relativen Pfads. */
function obersterOrdner(rel) {
  return String(rel ?? "").split("/").filter(Boolean)[0] ?? "";
}

/** Absoluter Pfad unter BASIS → relative Form mit "/" (so fuehrt sie das FSM). */
function relativ(abs) {
  return abs.slice(BASIS.length + 1).split(sep).join("/");
}

async function existiert(pfad) {
  try { await access(pfad); return true; } catch { return false; }
}

/** stat, das «gibt es nicht» als null liefert — jeder andere Fehler (EIO, EACCES…) wird geworfen. */
async function statOderNull(pfad) {
  try {
    return await stat(pfad);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/** Wirft einen klaren Fehler, wenn die Freigabe des Pfads nicht eingehaengt ist (Marker sichtbar). */
async function pruefeEingehaengt(rel) {
  const top = obersterOrdner(rel);
  if (!top) return;
  if (await existiert(join(BASIS, top, MARKER))) {
    throw new Error(`Freigabe «${top}» ist nicht eingehaengt (NAS/Mount auf dem Rig pruefen)`);
  }
}

/** Nicht eingehaengte Freigaben (Marker sichtbar) — leer = alles ok bzw. kein Rig-Betrieb. */
async function nichtEingehaengt() {
  let eintraege;
  try {
    eintraege = await readdir(BASIS, { withFileTypes: true });
  } catch {
    return ["(NAS_BASIS nicht lesbar)"];
  }
  const fehlend = [];
  for (const e of eintraege) {
    if (e.isDirectory() && (await existiert(join(BASIS, e.name, MARKER)))) fehlend.push(e.name);
  }
  return fehlend;
}

/**
 * Aenderungsdatum der Quelle auf die Kopie uebertragen — erst NACH dem
 * Umbenennen: CIFS schliesst Datei-Handles verzoegert (closetimeo) und der
 * SMB-Server setzt beim Schliessen die Schreibzeit neu; ein davor gesetztes
 * Datum ginge verloren (rename erzwingt das Schliessen). Wird nachgeprueft
 * und einmal wiederholt; misslingt es, ist die Datei trotzdem vollstaendig,
 * nur ihr Datum ist neu.
 */
async function datumUebernehmen(pfad, quelle) {
  for (let versuch = 1; versuch <= 2; versuch++) {
    try {
      await utimes(pfad, quelle.atime, quelle.mtime);
      const s = await stat(pfad);
      if (Math.abs(s.mtimeMs - quelle.mtimeMs) < 2000) return;
    } catch (e) {
      console.warn(`[${ts()}] Hinweis: Aenderungsdatum nicht uebernommen (${e.code ?? e.message})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`[${ts()}] Hinweis: Aenderungsdatum nicht uebernommen (Server setzt es beim Schliessen neu)`);
}

// Quelle → Ziel von Kopien, deren Quelle nach dem Kopieren nicht loeschbar
// war. Nur DIESER Prozess weiss sicher, dass die Datei am Ziel seine eigene
// Kopie ist — nur dann darf das Loeschen der Quelle wiederholt werden.
const doppelt = new Map();

/**
 * Datei verschieben/umbenennen, NIE ueberschreiben (die Aufrufer pruefen das
 * Ziel vorher). Auf dem Rig ist jede Freigabe ein eigener Mount — rename
 * ueber die Grenze hinweg scheitert mit EXDEV; dann wird kopiert (.part,
 * mtime uebernommen, Groesse geprueft) und erst danach die Quelle geloescht.
 * Geht beim Kopieren etwas schief, bleibt die Quelle unangetastet. Scheitert
 * erst das Loeschen der Quelle, bleibt die fertige Kopie stehen (Datei liegt
 * doppelt — reparabel; ein Verlust waere es nicht) und der Fehler wird
 * geworfen; der naechste Durchlauf wiederholt nur noch das Loeschen.
 */
async function verschiebeDatei(von, ziel) {
  try {
    await rename(von, ziel);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  const quelle = await stat(von);
  const part = `${ziel}.part`;
  await unlink(part).catch(() => {}); // Rest eines abgebrochenen Versuchs
  try {
    await copyFile(von, part, constants.COPYFILE_EXCL);
    const kopie = await stat(part);
    if (kopie.size !== quelle.size) throw new Error(`Kopie unvollstaendig (${kopie.size} statt ${quelle.size} Bytes)`);
    if (await existiert(ziel)) throw new Error("Ziel existiert inzwischen");
    await rename(part, ziel);
  } catch (e) {
    await unlink(part).catch(() => {});
    throw e;
  }
  // Ab hier liegt die Kopie vollstaendig am Ziel und wird NICHT mehr
  // zurueckgenommen, was auch immer mit der Quelle passiert.
  await datumUebernehmen(ziel, quelle);
  try {
    await unlink(von);
  } catch (e) {
    // Quelle wirklich noch da? Ist sie weg (ENOENT), ist das Ziel erreicht.
    const nochDa = await stat(von).then(() => true, (e2) => e2.code !== "ENOENT");
    if (!nochDa) return;
    doppelt.set(von, ziel);
    throw new Error(
      `Quelle nach dem Kopieren nicht loeschbar (${e.code ?? e.message}) — Datei liegt doppelt: ` +
      "die Kopie am Ziel bleibt bewusst erhalten, das Loeschen der Quelle wird im naechsten Durchlauf wiederholt",
    );
  }
  doppelt.delete(von);
}

/**
 * Idempotenz-Vorpruefung fuer Verschieben/Umbenennen — das FSM schickt einen
 * Auftrag so lange erneut, bis er bestaetigt wurde. Liefert den Pfad, an dem
 * die Datei bereits liegt (= Auftrag erledigt), oder null (= normal weiter).
 *  - Dieser Prozess hat frueher kopiert, konnte die Quelle aber nicht loeschen
 *    (doppelt-Map): NICHT erneut kopieren, nur das Loeschen wiederholen.
 *  - Quelle fehlt, am Ziel liegt eine Datei → ein frueherer Durchlauf war
 *    erfolgreich, nur die Bestaetigung ans FSM fehlte.
 *  - Quelle UND Ziel vorhanden, gleich gross und gleich alt, aber nicht aus
 *    diesem Prozess (Neustart dazwischen): «Datei liegt doppelt» werfen —
 *    eine Datei nur wegen Groesse/Datum zu loeschen waere zu riskant, und
 *    noch einmal kopieren wuerde bei jedem Durchlauf eine weitere Kopie
 *    erzeugen. Der Auftrag bleibt offen, bis die Quelle von Hand entfernt ist.
 */
async function bereitsErledigt(von, ziel) {
  const bekannt = doppelt.get(von);
  if (bekannt !== undefined) {
    if (await statOderNull(bekannt)) {
      try {
        await unlink(von);
      } catch (e) {
        if (e.code !== "ENOENT") {
          throw new Error(`Datei liegt doppelt — Quelle weiterhin nicht loeschbar (${e.code ?? e.message}); Loeschen wird im naechsten Durchlauf wiederholt`);
        }
      }
      doppelt.delete(von);
      return bekannt;
    }
    doppelt.delete(von); // Kopie wurde inzwischen von Hand entfernt → normal weiter
  }
  const [q, z] = await Promise.all([statOderNull(von), statOderNull(ziel)]);
  if (!z) return null;
  if (!q) return ziel;
  if (q.isFile() && z.isFile() && q.size === z.size && Math.abs(q.mtimeMs - z.mtimeMs) < 2000) {
    throw new Error("Datei liegt doppelt (Quelle und Ziel gleich gross und gleich alt) — wird nicht erneut kopiert; Quelle am NAS pruefen und von Hand entfernen");
  }
  return null;
}

/** Freigabe-Ebene nicht lesbar → der ganze Scan dieses Durchlaufs wird verworfen. */
class ScanAbbruch extends Error {}

/**
 * readdir mit Abbruch-Regel: NAS_BASIS und die Freigabe-Ebene (erste Ebene)
 * MUESSEN lesbar sein, sonst wird der Scan abgebrochen — ein Teil-Scan liesse
 * das FSM alle Ordner/Dateien der fehlenden Freigabe als geloescht sehen.
 * Tiefer liegende, nicht lesbare Ordner werden einzeln uebersprungen (null).
 */
async function liesOrdner(dir, praefix) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const grund = e.code ?? e.message;
    if (praefix === "") throw new ScanAbbruch(`NAS_BASIS nicht lesbar — Scan abgebrochen (${grund})`);
    if (!praefix.includes("/")) throw new ScanAbbruch(`Freigabe «${praefix}» nicht lesbar — Scan abgebrochen (${grund})`);
    return null;
  }
}

/** Ordnerstruktur unter BASIS rekursiv einsammeln (relative Pfade). */
async function scanneOrdner(dir, tiefe, praefix, ergebnis) {
  const eintraege = await liesOrdner(dir, praefix);
  if (!eintraege) return;
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
    console.warn(`[${ts()}] Ordner-Scan leer — Abgleich uebersprungen (Mount pruefen?)`);
    return;
  }
  pfade.sort();
  const res = await fetch(`${FSM_URL}/api/ablage/ordner-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pfade }),
  });
  const { text, json } = await liesJson(res);
  if (!res.ok || !json?.success) {
    await pruefeAuth(res, "Ordner-Abgleich", text);
    throw new Error(`Ordner-Abgleich: HTTP ${res.status} ${json?.error ?? ""}`);
  }
  if (json.neu > 0 || json.entfernt > 0) {
    console.log(`[${ts()}] Ordnerstruktur abgeglichen: ${json.total} Ordner (+${json.neu}/−${json.entfernt})`);
  }
}

/** Alle Dateien (Name/Groesse/mtime, NIE Inhalte) rekursiv einsammeln. */
async function scanneDateien(dir, tiefe, praefix, ergebnis) {
  const eintraege = await liesOrdner(dir, praefix);
  if (!eintraege) return;
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
    console.warn(`[${ts()}] Datei-Scan leer — Index-Abgleich uebersprungen (Mount pruefen?)`);
    return;
  }
  if (dateien.length >= DATEI_MAX) {
    console.warn(`[${ts()}] Datei-Scan bei ${DATEI_MAX} gekappt — Rest fehlt im Suchindex`);
  }
  const scanId = ts();
  const CHUNK = 800;
  for (let i = 0; i < dateien.length; i += CHUNK) {
    const fertig = i + CHUNK >= dateien.length;
    const res = await fetch(`${FSM_URL}/api/ablage/datei-index`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scanId, dateien: dateien.slice(i, i + CHUNK), fertig }),
    });
    const { text, json } = await liesJson(res);
    if (!res.ok || !json?.success) {
      await pruefeAuth(res, "Datei-Index", text);
      throw new Error(`Datei-Index: HTTP ${res.status} ${json?.error ?? ""}`);
    }
  }
  console.log(`[${ts()}] Datei-Index abgeglichen: ${dateien.length} Dateien`);
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
  if (!res.ok) {
    await pruefeAuth(res, "Liste");
    throw new Error(`Liste: HTTP ${res.status}`);
  }
  const { items, ordner: neueOrdner, umbenennungen, verschiebungen, abrufe } = await res.json();

  // Datei-Abrufe (FSM will ein Dokument oeffnen): Datei vom NAS lesen
  // und direkt per signierter URL in den Uebergabe-Bucket hochladen.
  const abrufeFertig = [];
  for (const a of abrufe ?? []) {
    try {
      const quelle = sichererZielpfad(a.pfad, "");
      await pruefeEingehaengt(a.pfad);
      const buf = await readFile(quelle);
      const up = await fetch(a.url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      if (!up.ok) throw new Error(`Upload HTTP ${up.status}`);
      abrufeFertig.push({ id: a.id, ok: true });
      console.log(`[${ts()}] Abruf bereitgestellt: ${a.pfad}`);
    } catch (e) {
      abrufeFertig.push({ id: a.id, ok: false, fehler: e.message });
      console.error(`[${ts()}] FEHLER Abruf ${a?.pfad}:`, e.message);
    }
  }

  // Im FSM angelegte Ordner physisch erstellen (Leo 2026-09-30).
  // mkdir recursive ist idempotent — Bestaetigung ans FSM nimmt sie
  // aus der Liste, der naechste Struktur-Scan sieht sie regulaer.
  // Auf dem Rig ist die oberste Ebene eine NAS-Freigabe: dort kann der
  // Client nichts anlegen (EACCES) → klare Meldung, Auftrag bleibt offen.
  const ordnerFertig = [];
  for (const o of neueOrdner ?? []) {
    try {
      const ziel = sichererZielpfad(o, "");
      await pruefeEingehaengt(o);
      try {
        await mkdir(ziel, { recursive: true });
      } catch (e) {
        const top = obersterOrdner(o);
        if (["EACCES", "EPERM", "EROFS"].includes(e.code) && !(await existiert(join(BASIS, top)))) {
          throw new Error(
            `oberster Ordner «${top}» kann hier nicht angelegt werden — auf dem Rig ist jede oberste Ebene eine NAS-Freigabe ` +
            "(am NAS anlegen, fuer eventline-sync freigeben, in NAS_SHARES eintragen); Auftrag bleibt im FSM offen",
          );
        }
        throw e;
      }
      ordnerFertig.push(o);
      gemeldet.delete(`ordner:${o}`);
      console.log(`[${ts()}] Ordner angelegt: ${o}`);
    } catch (e) {
      meldeGedrosselt(`ordner:${o}`, `[${ts()}] FEHLER Ordner ${o}: ${e.message}`);
    }
  }

  // Umbenennungs-Auftraege fuer Bestandsdateien (Namensschema-Aufraeumen
  // aus dem FSM): NIE ueberschreiben — existiert der Zielname schon,
  // bleibt der Auftrag liegen und wird im Log gemeldet. Idempotent: ist
  // die Datei schon umbenannt (Quelle weg, Ziel da), nur noch bestaetigen.
  const umFertig = [];
  for (const u of umbenennungen ?? []) {
    try {
      if (!u?.pfad || !u?.neuer_name || u.neuer_name.includes("/") || u.neuer_name.includes("\\")) continue;
      const von = sichererZielpfad(u.pfad, "");
      const teile = u.pfad.split("/");
      teile[teile.length - 1] = u.neuer_name;
      const neuRel = teile.join("/");
      const ziel = sichererZielpfad(neuRel, "");
      await pruefeEingehaengt(u.pfad);
      const schonDort = await bereitsErledigt(von, ziel);
      if (schonDort) {
        umFertig.push({ pfad: u.pfad, neuer_pfad: relativ(schonDort) });
        gemeldet.delete(`umbenennen:${u.pfad}`);
        console.log(`[${ts()}] bereits umbenannt (Ziel vorhanden, Quelle weg): ${u.pfad} -> ${u.neuer_name}`);
        continue;
      }
      if (await existiert(ziel)) {
        meldeGedrosselt(`umbenennen:${u.pfad}`, `[${ts()}] Umbenennen uebersprungen — Ziel existiert schon: ${neuRel}`);
        continue;
      }
      await verschiebeDatei(von, ziel);
      umFertig.push({ pfad: u.pfad, neuer_pfad: neuRel });
      gemeldet.delete(`umbenennen:${u.pfad}`);
      console.log(`[${ts()}] umbenannt: ${u.pfad} -> ${u.neuer_name}`);
    } catch (e) {
      meldeGedrosselt(`umbenennen:${u?.pfad}`, `[${ts()}] FEHLER Umbenennen ${u?.pfad}: ${e.message}`);
    }
  }

  // Verschiebe-Auftraege (anderer Ordner oder Papierkorb): mkdir -p am
  // Ziel, nie ueberschreiben (Kollision -> " (2)"). Ueber Freigabe-Grenzen
  // hinweg (Rig) kopiert verschiebeDatei und loescht danach die Quelle.
  // Idempotent: liegt die Datei schon am Ziel (Quelle weg), nur bestaetigen.
  const mvFertig = [];
  for (const m of verschiebungen ?? []) {
    try {
      if (!m?.pfad || !m?.ziel_ordner) continue;
      const von = sichererZielpfad(m.pfad, "");
      const name = m.pfad.split("/").pop();
      let neuRel = `${m.ziel_ordner}/${name}`;
      let ziel = sichererZielpfad(m.ziel_ordner, name);
      await pruefeEingehaengt(m.pfad);
      await pruefeEingehaengt(m.ziel_ordner);
      const schonDort = await bereitsErledigt(von, ziel);
      if (schonDort) {
        mvFertig.push({ pfad: m.pfad, neuer_pfad: relativ(schonDort) });
        gemeldet.delete(`verschieben:${m.pfad}`);
        console.log(`[${ts()}] bereits verschoben (Ziel vorhanden, Quelle weg): ${m.pfad} -> ${m.ziel_ordner}/`);
        continue;
      }
      await mkdir(dirname(ziel), { recursive: true });
      const ext = extname(ziel);
      const basis = ziel.slice(0, ziel.length - ext.length);
      const basisRel = neuRel.slice(0, neuRel.length - ext.length);
      for (let n = 2; n < 100; n++) {
        if (!(await existiert(ziel))) break;
        ziel = `${basis} (${n})${ext}`;
        neuRel = `${basisRel} (${n})${ext}`;
      }
      await verschiebeDatei(von, ziel);
      mvFertig.push({ pfad: m.pfad, neuer_pfad: neuRel });
      gemeldet.delete(`verschieben:${m.pfad}`);
      console.log(`[${ts()}] verschoben: ${m.pfad} -> ${m.ziel_ordner}/`);
    } catch (e) {
      meldeGedrosselt(`verschieben:${m?.pfad}`, `[${ts()}] FEHLER Verschieben ${m?.pfad}: ${e.message}`);
    }
  }

  if ((!items || items.length === 0) && ordnerFertig.length === 0 && umFertig.length === 0 && mvFertig.length === 0 && abrufeFertig.length === 0) return 0;

  const fertig = [];
  for (const item of items ?? []) {
    try {
      let ziel = sichererZielpfad(item.ordner, item.dateiname);
      await pruefeEingehaengt(item.ordner);
      await mkdir(dirname(ziel), { recursive: true });
      // Kollisionsschutz: existiert der Name schon (z.B. zwei gleiche
      // Dokumente am selben Tag), " (2)", " (3)", … anhaengen statt
      // stillschweigend zu ueberschreiben.
      const ext = extname(ziel);
      const basis = ziel.slice(0, ziel.length - ext.length);
      for (let n = 2; n < 100; n++) {
        if (!(await existiert(ziel))) break;
        ziel = `${basis} (${n})${ext}`;
      }
      const dl = await fetch(item.url);
      if (!dl.ok) throw new Error(`Download HTTP ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const part = ziel + ".part";
      await writeFile(part, buf);
      await rename(part, ziel);
      fertig.push(item.id);
      console.log(`[${ts()}] abgelegt: ${relativ(ziel)}`);
    } catch (e) {
      console.error(`[${ts()}] FEHLER bei ${item.dateiname}:`, e.message);
      // nicht bestaetigen → kommt beim naechsten Durchlauf wieder
    }
  }

  if (fertig.length > 0 || ordnerFertig.length > 0 || umFertig.length > 0 || mvFertig.length > 0 || abrufeFertig.length > 0) {
    const best = await fetch(`${FSM_URL}/api/ablage/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: fertig, ordner: ordnerFertig, umbenannt: umFertig, verschoben: mvFertig, abrufe: abrufeFertig }),
    });
    if (!best.ok) {
      await pruefeAuth(best, "Bestaetigung");
      throw new Error(`Bestaetigung: HTTP ${best.status}`);
    }
  }
  return fertig.length;
}

async function hauptschleife() {
  console.log(`EVENTLINE NAS-Sync gestartet — Ziel: ${BASIS}, Intervall: ${INTERVALL / 1000}s, Ordner-Scan: Tiefe ${SCAN_TIEFE}, ohne [${[...SCAN_AUSSCHLUSS].join(", ")}]`);
  let runde = 0;
  let scanFaellig = true; // beim Start, danach alle SCAN_JEDER_N Runden (bleibt faellig, bis das FSM erreichbar war)
  let authFehler = 0;     // aufeinanderfolgende 401/503 → Wartezustand mit Backoff
  let authStatus = 0;
  let authNichtKonfiguriert = false;
  for (;;) {
    let fsmOk = false;
    try {
      const n = await durchlauf();
      fsmOk = true;
      if (authFehler > 0) console.log(`[${ts()}] FSM nimmt den Sync-Token wieder an — normaler Betrieb.`);
      authFehler = 0;
      if (n > 0) console.log(`${n} Datei(en) uebertragen.`);
    } catch (e) {
      if (e instanceof FsmAuthFehler) {
        authFehler++;
        authStatus = e.status;
        authNichtKonfiguriert = e.nichtKonfiguriert;
      } else {
        console.error(`[${ts()}] Durchlauf fehlgeschlagen:`, e.message);
      }
    }

    // Struktur-/Datei-Scan nur, wenn das FSM gerade erreichbar war (sonst
    // waere der teure Scan umsonst) und keine Freigabe fehlt (sonst saehe
    // das FSM deren Ordner/Dateien als geloescht). Beide Abgleiche scannen
    // erst vollstaendig und melden dann; bricht ein Scan ab (Freigabe nicht
    // lesbar), wird in diesem Durchlauf nichts (mehr) gemeldet.
    if (fsmOk && scanFaellig) {
      scanFaellig = false;
      const fehlend = await nichtEingehaengt();
      if (fehlend.length > 0) {
        console.warn(`[${ts()}] Freigabe(n) nicht eingehaengt: ${fehlend.join(", ")} — Struktur-/Datei-Scan uebersprungen`);
      } else {
        let abbruch = null;
        try {
          await ordnerAbgleich();
        } catch (e) {
          if (e instanceof ScanAbbruch) abbruch = e;
          else console.error(`[${ts()}] Ordner-Abgleich fehlgeschlagen:`, e.message);
        }
        if (!abbruch) {
          try {
            await dateiIndexAbgleich();
          } catch (e) {
            if (e instanceof ScanAbbruch) abbruch = e;
            else console.error(`[${ts()}] Datei-Index fehlgeschlagen:`, e.message);
          }
        }
        if (abbruch) console.error(`[${ts()}] ${abbruch.message} — Struktur-/Datei-Abgleich dieses Durchlaufs uebersprungen`);
      }
    }

    runde++;
    if (runde % SCAN_JEDER_N === 0) scanFaellig = true;
    if (process.env.RUN_ONCE === "1") break;

    let warte = INTERVALL;
    if (authFehler > 0) {
      warte = Math.min(INTERVALL * 2 ** Math.min(authFehler - 1, 4), 5 * 60 * 1000);
      const grund = authStatus === 401
        ? "Token wird vom FSM abgelehnt (neuer Token noch nicht deployt?)"
        : authNichtKonfiguriert
          ? "Sync im FSM nicht konfiguriert (ABLAGE_SYNC_TOKEN fehlt)"
          : "FSM voruebergehend nicht verfuegbar (HTTP 503)";
      console.warn(`[${ts()}] WARTEZUSTAND: HTTP ${authStatus} — ${grund}; ${authFehler}. Versuch, naechster in ${Math.round(warte / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, warte));
  }
}

// Als Programm gestartet → Dauerschleife. Als Modul importiert (Tests)
// → nur die Funktionen bereitstellen. Vergleich ueber realpath auf beiden
// Seiten (Symlinks, relative Pfade, Bind-Mounts).
function istHauptmodul() {
  const programm = process.argv[1];
  if (!programm) return false;
  try {
    return realpathSync(programm) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (istHauptmodul()) {
  await hauptschleife();
} else {
  console.log(`[${ts()}] sync.mjs als Modul geladen (Programm: ${process.argv[1] ?? "-"}) — Hauptschleife nicht gestartet`);
}

export { verschiebeDatei, bereitsErledigt, nichtEingehaengt, pruefeEingehaengt, scanneOrdner, scanneDateien, pruefeAuth };
