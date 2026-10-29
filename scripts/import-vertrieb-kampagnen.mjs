#!/usr/bin/env node
// Vertrieb › Kampagnen: Kontakte aus einer JSON-Datei importieren
// (Migration 365 muss eingespielt sein).
//
//   node scripts/import-vertrieb-kampagnen.mjs <kampagnen-name> <gruppe_label> <datei.json> [--probe]
//   z. B. node scripts/import-vertrieb-kampagnen.mjs "Messe 2027" Messe ~/research_notes/fsm_import/messe.json
//
// JSON = Array von Objekten mit den Spaltennamen von vertrieb_kampagne_kontakte
// (ohne id/kampagne_id). Pflicht je Zeile: nr, firma.
//
// Idempotent: Kampagne per Name (anlegen oder gruppe_label nachführen),
// Kontakte per (kampagne_id, nr) einfügen bzw. aktualisieren. Überschreibt NIE:
//   - status, wenn status_manuell = true (von Hand gesetzt),
//   - einen Status mit einem im Ablauf früheren oder gleichrangigen Status aus
//     der Datei (Rangfolge STATUS_RANG) — ausser der bestehende ist «offen»,
//   - notizen, die in der App schon erfasst sind,
//   - Felder der Automatik (mail_gesendet_am, Antworten), wenn die Datei
//     keinen Wert hat.
// Liest .env.local selbst (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
// --probe: nur zählen, was passieren würde, nichts schreiben.
//
// ACHTUNG: Die Datenbank ist Live (B1) — jeder Import wirkt sofort in der App.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createClient } from "@supabase/supabase-js";

const SPALTEN = [
  "nr", "firma", "gruppe", "prioritaet", "ansprechperson", "funktion", "email", "telefon", "website",
  "ort", "region", "hinweis", "notizen", "status", "mail_betreff", "mail_text", "mail_sprache",
  "mail_anhang", "mail_an", "mail_geplant_am", "mail_gesendet_am", "graph_message_id",
  "letzte_antwort_am", "letzte_antwort_betreff", "antworten_anzahl",
];
const STATUS = ["offen", "geplant", "gesendet", "geantwortet", "termin", "offerte", "auftrag", "kein_bedarf", "unzustellbar", "anrufen"];
/** Fortschritt einer Akquise: ein Import darf einen Status nur nach vorne
 *  bewegen (gleicher Rang = nichts ändern). */
const STATUS_RANG = {
  offen: 0, geplant: 1, gesendet: 2, anrufen: 3, unzustellbar: 3, geantwortet: 4,
  termin: 5, offerte: 6, kein_bedarf: 7, auftrag: 7,
};
const AUTOMATIK_FELDER = ["mail_gesendet_am", "graph_message_id", "letzte_antwort_am", "letzte_antwort_betreff", "antworten_anzahl"];

function stop(text) {
  console.error(text);
  process.exit(2);
}

const argv = process.argv.slice(2);
const PROBE = argv.includes("--probe");
const [name, gruppeLabel, dateiArg] = argv.filter((a) => a !== "--probe");
if (!name || !gruppeLabel || !dateiArg) {
  stop('Aufruf: node scripts/import-vertrieb-kampagnen.mjs "<kampagnen-name>" <gruppe_label> <datei.json> [--probe]');
}
const datei = dateiArg.replace(/^~(?=\/)/, homedir());

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"(.*)"$/, "$1")]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) stop("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY fehlen in .env.local");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// ── Datei prüfen ─────────────────────────────────────────────────────────
let roh;
try { roh = JSON.parse(readFileSync(datei, "utf-8")); } catch (e) { stop(`Datei nicht lesbar: ${e.message}`); }
if (!Array.isArray(roh)) stop("Die Datei muss ein JSON-Array sein.");

const leer = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const zeilen = [];
const fehler = [];
const gesehen = new Set();
roh.forEach((r, i) => {
  if (!r || typeof r !== "object") { fehler.push(`Zeile ${i + 1}: kein Objekt`); return; }
  const z = {};
  for (const s of SPALTEN) {
    if (leer(r[s])) continue;
    z[s] = typeof r[s] === "string" ? r[s].trim() : r[s];
  }
  if (z.nr !== undefined) z.nr = String(z.nr);
  if (z.mail_text !== undefined) z.mail_text = String(r.mail_text).replace(/\r\n/g, "\n").trim();
  if (!z.nr || !z.firma) { fehler.push(`Zeile ${i + 1}: nr und firma sind Pflicht`); return; }
  if (z.status !== undefined && !STATUS.includes(z.status)) { fehler.push(`Zeile ${i + 1} (Nr. ${z.nr}): unbekannter Status «${z.status}»`); return; }
  for (const t of ["mail_geplant_am", "mail_gesendet_am", "letzte_antwort_am"]) {
    if (z[t] !== undefined && Number.isNaN(Date.parse(z[t]))) { fehler.push(`Zeile ${i + 1} (Nr. ${z.nr}): ${t} ist kein Zeitpunkt`); return; }
  }
  if (gesehen.has(z.nr)) { fehler.push(`Zeile ${i + 1}: Nr. ${z.nr} doppelt in der Datei`); return; }
  gesehen.add(z.nr);
  const unbekannt = Object.keys(r).filter((s) => !SPALTEN.includes(s) && s !== "id" && s !== "kampagne_id");
  if (unbekannt.length) console.warn(`Hinweis Zeile ${i + 1} (Nr. ${z.nr}): ignorierte Felder ${unbekannt.join(", ")}`);
  zeilen.push(z);
});
if (fehler.length) stop(`Abbruch, nichts geschrieben:\n  ${fehler.join("\n  ")}`);

