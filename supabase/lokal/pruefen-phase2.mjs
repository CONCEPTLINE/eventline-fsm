#!/usr/bin/env node
// Prüftor Lohn-Umbau Phase 2 — NUR LOKAL (Docker-Supabase + Dev-Server :3100).
//
//   A  Altbestand: PDFs des alten Generators (supabase/lokal/ausgabe/altbestand/,
//      erzeugt mit altbestand-erzeugen.mjs) wie auf Live ablegen, Werkzeug
//      scripts/lohn-altbestand.mjs (Trockenlauf, Übernahme, zweiter Lauf = nichts)
//   B  Alle Rechenwege gleich: Monatstabelle, Lohnabrechnung (Momentaufnahme),
//      Excel, Lohn-Details — je Person/Monat auf den Rappen; «Mein Monat» gegen
//      Monatstabelle im laufenden Monat
//   C  Regeln am Ergebnis: Lohn tageweise, Sonntag Sa 23–So 23, Ferienzuschlag
//      nach Alter, NBU 7/87, Quellensteuer, Anstellung (Austritt), Lauf
//   D  Momentaufnahme: Eingaben/Ergebnis/Prüfsumme, sha256(PDF), Korrekturfassung
//      (Begründung Pflicht, Auszahlung = Differenz zur Vorfassung)
//   E  Sperre und Vier Augen: Lohnzeile/Anstellung/Firmensätze in abgerechneten
//      Monaten nur per Antrag, Bestätigung durch die zweite Person, Protokoll,
//      Korrektur-Vorschläge
//   F  Jahresliste: nur letzte Fassung, Korrektur im Auszahlungsjahr, Excel
//   G  Seitenweises Laden: > 1000 Stempel in einem Monat
//
// Aufruf: bash supabase/lokal/aufbauen.sh --nur-seed && node supabase/lokal/pruefen-phase2.mjs
// Meldet sich überall nur LOKAL ab. Ändert nur die lokale Test-DB.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const APP = "http://localhost:3100";
const DB = "supabase_db_eventline-fsm-lohn";
const env = Object.fromEntries(fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(URL_ ?? "")) {
  console.error(`ABBRUCH: .env.local zeigt nicht auf das lokale Supabase (${URL_}).`);
  process.exit(1);
}
const ALT = path.join(here, "ausgabe", "altbestand");
if (!fs.existsSync(path.join(ALT, "manifest.json"))) {
  console.error("ABBRUCH: Altbestand-PDFs fehlen — einmalig mit supabase/lokal/altbestand-erzeugen.mjs erzeugen (Anleitung im Dateikopf).");
  process.exit(1);
}
if (!env.CRON_SECRET) {
  console.error("ABBRUCH: CRON_SECRET fehlt in .env.local.");
  process.exit(1);
}

const P = (n) => `a0000000-0000-4000-8000-0000000000${n}`;
const ID = { admin: P("01"), admin2: P("02"), lena: P("11"), noah: P("12"), mia: P("13"), elias: P("14"), sara: P("15"), jonas: P("16"), lara: P("17"), luca: P("18"), ben: P("19") };
const PW = "LohnTest-2026!";
const service = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fehler = 0;
const ok = (b, msg) => { console.log(`${b ? "OK    " : "FEHLER"} ${msg}`); if (!b) fehler++; return b; };
const titel = (t) => console.log(`\n== ${t}`);
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sqlFehler = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };
const gleich = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
const mm = (j, m) => `${j}-${String(m).padStart(2, "0")}`;

