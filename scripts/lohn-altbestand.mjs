#!/usr/bin/env node
// Altbestand übernehmen (Lohn-Umbau Phase 2): bestehende Lohnabrechnungs-PDFs
// ohne Momentaufnahme auslesen und als Fassung «Altbestand» mit Positionen
// speichern — geprüft gegen das PDF, NIE neu gerechnet.
//
// Prüfungen je PDF (sonst keine Übernahme, Meldung):
//   - Monat im PDF = Periode der Zeile
//   - Summe der Lohnarten = Bruttolohn (Rundung höchstens 3 Rappen)
//   - Summe der Abzüge = «Total Abzüge»; Brutto − Total = Auszahlung (1 Rappen)
//
// Aufrufe:
//   node scripts/lohn-altbestand.mjs --pruefen-ordner <ordner>
//        offline: nur PDFs lesen und prüfen (keine Datenbank); Ausgabe nur Zählungen
//   node scripts/lohn-altbestand.mjs
//        Trockenlauf gegen die Datenbank aus .env.local (liest, schreibt nichts)
//   node scripts/lohn-altbestand.mjs --schreiben [--auszahlungen <datei.csv>]
//        übernimmt; CSV mit Kopf «profile_id,jahr,monat,datum» setzt das echte
//        Auszahlungsdatum, sonst Regel (n-ter Arbeitstag Folgemonat, «geschätzt»)
//   Live: zusätzlich --live und SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY als
//        Umgebungsvariablen (Anleitung: supabase/lokal/live-gang-phase2/LIVE-GANG.md).
//
// Ausgabe ohne Personendaten (nur IDs/Zählungen). Idempotent: schon übernommene
// PDFs (gleiche Zeile + gleiche Prüfsumme) werden übersprungen.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { pdfZeilen } from "./lohn-pdf-text.mjs";

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// ---------------------------------------------------------------------------
// PDF lesen und prüfen (rein)
// ---------------------------------------------------------------------------
const zahl = (s) => Number(String(s).replace(/[’'\s]/g, "").replace(/,(?=\d{2}$)/, "."));
const BETRAG = /(?:[-–+]\s*)?CHF\s*([\d’',.]+)\s*$/;

function lohnartAus(label) {
  if (/^Grundlohn|^Basislohn|^Stunden(?!lohn \(brutto)/.test(label)) return "normal";
  if (/^Ferienanteil|^Ferienzuschlag/.test(label)) return "ferien";
  if (/^Nachtzuschlag/.test(label)) return "nacht";
  if (/^Sonntags/.test(label)) return "sonntag";
  if (/1\. August|Feiertagsentsch/.test(label)) return "feiertag_1aug";
  return "sonstige";
}

const ABZUG = { AHV_IV_EO: "ahv_iv_eo", "AHV/IV/EO": "ahv_iv_eo", ALV: "alv", NBU: "nbu", BVG: "bvg", KTG: "ktg", Quellensteuer: "quellensteuer" };

/** Liest eine Lohnabrechnung des alten Generators (Phase 1 und früher). */
export function leseAltePdf(zeilenObj) {
  const z = zeilenObj.map((x) => x.text);
  const fehler = [];
  const titel = z.findIndex((t) => /^Lohnabrechnung\b/.test(t));
  let jahr = null;
  let monat = null;
  for (const t of z.slice(0, 8)) {
    const m = new RegExp(`(${MONATE.join("|")}) (\\d{4})`).exec(t);
    if (m) { monat = MONATE.indexOf(m[1]) + 1; jahr = Number(m[2]); break; }
  }
  if (titel < 0 || !jahr) fehler.push("Kopf (Lohnabrechnung Monat Jahr) nicht gefunden");

  let minuten = null;
  for (const t of z) {
    const m = /^(Gestempelt|Rapportiert|Rapport)[^\d]*\(Basis Abrechnung\)\s+(\d+):(\d{2}) h$/.exec(t);
    if (m) { minuten = Number(m[2]) * 60 + Number(m[3]); break; }
  }
  const stundenlohn = (() => { for (const t of z) { const m = /^Stundenlohn \(brutto[^)]*\)\s+CHF ([\d’',.]+) \/ h$/.exec(t); if (m) return zahl(m[1]); } return null; })();
  const ferienPct = (() => { for (const t of z) { const m = /Ferienanteil ([\d.]+)%/.exec(t); if (m) return Number(m[1]); } return null; })();

  const iVerg = z.findIndex((t) => /^Vergütung$/.test(t));
  const iBrutto = z.findIndex((t) => /^Bruttolohn\b/.test(t));
  const brutto = iBrutto >= 0 && BETRAG.test(z[iBrutto]) ? zahl(BETRAG.exec(z[iBrutto])[1]) : null;
  if (brutto == null) fehler.push("Bruttolohn nicht gefunden");
  const positionen = [];
  if (iVerg >= 0 && iBrutto > iVerg) {
    for (const t of z.slice(iVerg + 1, iBrutto)) {
      if (/^Stundenlohn \(brutto/.test(t) || /^davon /.test(t) || !BETRAG.test(t)) continue;
      const betrag = zahl(BETRAG.exec(t)[1]);
      const label = t.replace(BETRAG, "").trim();
      const h = /\(([\d.]+) h ×/.exec(label);
      const ansatz = /× CHF ([\d’',.]+)/.exec(label);
      positionen.push({
        lohnart: lohnartAus(label),
        bezeichnung: label,
        minuten: h ? Math.round(Number(h[1]) * 60) : null,
        ansatz: ansatz ? zahl(ansatz[1]) : null,
        prozent: null,
        basis: null,
        betrag,
      });
    }
  } else {
    fehler.push("Abschnitt Vergütung nicht gefunden");
  }

  const iAbz = z.findIndex((t) => /^Abzüge( Mitarbeiter)?$/.test(t));
  const iTotal = z.findIndex((t) => /^Total Abzüge/.test(t));
  const total = iTotal >= 0 && BETRAG.test(z[iTotal]) ? zahl(BETRAG.exec(z[iTotal])[1]) : null;
  const abzuege = [];
  let nbuBegruendung = null;
  if (iAbz >= 0 && iTotal > iAbz) {
    for (const t of z.slice(iAbz + 1, iTotal)) {
      const m = /^([A-Za-z_/]+)(?: \(([\d.]+)%\))?/.exec(t);
      if (!m || !BETRAG.test(t)) continue;
      const art = ABZUG[m[1].replace(/:$/, "")] ?? (t.startsWith("NBU:") ? "nbu" : null);
      if (!art) { fehler.push(`Abzug unbekannt: ${m[1]}`); continue; }
      if (t.startsWith("NBU:")) nbuBegruendung = t.replace(BETRAG, "").replace(/^NBU:\s*/, "").trim();
      abzuege.push({ art, bezeichnung: m[1].replace(/_/g, "/").replace(/:$/, ""), prozent: m[2] ? Number(m[2]) : 0, basis: brutto, betrag: zahl(BETRAG.exec(t)[1]) });
    }
  } else {
    fehler.push("Abschnitt Abzüge nicht gefunden");
  }
  if (total == null) fehler.push("Total Abzüge nicht gefunden");
  const iAus = z.findIndex((t) => /^Auszahlung\s+CHF/.test(t));
  const auszahlung = iAus >= 0 ? zahl(BETRAG.exec(z[iAus])[1]) : null;
  if (auszahlung == null) fehler.push("Auszahlung nicht gefunden");

  const rund = (x) => Math.round(x * 100) / 100;
  const sumPos = rund(positionen.reduce((s, p) => s + p.betrag, 0));
  const sumAbz = rund(abzuege.reduce((s, a) => s + a.betrag, 0));
  if (brutto != null && Math.abs(sumPos - brutto) > 0.031) fehler.push(`Summe Lohnarten ${sumPos} ≠ Brutto ${brutto}`);
  if (total != null && Math.abs(sumAbz - total) > 0.031) fehler.push(`Summe Abzüge ${sumAbz} ≠ Total ${total}`);
  if (brutto != null && total != null && auszahlung != null && Math.abs(rund(brutto - total) - auszahlung) > 0.011) {
    fehler.push(`Brutto − Abzüge ${rund(brutto - total)} ≠ Auszahlung ${auszahlung}`);
  }
  const nbu = abzuege.find((a) => a.art === "nbu");
  const qst = abzuege.find((a) => a.art === "quellensteuer");
  return {
    ok: fehler.length === 0,
    fehler,
    jahr,
    monat,
    werte: {
      quelle: "altbestand",
      jahr,
      monat,
      minuten,
      stundenlohn,
      ferienPct,
      positionen,
      brutto,
      abzuege,
      totalAbzuege: total,
      netto: auszahlung,
      rundungsdifferenz: brutto != null ? rund(sumPos - brutto) : null,
      nbu: { versichert: (nbu?.betrag ?? 0) > 0, begruendung: nbuBegruendung },
      loehne: { ahv: brutto, alv: brutto, uvg: brutto, uvgArt: (nbu?.betrag ?? 0) > 0 ? "bu_nbu" : "bu", quellensteuer: brutto },
      quellensteuer: qst?.betrag ?? 0,
      pdfText: z,
    },
  };
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function kanonisch(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(kanonisch).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(v[k])}`).join(",")}}`;
}
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");

// Feiertage Basel-Stadt (wie src/lib/lohn/kern/feiertage.ts) für die Regel-Auszahlung.
function ostern(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Date.UTC(j, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
function feiertage(j) {
  const o = ostern(j), t = 86400000;
  return new Set([`${j}-01-01`, `${j}-01-02`, iso(o - 2 * t), iso(o + t), `${j}-05-01`, iso(o + 39 * t), iso(o + 50 * t), `${j}-08-01`, `${j}-12-25`, `${j}-12-26`]);
}
function regelAuszahlung(jahr, monat, n) {
  const fj = monat === 12 ? jahr + 1 : jahr, fm = monat === 12 ? 1 : monat + 1;
  const frei = feiertage(fj);
  let d = Date.UTC(fj, fm - 1, 1), z = 0;
  for (let i = 0; i < 40; i++, d += 86400000) {
    const wt = new Date(d).getUTCDay();
    if (wt !== 0 && wt !== 6 && !frei.has(iso(d)) && ++z === n) return iso(d);
  }
  throw new Error("Auszahlungstag nicht gefunden");
}

function env() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const datei = path.join(root, ".env.local");
  const e = fs.existsSync(datei)
    ? Object.fromEntries(fs.readFileSync(datei, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
    : {};
  return {
    url: process.env.SUPABASE_URL ?? e.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? e.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function alle(abfrage) {
  const out = [];
  for (let von = 0; ; von += 1000) {
    const { data, error } = await abfrage(von, von + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

// ---------------------------------------------------------------------------
// Hauptprogramm
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const iOrdner = args.indexOf("--pruefen-ordner");
  if (iOrdner >= 0) {
    const ordner = args[iOrdner + 1];
    const dateien = fs.readdirSync(ordner).filter((d) => d.toLowerCase().endsWith(".pdf")).sort();
    let ok = 0;
    const gruende = new Map();
    for (const [i, d] of dateien.entries()) {
      const r = leseAltePdf(await pdfZeilen(fs.readFileSync(path.join(ordner, d))));
      const m = /_(\d{4})-(\d{2})\.pdf$/.exec(d);
      if (m && (Number(m[1]) !== r.jahr || Number(m[2]) !== r.monat)) r.fehler.push("Monat im Dateinamen ≠ Monat im PDF");
      if (r.fehler.length === 0) ok++;
      else {
        console.log(`  PDF Nr. ${i + 1}: ${r.fehler.length} Befund(e)`);
        for (const f of r.fehler) gruende.set(f.replace(/[\d.]+/g, "#"), (gruende.get(f.replace(/[\d.]+/g, "#")) ?? 0) + 1);
      }
    }
    console.log(`${dateien.length} PDFs gelesen, ${ok} geprüft ohne Befund, ${dateien.length - ok} mit Befund.`);
    for (const [g, n] of gruende) console.log(`  ${n}× ${g}`);
    process.exit(ok === dateien.length ? 0 : 1);
  }

  const schreiben = args.includes("--schreiben");
  const { url, key } = env();
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY fehlen (.env.local oder Umgebung)");
  const lokal = /^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(url);
  if (!lokal && !args.includes("--live")) throw new Error(`Ziel ist nicht die lokale Testumgebung (${url}) — für Live ausdrücklich --live angeben`);
  console.log(`Ziel: ${lokal ? "lokal" : "LIVE"} · ${schreiben ? "SCHREIBEN" : "Trockenlauf (schreibt nichts)"}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const auszahlungen = new Map();
  const iAz = args.indexOf("--auszahlungen");
  if (iAz >= 0) {
    for (const zeile of fs.readFileSync(args[iAz + 1], "utf8").split(/\r?\n/).slice(1)) {
      const [pid, j, m, d] = zeile.split(",").map((x) => x.trim());
      if (pid && /^\d{4}-\d{2}-\d{2}$/.test(d ?? "")) auszahlungen.set(`${pid}|${Number(j)}|${Number(m)}`, d);
    }
  }
  const { data: einst, error: eErr } = await db.from("lohn_einstellungen").select("auszahlung_arbeitstag").eq("id", "default").single();
  if (eErr) throw new Error(`lohn_einstellungen: ${eErr.message} (Migration 364 eingespielt?)`);

  const docs = await alle((a, b) => db.from("wage_documents").select("id, profile_id, year, period_month, storage_path, archived_at, superseded_at, source")
    .eq("doc_type", "lohnabrechnung").order("id").range(a, b));
  const schon = new Set((await alle((a, b) => db.from("lohn_momentaufnahmen").select("wage_document_id").order("id").range(a, b))).map((r) => r.wage_document_id));
  // Lohnabrechnungen aus Bexio (Quelle «bexio», ab Dezember 2026 über Trust flow) sind kein Altbestand.
  const offen = docs.filter((d) => !schon.has(d.id) && !d.superseded_at && d.source !== "bexio");
  console.log(`${docs.length} Lohnabrechnungen, ${schon.size} mit Momentaufnahme, ${offen.length} offen (davon ${offen.filter((d) => d.archived_at).length} im Papierkorb)`);

  let uebernommen = 0;
  let befunde = 0;
  const summe = { brutto: 0, netto: 0 };
  for (const d of offen) {
    const { data: blob, error: dErr } = await db.storage.from("lohndokumente").download(d.storage_path);
    if (dErr || !blob) { befunde++; console.log(`  ${d.id}: PDF nicht ladbar (${dErr?.message})`); continue; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const r = leseAltePdf(await pdfZeilen(bytes));
    if (r.jahr !== d.year || r.monat !== d.period_month) r.fehler.push("Monat im PDF ≠ Periode der Zeile");
    if (r.fehler.length > 0) { befunde++; console.log(`  ${d.id}: ${r.fehler.join("; ")}`); continue; }
    const pdfSha = sha256(bytes);
    const azEcht = auszahlungen.get(`${d.profile_id}|${d.year}|${d.period_month}`);
    const auszahlungsdatum = azEcht ?? regelAuszahlung(d.year, d.period_month, einst.auszahlung_arbeitstag);
    const ergebnis = { ...r.werte, auszahlungsdatum, lohnperiode: null };
    const pruefsumme = sha256(kanonisch({ art: "altbestand", auszahlungsdatum, ergebnis, pdf_sha256: pdfSha }));
    summe.brutto += r.werte.brutto;
    summe.netto += r.werte.netto;
    if (!schreiben) { uebernommen++; continue; }
    const { data: res, error } = await db.rpc("lohn_momentaufnahme_speichern", {
      p_profile_id: d.profile_id, p_jahr: d.year, p_monat: d.period_month, p_art: "altbestand",
      p_storage_path: d.storage_path, p_file_size: bytes.byteLength, p_pdf_sha256: pdfSha,
      p_actor: null, p_actor_name: "Altbestand-Übernahme (Skript)", p_nur_wenn_keine_gueltige: false,
      p_auszahlungsdatum: auszahlungsdatum, p_geschaetzt: !azEcht, p_kern_version: null,
      p_eingaben: null, p_ergebnis: ergebnis, p_pruefsumme: pruefsumme,
      p_werte: {
        brutto: r.werte.brutto, total_abzuege: r.werte.totalAbzuege, netto: r.werte.netto, ahv_lohn: r.werte.brutto, alv_lohn: r.werte.brutto,
        uvg_lohn: r.werte.brutto, uvg_art: r.werte.loehne.uvgArt, quellensteuer: r.werte.quellensteuer,
      },
      p_begruendung: "Altbestand: aus der bestehenden PDF übernommen (nicht neu gerechnet)",
      p_wage_document_id: d.id,
    });
    if (error) { befunde++; console.log(`  ${d.id}: ${error.message}`); continue; }
    if (res?.modus === "vorhanden") continue;
    uebernommen++;
  }
  console.log(`${schreiben ? "Übernommen" : "Übernehmbar"}: ${uebernommen}, Befunde: ${befunde}, Summe Brutto CHF ${summe.brutto.toFixed(2)}, Netto CHF ${summe.netto.toFixed(2)}`);
  process.exit(befunde === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`ABBRUCH: ${e.message}`); process.exit(2); });
}