// ── Kampagne ─────────────────────────────────────────────────────────────
let { data: kampagne, error: kErr } = await db.from("vertrieb_kampagnen").select("id, gruppe_label").eq("name", name).maybeSingle();
if (kErr) stop(`Kampagne nicht lesbar: ${kErr.message}`);
if (!kampagne && !PROBE) {
  const { data: max } = await db.from("vertrieb_kampagnen").select("sortierung").order("sortierung", { ascending: false }).limit(1);
  const { data, error } = await db.from("vertrieb_kampagnen")
    .insert({ name, gruppe_label: gruppeLabel, sortierung: (max?.[0]?.sortierung ?? 0) + 10 })
    .select("id, gruppe_label").single();
  if (error) stop(`Kampagne anlegen fehlgeschlagen: ${error.message}`);
  kampagne = data;
  console.log(`Kampagne «${name}» angelegt.`);
} else if (kampagne && kampagne.gruppe_label !== gruppeLabel && !PROBE) {
  const { error } = await db.from("vertrieb_kampagnen").update({ gruppe_label: gruppeLabel }).eq("id", kampagne.id);
  if (error) stop(`gruppe_label nachführen fehlgeschlagen: ${error.message}`);
}

// ── Bestehende Kontakte (Keyset über id, nie Offset) ─────────────────────
const bestand = new Map();
if (kampagne) {
  let nach = null;
  for (;;) {
    let q = db.from("vertrieb_kampagne_kontakte")
      .select("id, nr, status, status_manuell, notizen, " + AUTOMATIK_FELDER.join(", "))
      .eq("kampagne_id", kampagne.id).order("id").limit(1000);
    if (nach) q = q.gt("id", nach);
    const { data, error } = await q;
    if (error) stop(`Kontakte nicht lesbar: ${error.message}`);
    for (const r of data) bestand.set(r.nr, r);
    if (data.length < 1000) break;
    nach = data[data.length - 1].id;
  }
}

// ── Zusammenführen ───────────────────────────────────────────────────────
const neu = [];
const update = [];
for (const z of zeilen) {
  const alt = bestand.get(z.nr);
  if (!alt) { neu.push(z); continue; }
  const u = { ...z };
  // Status: nie über einen manuellen Status, nie zurück (Rangfolge) — ausser
  // der bestehende Status ist noch «offen».
  if ("status" in u && (alt.status_manuell || (alt.status !== "offen" && !(STATUS_RANG[u.status] > STATUS_RANG[alt.status])))) delete u.status;
  // Notizen: in der App Erfasstes bleibt.
  if (!leer(alt.notizen)) delete u.notizen;
  // Automatik-Felder: die Automatik hat Vorrang, die Datei füllt nur Lücken.
  for (const f of AUTOMATIK_FELDER) if (f in u && !leer(alt[f]) && alt[f] !== 0) delete u[f];
  update.push({ id: alt.id, felder: u });
}

console.log(`${zeilen.length} Zeilen in der Datei: ${neu.length} neu, ${update.length} bestehend (werden aktualisiert).`);
if (PROBE) { console.log("--probe: nichts geschrieben."); process.exit(0); }

let eingefuegt = 0;
for (let i = 0; i < neu.length; i += 200) {
  const block = neu.slice(i, i + 200).map((z) => ({ ...z, kampagne_id: kampagne.id }));
  const { data, error } = await db.from("vertrieb_kampagne_kontakte").insert(block).select("id");
  if (error) stop(`Einfügen fehlgeschlagen nach ${eingefuegt}: ${error.message}`);
  eingefuegt += data.length;
}
let aktualisiert = 0;
for (const { id, felder } of update) {
  const { data, error } = await db.from("vertrieb_kampagne_kontakte").update(felder).eq("id", id).select("id");
  if (error) stop(`Aktualisieren fehlgeschlagen (Nr. ${felder.nr}) nach ${aktualisiert}: ${error.message}`);
  aktualisiert += data.length;
}

const { count, error: cErr } = await db.from("vertrieb_kampagne_kontakte")
  .select("id", { count: "exact", head: true }).eq("kampagne_id", kampagne.id);
if (cErr) stop(`Kontrolle fehlgeschlagen: ${cErr.message}`);
console.log(`Eingefügt: ${eingefuegt} · aktualisiert: ${aktualisiert} · Kontakte in «${name}» jetzt: ${count}`);
if (count < zeilen.length) stop(`ACHTUNG: weniger Kontakte in der DB (${count}) als in der Datei (${zeilen.length}).`);