const sitzungen = [];
async function login(email, geraet) {
  const jar = new Map();
  const supa = createServerClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await supa.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`Login ${email}: ${error.message}`);
  sitzungen.push(supa);
  const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).concat(geraet ? [`eventline_trusted_device=${geraet}`] : []).join("; ");
  const api = async (pfad, init = {}) => {
    const res = await fetch(`${APP}${pfad}`, {
      ...init, redirect: "manual",
      headers: { cookie: cookie(), ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch { /* binär */ }
    return { status: res.status, json, buf };
  };
  return { api };
}
const post = (s, pfad, body) => s.api(pfad, { method: "POST", body: JSON.stringify(body) });

// Zähler am Reiter «Rechte & Lohndaten» (/antraege?tab=rechte) = Anzahl «Bestätigen»-Knöpfe
// im Reiter (darf_bestaetigen der offenen Rechte- und Lohndaten-Anträge).
const zaehlerReiter = async (s) => (await s.api("/api/admin/rechte-antraege/zaehler")).json?.anzahl;
async function knoepfeReiter(s) {
  const [r, l] = await Promise.all([s.api("/api/admin/rechte-antraege"), s.api("/api/hr/lohn-antraege")]);
  return [...(r.json?.offen ?? []), ...(l.json?.offen ?? [])].filter((a) => a.darf_bestaetigen).length;
}

async function excelZeile(s, von, bis, name) {
  const r = await s.api(`/api/hr/timesheet?from=${von}&to=${bis}`);
  if (r.status !== 200) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const sh = wb.getWorksheet("Übersicht");
  let out = null;
  sh.eachRow((row, i) => {
    if (i === 1) return;
    if (String(row.getCell(1).value).startsWith(name)) {
      out = { stunden: Number(row.getCell(3).value), brutto: Number(row.getCell(8).value), netto: Number(row.getCell(10).value) };
    }
  });
  return out;
}

try {
  const admin = await login("lohn-admin@example.com", "lokal-testgeraet-admin");
  const admin2 = await login("lohn-admin2@example.com", "lokal-testgeraet-admin2");
  sql(`update lohn_einstellungen set lauf_ab = '2026-03-01' where id = 'default'`);

  // -------------------------------------------------------------------------
  titel("A  Altbestand (alte PDFs → Momentaufnahme «altbestand»)");
  const manifest = JSON.parse(fs.readFileSync(path.join(ALT, "manifest.json"), "utf8"));
  for (const f of manifest) {
    const bytes = fs.readFileSync(path.join(ALT, f.datei));
    const pfad = `${f.profile_id}/${f.jahr}/${mm(f.jahr, f.monat)}/v1-altbestand-test.pdf`;
    await service.storage.from("lohndokumente").remove([pfad]);
    const up = await service.storage.from("lohndokumente").upload(pfad, bytes, { contentType: "application/pdf", upsert: false });
    if (up.error) throw new Error(up.error.message);
    const { error } = await service.rpc("lohn_fassung_speichern", {
      p_profile_id: f.profile_id, p_doc_type: "lohnabrechnung", p_year: f.jahr, p_period_month: f.monat, p_storage_path: pfad,
      p_file_size: bytes.byteLength, p_source: "auto", p_actor: null, p_actor_name: "Alter Generator (Test)", p_notes: null,
      p_nur_wenn_keine_gueltige: true, p_details: {},
    });
    if (error) throw new Error(error.message);
  }
  ok(Number(sql(`select count(*) from wage_documents where storage_path like '%altbestand-test%'`)) === manifest.length, `${manifest.length} alte PDFs wie auf Live abgelegt (ohne Momentaufnahme)`);
  const lara9 = await post(admin, "/api/hr/wage-documents/generate", { profile_id: ID.lara, year: 2026, month: 9, neue_fassung: true, begruendung: "Test: vor der Übernahme" });
  ok(lara9.status === 409 && lara9.json?.code === "altbestand", `Korrektur vor der Übernahme verweigert → ${lara9.status} ${lara9.json?.code}`);
  const skript = (args) => {
    try { return { rc: 0, out: execFileSync("node", ["scripts/lohn-altbestand.mjs", ...args], { cwd: root, encoding: "utf8" }) }; }
    catch (e) { return { rc: e.status, out: String(e.stdout) + String(e.stderr) }; }
  };
  const trocken = skript([]);
  ok(trocken.rc === 0 && /Übernehmbar: 11, Befunde: 0/.test(trocken.out) && Number(sql(`select count(*) from lohn_momentaufnahmen`)) === 0, "Trockenlauf: 11 übernehmbar, nichts geschrieben");
  const schreiben = skript(["--schreiben"]);
  ok(schreiben.rc === 0 && /Übernommen: 11, Befunde: 0/.test(schreiben.out), "Übernahme: 11 Momentaufnahmen «altbestand»");
  ok(skript(["--schreiben"]).out.includes("Übernommen: 0"), "zweiter Lauf übernimmt nichts (idempotent)");
  const alt = sql(`select count(*) filter (where art='altbestand' and eingaben is null and auszahlungsdatum_geschaetzt and pdf_sha256 is not null), count(*) filter (where abs(brutto - total_abzuege - netto) > 0.005) from lohn_momentaufnahmen`).split("|");
  ok(alt[0] === "11" && alt[1] === "0", `Altbestand: ohne Eingaben, Datum geschätzt, PDF-Prüfsumme; Brutto − Abzüge = Netto (${alt.join("/")})`);
  const altLara = JSON.parse(sql(`select ergebnis::text from lohn_momentaufnahmen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 9`));
  ok(altLara.brutto === 336 && altLara.positionen.length >= 2, `Lara 09/2026 aus PDF gelesen: Brutto ${altLara.brutto} (alter Generator: 12 h × 28.00)`);
  const regulaer = await post(admin, "/api/hr/wage-documents/generate", { profile_id: ID.lara, year: 2026, month: 9 });
  ok(regulaer.status === 409 && regulaer.json?.code === "neue_fassung", `regulär für übernommenen Monat → ${regulaer.status} (nur Korrektur)`);

  // -------------------------------------------------------------------------
  titel("B  Alle Rechenwege rechnen gleich");
  const faelle = [[ID.lara, "Lara Steiner", 2026, 8], [ID.noah, "Noah Brunner", 2026, 3], [ID.luca, "Luca Rossi", 2026, 9], [ID.lena, "Lena Jung", 2026, 9], [ID.elias, "Elias Meier", 2026, 9]];
  for (const [pid, name, j, m] of faelle) {
    const von = `${mm(j, m)}-01`;
    const bis = `${mm(j, m)}-${new Date(Date.UTC(j, m, 0)).getUTCDate()}`;
    const tab = (await admin.api(`/api/hr/monthly-stats?month=${mm(j, m)}`)).json?.employees?.find((e) => e.profile_id === pid);
    const det = (await admin.api(`/api/hr/employee-detail?profile_id=${pid}&year=${j}&month=${m}`)).json?.monat;
    const xls = await excelZeile(admin, von, bis, name);
    const gen = await post(admin, "/api/hr/wage-documents/generate", { profile_id: pid, year: j, month: m });
    const snap = sql(`select brutto || '|' || netto || '|' || (ergebnis->'mengen'->>'minuten') from lohn_momentaufnahmen where profile_id = '${pid}' and jahr = ${j} and monat = ${m} order by fassung desc limit 1`).split("|").map(Number);
    const werte = [tab?.lohnkosten_chf, det?.brutto, xls?.brutto, snap[0]];
    const netto = [tab?.nettolohn_chf, det?.netto, xls?.netto, snap[1]];
    const min = [tab?.stempel_minutes, det?.minuten, Math.round((xls?.stunden ?? NaN) * 60), snap[2]];
    ok(gen.status === 200 && werte.every((w) => gleich(w, werte[0])) && netto.every((w) => gleich(w, netto[0])) && min.every((w) => w === min[0]),
      `${name} ${mm(j, m)}: Monatstabelle = Lohn-Details = Excel = Lohnabrechnung — Brutto ${werte.join(" / ")}, Netto ${netto.join(" / ")}, Min ${min.join(" / ")}`);
  }
  // «Mein Monat» (nur laufender Monat) gegen Monatstabelle
  const heute = sql(`select to_char((now() at time zone 'Europe/Zurich')::date, 'YYYY-MM')`);
  const laraS = await login("lara.steiner@example.com", null);
  const mein = (await laraS.api("/api/dashboard")).json?.monat;
  const tabHeute = (await admin.api(`/api/hr/monthly-stats?month=${heute}`)).json?.employees?.find((e) => e.profile_id === ID.lara);
  ok(mein && tabHeute && gleich(mein.stunden, Math.round(tabHeute.stempel_minutes / 60 * 100) / 100) && gleich(mein.prognose_chf, tabHeute.nettolohn_chf),
    `«Mein Monat» ${heute} (keine Termine) = Monatstabelle: ${mein?.stunden} h / CHF ${mein?.prognose_chf} vs ${tabHeute?.stempel_minutes} min / CHF ${tabHeute?.nettolohn_chf}`);
  const xlsMehr = await excelZeile(admin, "2026-07-01", "2026-08-31", "Lara Steiner");
  const tab7 = (await admin.api(`/api/hr/monthly-stats?month=2026-07`)).json?.employees?.find((e) => e.profile_id === ID.lara);
  const tab8 = (await admin.api(`/api/hr/monthly-stats?month=2026-08`)).json?.employees?.find((e) => e.profile_id === ID.lara);
  ok(gleich(xlsMehr?.brutto, tab7.lohnkosten_chf + tab8.lohnkosten_chf), `Excel Juli–August = Summe der Monatsergebnisse (${xlsMehr?.brutto})`);
  const xlsTeil = await excelZeile(admin, "2026-08-10", "2026-08-12", "Lara Steiner");
  ok(gleich(xlsTeil?.brutto, tab8.lohnkosten_chf), "Excel mit Teilzeitraum rechnet den ganzen Lohnmonat");

  // -------------------------------------------------------------------------
  titel("C  Regeln am Ergebnis");
  const det = async (pid, j, m) => (await admin.api(`/api/hr/employee-detail?profile_id=${pid}&year=${j}&month=${m}`)).json;
  const lara9d = await det(ID.lara, 2026, 9);
  const normal = lara9d.monat.positionen.filter((p) => p.lohnart === "normal");
  ok(normal.length === 2 && normal.every((p) => p.minuten === 360), `Lara 09: Lohn tageweise — zwei Ansätze (${normal.map((p) => p.ansatz.toFixed(2)).join(" / ")}), je 6 h`);
  ok(gleich(lara9d.monat.brutto, 325.15), `Lara 09: Brutto ${lara9d.monat.brutto} (statt 336.00 des alten Generators)`);
  const noah8 = await det(ID.noah, 2026, 8);
  const so = noah8.monat.positionen.filter((p) => p.lohnart === "sonntag").reduce((s, p) => s + p.minuten, 0);
  ok(so === 360 + 180, `Noah 08: Sonntag Sa 23–So 23 → ${so} min mit Zuschlag (Sa 21–So 05: 6 h, So 20–Mo 00:30: 3 h)`);
  const lena7 = await det(ID.lena, 2026, 7);
  const lena8 = await det(ID.lena, 2026, 8);
  const ferien = (d) => d.monat.positionen.find((p) => p.lohnart === "ferien")?.prozent;
  ok(ferien(lena7) === 10.64 && ferien(lena8) === 8.33, `Lena: Ferienzuschlag Juli ${ferien(lena7)} % (Monat 20. Geburtstag), August ${ferien(lena8)} %`);
  ok(lena8.monat.positionen.some((p) => p.lohnart === "feiertag_1aug"), "1.-August-Zuschlag 0,39 % als eigene Lohnart");
  const mia = await det(ID.mia, 2026, 6);
  const elias = await det(ID.elias, 2026, 6);
  ok(mia.compensation.nbu.versichert === false && elias.compensation.nbu.versichert === true, `NBU 7/87: Mia Ø 7.75 h nicht versichert, Elias Ø 8.25 h versichert`);
  const luca = await det(ID.luca, 2026, 9);
  ok(luca.compensation.quellensteuer_pct === 10.58, `Luca: Quellensteuer fester Satz ${luca.compensation.quellensteuer_pct} %`);
  const probe = await fetch(`${APP}/api/cron/auto-lohnabrechnung?probe=1`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }).then((r) => r.json());
  const benMonate = (probe.plan ?? []).filter((p) => p.profile_id === ID.ben).map((p) => p.monat);
  ok(!benMonate.some((m) => m > "2026-06"), `Lauf: Ben nach Austritt 30.06. nichts geplant (${benMonate.join(", ") || "—"})`);
  ok(lena7.night && lena7.sunday_holiday && Array.isArray(noah8.night.dates) && noah8.night.dates.every((d) => /Nacht/.test(d.label ?? "")), "Lohn-Details: Nächte mit Rang");

  // -------------------------------------------------------------------------
  titel("D  Momentaufnahme und Korrekturfassung");
  const m = JSON.parse(sql(`select json_build_object('ein', eingaben is not null, 'erg', ergebnis is not null, 'sum', length(pruefsumme), 'sha', pdf_sha256, 'pfad', storage_path, 'art', art, 'kern', kern_version)::text
    from lohn_momentaufnahmen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 8`));
  ok(m.ein && m.erg && m.sum === 64 && m.art === "regulaer" && /^2026/.test(m.kern), `Fassung Lara 08: Eingaben, Ergebnis, Prüfsumme, Kern ${m.kern}`);
  const pdf = await service.storage.from("lohndokumente").download(m.pfad);
  const pdfBytes = Buffer.from(await pdf.data.arrayBuffer());
  ok(crypto.createHash("sha256").update(pdfBytes).digest("hex") === m.sha, "sha256 der gespeicherten PDF = Momentaufnahme (PDF aus der Momentaufnahme gedruckt)");
  const ohne = await post(admin, "/api/hr/wage-documents/generate", { profile_id: ID.lara, year: 2026, month: 9, neue_fassung: true });
  ok(ohne.status === 400 && ohne.json?.code === "begruendung_fehlt", `Korrektur ohne Begründung → ${ohne.status}`);
  const korr = await post(admin, "/api/hr/wage-documents/generate", { profile_id: ID.lara, year: 2026, month: 9, neue_fassung: true, begruendung: "Test: Lohn tageweise (Erhöhung 15.09.)", auszahlungsdatum: "2026-12-07" });
  const k = sql(`select fassung || '|' || art || '|' || netto || '|' || auszahlung || '|' || auszahlungsdatum || '|' || (select netto from lohn_momentaufnahmen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 9 and fassung = 1) from lohn_momentaufnahmen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 9 and fassung = 2`).split("|");
  ok(korr.status === 200 && k[1] === "korrektur" && gleich(Number(k[3]), Number(k[2]) - Number(k[5])) && k[4] === "2026-12-07",
    `Korrekturfassung 2: Netto ${k[2]} − bereits ${k[5]} = Auszahlung ${k[3]} am ${k[4]}`);
  ok(Number(sql(`select count(*) from wage_documents where profile_id = '${ID.lara}' and year = 2026 and period_month = 9 and archived_at is null and superseded_at is null`)) === 1, "je Monat genau eine gültige PDF");
  ok(sqlFehler(`update lohn_momentaufnahmen set netto = 0 where profile_id = '${ID.lara}'`) !== null && sqlFehler(`delete from lohn_momentaufnahmen where profile_id = '${ID.lara}'`) !== null, "Momentaufnahmen: weder änderbar noch löschbar (DB)");

  // -------------------------------------------------------------------------
  titel("E  Sperre, Antrag, Vier Augen, Protokoll, Korrektur-Vorschläge");
  const zeile15 = sql(`select id from employee_compensation where profile_id = '${ID.lara}' and effective_from = '2026-09-15'`);
  ok(sqlFehler(`update employee_compensation set hourly_wage_chf = 99 where id = '${zeile15}'`)?.includes("nur per Antrag"), "DB: Lohnzeile in abgerechnetem Monat direkt ändern → verweigert");
  const ohneB = await post(admin, "/api/hr/compensation", { profile_id: ID.lara, hourly_wage_chf: 28.5, effective_from: "2026-09-15", uses_standard_lohn: true, wage_exempt: false, auto_lohnabrechnung: true });
  ok(ohneB.status === 409 && ohneB.json?.code === "begruendung_noetig", `Lohn-Editor ohne Begründung → ${ohneB.status} ${ohneB.json?.code}`);
  const mitB = await post(admin, "/api/hr/compensation", { profile_id: ID.lara, hourly_wage_chf: 28.5, effective_from: "2026-09-15", uses_standard_lohn: true, wage_exempt: false, auto_lohnabrechnung: true, begruendung: "Test: Vertrag sagt 28.50 ab 15.09." });
  ok(mitB.status === 200 && mitB.json?.mode === "antrag" && sql(`select hourly_wage_chf from employee_compensation where id = '${zeile15}'`) === "28.00", `mit Begründung → Antrag, Lohn noch unverändert`);
  const antrag = (await admin.api("/api/hr/lohn-antraege")).json?.offen?.[0];
  const [zA, zB] = [await zaehlerReiter(admin), await zaehlerReiter(admin2)];
  const dash2 = (await admin2.api("/api/dashboard")).json?.aufmerksamkeit?.rechte_antraege;
  ok(zB >= 1 && zB === (await knoepfeReiter(admin2)) && zA === (await knoepfeReiter(admin)) && dash2 === zB,
    `Zähler am Reiter: zweite Person ${zB} (= Bestätigen-Knöpfe = Dashboard ${dash2}), Antragsteller ${zA}`);
  ok(antrag?.darf_bestaetigen === false, `Antragsteller darf nicht bestätigen (${antrag?.hinderungsgrund})`);
  const selbst = await post(admin, "/api/hr/lohn-antraege", { id: antrag.id, aktion: "bestaetigen" });
  ok(selbst.status === 400, `eigener Antrag bestätigen → ${selbst.status}`);
  const fremd = (await admin2.api("/api/hr/lohn-antraege")).json?.offen?.find((a) => a.id === antrag.id);
  ok(fremd?.darf_bestaetigen === true, "zweite Person (Admin Zwei, vertrautes Gerät) darf bestätigen");
  const best = await post(admin2, "/api/hr/lohn-antraege", { id: antrag.id, aktion: "bestaetigen" });
  ok(best.status === 200 && sql(`select hourly_wage_chf from employee_compensation where id = '${zeile15}'`) === "28.50", `bestätigt → Lohn 28.50, ${best.json?.vorschlaege} Korrektur-Vorschlag/Vorschläge`);
  const prot = sql(`select quelle || '|' || coalesce(akteur_name,'') || '|' || (alt->>'hourly_wage_chf') || '|' || (neu->>'hourly_wage_chf') from lohn_aenderungen where datensatz_id = '${zeile15}' order by occurred_at desc limit 1`);
  ok(prot.startsWith("antrag|Test Admin Zwei|28.00|28.50") || prot.startsWith("antrag|Test Admin Zwei|28|28.5"), `Protokoll alt/neu/wer: ${prot}`);
  const vors = sql(`select count(*) from lohn_korrektur_vorschlaege where profile_id = '${ID.lara}' and jahr = 2026 and monat = 9 and status = 'offen'`);
  ok(vors === "1", "Korrektur-Vorschlag für Lara 09/2026 (abweichender Monat)");
  const nach = await post(admin, "/api/hr/lohn-korrekturen", { aktion: "nachrechnen", jahr: 2026 });
  ok(nach.status === 200 && nach.json.vorschlaege >= 5 && (nach.json.fehler ?? []).length === 0, `Jahr 2026 nachrechnen: ${nach.json?.vorschlaege} Vorschläge (Altbestand ≠ Kern), ${(nach.json?.fehler ?? []).length} Fehler`);
  const vListe = (await admin.api("/api/hr/lohn-korrekturen?jahr=2026")).json?.vorschlaege ?? [];
  const vLara = vListe.find((v) => v.profile_id === ID.lara && v.monat === 9 && v.status === "offen");
  const erst = await post(admin, "/api/hr/lohn-korrekturen", { aktion: "erstellen", id: vLara.id, begruendung: "Test: Korrektur nach bestätigtem Antrag" });
  ok(erst.status === 200 && erst.json?.fassung === 3 && sql(`select status from lohn_korrektur_vorschlaege where id = '${vLara.id}'`) === "erledigt", `Vorschlag → Korrekturfassung ${erst.json?.fassung}, Auszahlung ${erst.json?.auszahlung} am ${erst.json?.auszahlungsdatum}`);
  // Anstellung: Erfassen in abgerechneten Monaten = Antrag
  const anstOhne = await post(admin, "/api/hr/anstellungen", { profile_id: ID.elias, eintritt: "2026-03-09", vertragsart: "abruf_unecht" });
  ok(anstOhne.status === 409 && anstOhne.json?.code === "begruendung_noetig", `Anstellung ab 09.03. erfassen → ${anstOhne.status} (Begründung nötig)`);
  const anstMit = await post(admin, "/api/hr/anstellungen", { profile_id: ID.elias, eintritt: "2026-03-09", vertragsart: "abruf_unecht", ahv_verlangt_jahre: [2026], begruendung: "Test: Anstellung nachträglich erfassen" });
  const anstAntrag = (await admin2.api("/api/hr/lohn-antraege")).json?.offen?.find((a) => a.bereich === "anstellung");
  const anstBest = await post(admin2, "/api/hr/lohn-antraege", { id: anstAntrag?.id, aktion: "bestaetigen" });
  ok(anstMit.json?.mode === "antrag" && anstBest.status === 200 && sql(`select count(*) from lohn_anstellungen where profile_id = '${ID.elias}'`) === "1", "Anstellung per Antrag erfasst (zweite Person bestätigt)");
  const zukunft = await post(admin, "/api/hr/anstellungen", { profile_id: ID.admin2, eintritt: "2026-12-01", vertragsart: "fest", pensum_pct: 40 });
  ok(zukunft.status === 200 && zukunft.json?.mode === "angelegt", `Anstellung ab Dezember (offen) direkt → ${zukunft.json?.mode}`);
  const selbstAnst = await post(admin, "/api/hr/anstellungen", { profile_id: ID.admin, eintritt: "2026-12-01", vertragsart: "fest" });
  ok(selbstAnst.status === 403, `eigene Anstellung → ${selbstAnst.status} (Vier Augen)`);
  // Firmensätze
  const fsId = sql(`select id from payroll_defaults where effective_from = '2026-03-09'`);
  const fsPatch = await admin.api("/api/hr/lohn-defaults", { method: "PATCH", body: JSON.stringify({ id: fsId, default_nbu_pct: 1.5 }) });
  ok(fsPatch.status === 409 && fsPatch.json?.code === "begruendung_noetig", `Firmensätze 2026 ändern → ${fsPatch.status} (Antrag nötig)`);
  const abl = await post(admin2, "/api/hr/lohn-antraege", { id: (await (async () => {
    await admin.api("/api/hr/lohn-defaults", { method: "PATCH", body: JSON.stringify({ id: fsId, default_nbu_pct: 1.5, begruendung: "Test: wird abgelehnt" }) });
    return (await admin2.api("/api/hr/lohn-antraege")).json?.offen?.find((a) => a.bereich === "firmensaetze")?.id;
  })()), aktion: "ablehnen", grund: "Test" });
  ok(abl.status === 200 && Number(sql(`select default_nbu_pct from payroll_defaults where id = '${fsId}'`)) === 1.45, "Firmensätze-Antrag abgelehnt → unverändert 1.45 %");
  ok(Number(sql(`select count(*) from lohn_aenderungen where quelle = 'antrag'`)) >= 2 && sqlFehler(`delete from lohn_aenderungen`) !== null, "Protokoll: Anträge vermerkt, nicht löschbar");

  // -------------------------------------------------------------------------
  titel("F  Jahresliste");
  const jl = (await admin.api("/api/hr/jahresliste?jahr=2026&basis=auszahlung")).json;
  const lara9z = (jl?.zeilen ?? []).filter((z) => z.profile_id === ID.lara && z.arbeitsjahr === 2026 && z.monat === 9);
  const letzte = sql(`select ahv_lohn from lohn_momentaufnahmen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 9 order by fassung desc limit 1`);
  ok(lara9z.length === 1 && gleich(lara9z[0].ahv_lohn, Number(letzte)) && lara9z[0].auszahlungsdaten.length >= 2, `Lara 09: eine Zeile, AHV-Lohn der letzten Fassung (${lara9z[0]?.ahv_lohn}), Auszahlungen ${lara9z[0]?.auszahlungsdaten.join(", ")}`);
  const jonas = (jl?.summen ?? []).find((s) => s.profile_id === ID.jonas);
  ok(jonas && gleich(jonas.ahv_beitragsfrei, jonas.ahv_lohn), `2'500-Grenze: Jonas beitragsfrei ${jonas?.ahv_beitragsfrei} = AHV-Lohn ${jonas?.ahv_lohn}`);
  const xlsJ = await admin.api("/api/hr/jahresliste?jahr=2026&basis=auszahlung&format=xlsx");
  ok(xlsJ.status === 200 && xlsJ.buf.length > 1000, `Jahresliste Excel → ${xlsJ.status}, ${xlsJ.buf.length} Bytes`);

  // -------------------------------------------------------------------------
  titel("G  Seitenweises Laden (keine 1000-Zeilen-Grenze)");
  // Admin Zwei hat keine eigenen Stempel: 1200 einzelne Minuten = 1200 min.
  sql(`insert into time_entries (user_id, clock_in, clock_out, description)
       select '${ID.admin2}', t, t + interval '1 minute', 'Test Seiten'
       from generate_series('2026-11-02 08:00'::timestamp at time zone 'Europe/Zurich', '2026-11-02 08:00'::timestamp at time zone 'Europe/Zurich' + interval '1199 minutes' * 2, interval '2 minutes') t`);
  const nov = (await admin.api("/api/hr/monthly-stats?month=2026-11")).json?.employees?.find((e) => e.profile_id === ID.admin2);
  const soll = Number(sql(`select count(*) from time_entries where user_id = '${ID.admin2}' and description = 'Test Seiten'`));
  ok(nov?.stempel_minutes === soll && soll === 1200, `1200 Stempel im November: Monatstabelle ${nov?.stempel_minutes} min = ${soll} Stempel à 1 min`);
  sql(`delete from time_entries where description = 'Test Seiten'`);
} catch (e) {
  console.error(e);
  fehler++;
} finally {
  for (const s of sitzungen) await s.auth.signOut({ scope: "local" }).catch(() => {});
}
console.log(fehler === 0 ? "\nALLES OK — Sitzungen nur lokal abgemeldet." : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
