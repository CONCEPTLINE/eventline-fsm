#!/usr/bin/env node
// Prüftor Schnittstelle Trust flow (A1 Stunden-Abruf, A5 Lohnabrechnung aus Bexio, A6 Stammdaten) — NUR LOKAL
// (Docker-Supabase + Dev-Server :3100). Ändert nur die lokale Test-DB und .env.local.
//
//   Schlüssel: erzeugt einmalig ein Ed25519-TESTschlüsselpaar in supabase/lokal/ausgabe/
//   (nicht eingecheckt) und trägt den öffentlichen Teil als FLOW_ABRUF_PUBLIC_KEY in
//   .env.local ein (der Dev-Server lädt .env.local bei Änderung neu). Der echte Schlüssel
//   von Trust flow gehört nur nach Vercel (Live-Gang), nie hierher.
//
//   F1 Ausweis: fremder Schlüssel, abgelaufen, falscher aud, kaputt → 401, nichts protokolliert
//   F2 Stempel September (gesperrt): interne Profile aus profile (auch ohne Anstellung/ausgetreten), keine Namen/IDs, gleiche Stempel wie der Kern
//   F3 Stempel Dezember: Probleme (offen, überlappend, lang ungeprüft), nachträglich geändert
//   F4 Einmal-Schutz (jti) und Protokoll (sha256 der Antwort)
//   F5 Personen (aktive + inaktive mit laufender Anstellung, Feld aktiv)  F6 Vergleich (nur ≤ 2026-11)
//   F11 Stammdaten (A6): Antwortform, Standard vs. individuelle Sätze, festes Ferien-%, keine verbotenen Felder, Partner/unbekannt
//       fallen weg, Protokoll ohne Monat, jti doppelt, abgelaufen, falscher aud, > 50 Profile
//   F7 Wartung «lohn» → 503 (auch A6)  F8 Höchstzahl 10/Min. → 429 (A6 zählt zur Gruppe «Abruf»)
//   F9 Lohnabrechnung aus Bexio: Ablage, Fassungen, nie überschreiben, Meldung, «Meine Lohndokumente»,
//      Statusspalte «über Trust flow», Lohnlauf (Probe) erzeugt für Dezember nichts
//   F10 ohne FLOW_ABRUF_PUBLIC_KEY → 503 auf allen Routen (auch /stammdaten)
//
// Aufruf: node supabase/lokal/pruefen-flow.mjs   (~2–3 min: wartet auf das Minuten-Fenster)
// Meldet sich nur LOKAL ab (signOut({ scope: "local" })).

import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, createPrivateKey, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const APP = "http://localhost:3100";
const DB = "supabase_db_eventline-fsm-lohn";
const ENV_DATEI = path.join(root, ".env.local");
const leseEnv = () => Object.fromEntries(fs.readFileSync(ENV_DATEI, "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const env = leseEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(URL_ ?? "")) {
  console.error(`ABBRUCH: .env.local zeigt nicht auf das lokale Supabase (${URL_}).`);
  process.exit(1);
}

const P = (n) => `a0000000-0000-4000-8000-0000000000${n}`;
const ID = { admin: P("01"), lena: P("11"), noah: P("12"), mia: P("13"), elias: P("14"), sara: P("15"), jonas: P("16"), lara: P("17"), luca: P("18"), ben: P("19") };
const PW = "LohnTest-2026!";
const SUB = "0f0e0d0c-0b0a-4908-8706-050403020100"; // erfundene Trust-flow-Profil-ID
const TEST = "FLOW-TEST";
const service = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fehler = 0;
let anzahl = 0;
const ok = (b, msg) => { anzahl++; console.log(`${b ? "OK    " : "FEHLER"} ${msg}`); if (!b) fehler++; return b; };
const titel = (t) => console.log(`\n== ${t}`);
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const pad = (n) => String(n).padStart(2, "0");

// --- Stempel-Bereich wie der Kern (src/lib/lohn/kern/auszahlung.ts) — weicht er ab, meldet die Route «bereich_abweichend».
const plusTage = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
function stempelBereich(jahr, monat) {
  const s = jahr * 12 + (monat - 1) - 11;
  const vonNbu = plusTage(`${Math.floor(s / 12)}-${pad((s % 12) + 1)}-01`, -7);
  const vonJahr = monat === 1 ? `${jahr - 1}-01-01` : `${jahr}-01-01`;
  const von = vonNbu < vonJahr ? vonNbu : vonJahr;
  return { von: plusTage(von, -1), bis: plusTage(new Date(Date.UTC(jahr, monat, 0)).toISOString().slice(0, 10), 1) };
}

// --- Testschlüssel (nie einchecken: ausgabe/ ist in .gitignore)
const SCHLUESSEL_DATEI = path.join(here, "ausgabe", "flow-testschluessel.json");
function testSchluessel() {
  if (fs.existsSync(SCHLUESSEL_DATEI)) {
    const j = JSON.parse(fs.readFileSync(SCHLUESSEL_DATEI, "utf8"));
    return { privat: createPrivateKey(j.privat_pem), oeffentlich: j.oeffentlich_b64 };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(SCHLUESSEL_DATEI), { recursive: true });
  const j = { hinweis: "NUR LOKALER TEST — nicht einchecken, nie nach Vercel", privat_pem: privateKey.export({ format: "pem", type: "pkcs8" }), oeffentlich_b64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  fs.writeFileSync(SCHLUESSEL_DATEI, JSON.stringify(j, null, 2));
  return { privat: privateKey, oeffentlich: j.oeffentlich_b64 };
}
const KEY = testSchluessel();
const FREMD = generateKeyPairSync("ed25519").privateKey;

/** FLOW_ABRUF_PUBLIC_KEY in .env.local setzen (wert) oder entfernen (null); übrige Zeilen bleiben unverändert. */
function setzeEnv(wert) {
  const roh = fs.readFileSync(ENV_DATEI, "utf8");
  const nl = roh.includes("\r\n") ? "\r\n" : "\n";
  const zeilen = roh.split(/\r?\n/).filter((l) => !l.startsWith("FLOW_ABRUF_PUBLIC_KEY="));
  while (zeilen.length && zeilen[zeilen.length - 1] === "") zeilen.pop();
  if (wert) zeilen.push(`FLOW_ABRUF_PUBLIC_KEY=${wert}`);
  fs.writeFileSync(ENV_DATEI, zeilen.join(nl) + nl);
}
/** Warten, bis der Dev-Server den Schlüssel geladen (401 auf Unsinn) bzw. entfernt hat (503). */
async function warteAufServer(erwartet) {
  for (let i = 0; i < 80; i++) {
    const r = await fetch(`${APP}/api/flow/personen`, { method: "POST", headers: { "content-type": "application/jose" }, body: "a.b.c" }).catch(() => null);
    if (r?.status === erwartet) return true;
    await schlafe(500);
  }
  return false;
}

// --- Ausweise und Aufrufe
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function ausweis(aud, extra = {}, { privat = KEY.privat, iat = Math.floor(Date.now() / 1000) } = {}) {
  const c = { iss: "https://flow.trust-group.ch", aud, sub: SUB, jti: randomUUID(), iat, exp: iat + 60, firma: "eventline", aal: "aal2", geraet: true, ...extra };
  const kopf = b64({ alg: "EdDSA", typ: "JWT" });
  const inhalt = b64(c);
  return { token: `${kopf}.${inhalt}.${sign(null, Buffer.from(`${kopf}.${inhalt}`), privat).toString("base64url")}`, jti: c.jti };
}
const monatsClaims = (jahr, monat, profile, extra = {}) => ({ jahr, monat, ...stempelBereich(jahr, monat), profile, ...extra });
async function flow(route, body, contentType = "application/jose") {
  const res = await fetch(`${APP}/api/flow/${route}`, { method: "POST", headers: { "content-type": contentType }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const zeileVon = (jti) => sql(`select status || '|' || coalesce(geliefert::text, '') || '|' || coalesce(antwort_sha256, '') || '|' || coalesce(grund, '') from flow_abrufe where jti = '${jti}' and status not in ('wiederholt','zu_viele')`);
const imFenster = (gruppe = "abruf") => Number(sql(`select count(*) from flow_abrufe where gruppe = '${gruppe}' and status not in ('wiederholt','zu_viele') and empfangen_at > now() - interval '60 seconds'`));
/** Wartet, bis n Abrufe ins Minuten-Fenster passen (Höchstzahl 10). */
async function platz(n) {
  let gemeldet = false;
  while (imFenster() + n > 10) {
    if (!gemeldet) { console.log(`       … warte auf das Minuten-Fenster (${imFenster()} von 10 belegt)`); gemeldet = true; }
    await schlafe(3000);
  }
}

// --- Anmeldung (wie pruefen-phase4: Cookies + vertrautes Gerät)
const sitzungen = [];
async function login(email, geraet = null) {
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
  return async (pfad, init = {}) => {
    const res = await fetch(`${APP}${pfad}`, { ...init, redirect: "manual", headers: { cookie: cookie(), ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
    let json = null;
    try { json = await res.json(); } catch { /* leer */ }
    return { status: res.status, json };
  };
}

/** Kleine, gültige PDF (eigener Text je Fassung → eigene Prüfsumme). */
function testPdf(text) {
  const objekte = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const strom = `BT /F1 14 Tf 72 770 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  objekte[3] = `<< /Length ${Buffer.byteLength(strom)} >>\nstream\n${strom}\nendstream`;
  let out = "%PDF-1.4\n";
  const off = [];
  objekte.forEach((o, i) => { off.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function ablageKoerper(pdf, claims, opts = {}) {
  const a = ausweis("erp-lohnabrechnung-ablage", { sha256: sha256(pdf), ...claims }, opts);
  return { body: JSON.stringify({ ausweis: a.token, pdf_base64: pdf.toString("base64") }), jti: a.jti };
}
const ablage = (pdf, claims, opts) => flow("lohnabrechnung", ablageKoerper(pdf, claims, opts).body, "application/json");
const speicherObjekte = (pid, monat) => Number(sql(`select count(*) from storage.objects where bucket_id = 'lohndokumente' and name like '${pid}/2026/${monat}/%'`));

const zeit = (tag, hhmm) => `'${tag} ${hhmm}:00 Europe/Zurich'::timestamptz`;
const aufraeumen = () => sql(`select set_config('lohn.notweg','an',true); delete from time_entries where description = '${TEST}';`);

let laufBisVorher = null;
let wartungVorher = null;
let jonasDeaktiviert = false;
let miaAlsPartner = false;
try {
  titel("F0 Vorbereitung");
  ok(sql("select to_regclass('public.flow_abrufe') is not null and to_regprocedure('public.lohn_bexio_fassung_speichern(uuid,integer,integer,integer,text,text,bigint,uuid,uuid)') is not null") === "t", "Migration 369 eingespielt (flow_abrufe, lohn_bexio_fassung_speichern)");
  ok(sql("select pg_get_constraintdef(oid) like '%flow-stammdaten%' from pg_constraint where conname = 'flow_abrufe_aud_check'") === "t"
    && sql("select prosrc like '%flow-stammdaten%' from pg_proc where proname = 'flow_abruf_beginnen'") === "t", "Migration 370 eingespielt (aud flow-stammdaten)");
  if (leseEnv().FLOW_ABRUF_PUBLIC_KEY !== KEY.oeffentlich) setzeEnv(KEY.oeffentlich);
  ok(await warteAufServer(401), "Dev-Server kennt den Testschlüssel (Unsinn → 401)");
  laufBisVorher = sql("select lauf_bis from lohn_einstellungen where id = 'default'");
  wartungVorher = sql("select coalesce(array_to_string(bereiche, ','), '') from wartung where id = 'default'");
  ok(laufBisVorher === "2026-11-01", `lauf_bis = ${laufBisVorher} (ERP rechnet bis November 2026)`);
  aufraeumen();
  // Lara hat ab Dezember keine Stempel: dort Prüffälle anlegen (Dezember ist noch nicht gesperrt).
  const s1 = sql(`insert into time_entries (user_id, clock_in, clock_out, description) values ('${ID.lara}', ${zeit("2026-12-05", "08:00")}, ${zeit("2026-12-05", "12:00")}, '${TEST}') returning id`);
  sql(`insert into time_entries (user_id, clock_in, clock_out, ueberlappung_altfall, description) values ('${ID.lara}', ${zeit("2026-12-05", "11:00")}, ${zeit("2026-12-05", "14:00")}, true, '${TEST}')`);
  sql(`insert into time_entries (user_id, clock_in, clock_out, lang_begruendung, description) values ('${ID.lara}', ${zeit("2026-12-10", "06:00")}, ${zeit("2026-12-10", "23:30")}, 'Aufbau und Anlass (Prüfung Flow)', '${TEST}')`);
  sql(`insert into time_entries (user_id, clock_in, description) values ('${ID.lara}', ${zeit("2026-12-20", "09:00")}, '${TEST}')`);
  // «nach der Sperre» geändert (Notweg schreibt das Protokoll wie ein bestätigter Antrag)
  sql(`select set_config('lohn.notweg','an',true); select set_config('lohn.grund','Prüfung Flow: nachträglich',true); update time_entries set clock_out = clock_out + interval '15 minutes' where id = '${s1.match(/[0-9a-f-]{36}/)[0]}'`);
  ok(true, "Prüf-Stempel Lara Dezember angelegt (offen, lang, Altfall-Überlappung, nachträglich geändert)");

  titel("F1 Ausweis ungültig → 401, nichts protokolliert");
  const vorher = Number(sql("select count(*) from flow_abrufe"));
  const sept = monatsClaims(2026, 9, [ID.lara]);
  for (const [was, a] of [
    ["fremder Schlüssel", ausweis("erp-stempel", sept, { privat: FREMD })],
    ["abgelaufen", ausweis("erp-stempel", sept, { iat: Math.floor(Date.now() / 1000) - 120 })],
    ["falscher aud (erp-vergleich)", ausweis("erp-vergleich", sept)],
  ]) {
    const r = await flow("stempel", a.token);
    ok(r.status === 401 && r.json?.code === "ausweis_ungueltig" && !/signatur|aud|exp/i.test(r.text), `${was} → ${r.status} ${r.json?.code}`);
  }
  ok((await flow("stempel", "kein-jws")).status === 401, "kein JWS → 401");
  ok(Number(sql("select count(*) from flow_abrufe")) === vorher, "keine Zeile in flow_abrufe (ungeprüfte Daten kommen nie in die DB)");

  titel("F2 Stempel September 2026 (gesperrt)");
  await platz(2);
  const unbekannt = randomUUID();
  const anfrage = [ID.lara, ID.noah, ID.elias, unbekannt, ID.ben];
  const a2 = ausweis("erp-stempel", monatsClaims(2026, 9, anfrage));
  const r2 = await flow("stempel", a2.token);
  const ids2 = (r2.json?.personen ?? []).map((p) => p.erp_profil_id);
  ok(r2.status === 200 && r2.json?.monat_gesperrt === true, `→ ${r2.status}, monat_gesperrt ${r2.json?.monat_gesperrt}`);
  ok(JSON.stringify(ids2) === JSON.stringify([ID.lara, ID.noah, ID.elias, ID.ben]),
    "jedes interne Profil aus profile, unabhängig von Anstellung und «aktiv» (Elias ohne ERP-Anstellung, Ben ausgetreten); unbekannte ID fällt weg");
  ok(Object.keys(r2.json ?? {}).sort().join(",") === "monat_gesperrt,nachtraeglich_geaendert,personen", "Antwort hat genau die Felder der Spezifikation");
  const felder = new Set((r2.json?.personen ?? []).flatMap((p) => [Object.keys(p).join(","), ...p.stempel.map((s) => Object.keys(s).join(",")), Object.keys(p.probleme).sort().join(",")]));
  ok([...felder].sort().join(" | ") === "erp_profil_id,stempel,probleme | lang_ungeprueft,offen,ueberlappend | start,ende", `je Person nur ID, Stempel {start, ende}, Probleme (${[...felder].join(" | ")})`);
  const stempelIds = sql(`select string_agg(id::text, ',') from (select id from time_entries where user_id in ('${ID.lara}','${ID.noah}') limit 50) x`).split(",");
  const namen = sql(`select string_agg(full_name, '|') from profiles where id in ('${ID.lara}','${ID.noah}','${ID.ben}')`).split("|");
  ok(!stempelIds.some((id) => r2.text.includes(id)) && !namen.some((n) => n && r2.text.includes(n.split(" ")[1])), "keine Stempel-IDs, keine Namen in der Antwort");
  const bS = stempelBereich(2026, 9);
  const utcVor = `${plusTage(bS.von, -1)}T00:00:00Z`;
  const utcNach = `${plusTage(bS.bis, 2)}T00:00:00Z`;
  for (const [wer, pid] of [["Lara", ID.lara], ["Noah", ID.noah], ["Ben (ausgetreten)", ID.ben]]) {
    const db = Number(sql(`select count(*) from time_entries where user_id = '${pid}' and clock_in >= '${utcVor}' and clock_in < '${utcNach}'`));
    const p = r2.json?.personen?.find((x) => x.erp_profil_id === pid);
    ok(p?.stempel.length === db && db > 0, `${wer}: ${p?.stempel.length} Stempel = Kern-Eingabe des ERP (${db})`);
  }
  const noah9 = r2.json?.personen?.find((x) => x.erp_profil_id === ID.noah);
  ok(noah9?.probleme.ueberlappend === 0, `Noah 11.09.: Überlappung ist markierter Altfall → ueberlappend ${noah9?.probleme.ueberlappend}`);
  ok(r2.json?.personen?.every((p) => p.stempel.every((s, i, l) => i === 0 || new Date(l[i - 1].start) <= new Date(s.start))), "Stempel nach Beginn sortiert");

  titel("F3 Stempel Dezember 2026 (offen) — Probleme und nachträglich geändert");
  const a3 = ausweis("erp-stempel", monatsClaims(2026, 12, [ID.lara, ID.jonas]));
  const r3 = await flow("stempel", a3.token);
  const lara12 = r3.json?.personen?.find((p) => p.erp_profil_id === ID.lara);
  ok(r3.status === 200 && r3.json?.monat_gesperrt === false, `→ ${r3.status}, monat_gesperrt ${r3.json?.monat_gesperrt}`);
  ok(JSON.stringify(lara12?.probleme) === JSON.stringify({ offen: 1, ueberlappend: 2, lang_ungeprueft: 1 }), `Lara Probleme ${JSON.stringify(lara12?.probleme)} (erwartet offen 1, überlappend 2, lang ungeprüft 1)`);
  ok(lara12?.stempel.some((s) => s.ende === null), "offener Stempel mit ende = null geliefert");
  const nachtr = r3.json?.nachtraeglich_geaendert ?? [];
  ok(nachtr.some((n) => n.erp_profil_id === ID.lara && n.monat === "2026-12" && !Number.isNaN(Date.parse(n.geaendert_at))), `nachträglich geändert: ${JSON.stringify(nachtr.filter((n) => n.erp_profil_id === ID.lara))}`);
  const rB = await flow("stempel", ausweis("erp-stempel", monatsClaims(2026, 12, [ID.lara], { bis: "2027-01-02" })).token);
  ok(rB.status === 400 && rB.json?.code === "bereich_abweichend", `von/bis ≠ Stempel-Bereich des Kerns → ${rB.status} ${rB.json?.code}`);
  const rP = await flow("stempel", ausweis("erp-stempel", monatsClaims(2026, 12, Array.from({ length: 51 }, () => randomUUID()))).token);
  ok(rP.status === 400 && rP.json?.code === "profile_zu_viele", `51 Profil-IDs → ${rP.status} ${rP.json?.code}`);

  titel("F4 Einmal-Schutz und Protokoll");
  const z2 = zeileVon(a2.jti).split("|");
  ok(z2[0] === "ok" && z2[1] === "4" && z2[2] === sha256(r2.text), `Protokoll: Status ${z2[0]}, ${z2[1]} Personen, sha256 der Antwort ${z2[2] === sha256(r2.text) ? "stimmt" : "FALSCH"}`);
  ok(r2.headers.get("x-antwort-sha256") === z2[2], "Kopfzeile X-Antwort-Sha256 = Protokoll");
  ok(sql(`select sub || '|' || jahr || '|' || monat || '|' || angefragt from flow_abrufe where jti = '${a2.jti}' and status = 'ok'`) === `${SUB}|2026|9|5`, "Protokoll: wer (sub), Monat, angefragte IDs");
  const r4 = await flow("stempel", a2.token);
  ok(r4.status === 409 && r4.json?.code === "ausweis_verwendet" && !r4.text.includes(ID.lara), `gleicher Ausweis nochmals → ${r4.status} ${r4.json?.code}, keine Daten`);
  ok(sql(`select count(*) from flow_abrufe where jti = '${a2.jti}' and status = 'wiederholt'`) === "1", "Wiederholung protokolliert");
  ok(sql("select count(*) from flow_abrufe where grund = 'bereich_abweichend' and status = 'abgelehnt'") !== "0", "abgelehnte Claims protokolliert («abgelehnt», Grund)");
  const loeschen = (() => { try { sql("delete from flow_abrufe where id = (select id from flow_abrufe limit 1)"); return "gelöscht"; } catch (e) { return String(e.stderr ?? e.message); } })();
  ok(/Löschen ist gesperrt/.test(loeschen), "Protokoll ist nicht löschbar");

  titel("F5 Personen");
  await platz(1);
  // Jonas vorübergehend deaktivieren: Anstellung ohne Austritt → bleibt in der Liste (aktiv: false).
  sql(`update profiles set is_active = false where id = '${ID.jonas}' and is_active`);
  jonasDeaktiviert = true;
  const r5 = await flow("personen", ausweis("erp-personen").token);
  sql(`update profiles set is_active = true where id = '${ID.jonas}'`);
  jonasDeaktiviert = false;
  const pers = r5.json?.personen ?? [];
  ok(r5.status === 200 && pers.some((p) => p.erp_profil_id === ID.lara && p.name === "Lara Steiner" && p.aktiv === true), `→ ${r5.status}, ${pers.length} Mitarbeitende, Lara mit Name, aktiv`);
  ok(pers.some((p) => p.erp_profil_id === ID.jonas && p.aktiv === false), "Jonas (inaktiv, Anstellung ohne Austritt) mit aktiv: false");
  ok(!pers.some((p) => p.erp_profil_id === ID.ben), "Ben (inaktiv, Austritt 30.06.2026 vor Dezember) fehlt");
  ok(pers.every((p) => Object.keys(p).join(",") === "erp_profil_id,name,aktiv"), "nur ID, Name, aktiv (bisherige Felder unverändert vorne)");
  ok(pers.every((p, i, l) => i === 0 || l[i - 1].name.localeCompare(p.name, "de-CH") <= 0), "nach Name sortiert (wie bisher)");
  const portal = sql("select count(*) from profiles where is_active and role in (select slug from roles where is_portal)");
  ok(!pers.some((p) => sql(`select coalesce((select is_portal from roles where slug = (select role from profiles where id = '${p.erp_profil_id}')), false)`) === "t"), `keine Portal-Zugänge (aktiv im Portal: ${portal})`);

  titel("F6 Vergleich (nur ≤ 2026-11)");
  let ma = sql("select profile_id || '|' || jahr || '|' || monat from lohn_fassungen_gueltig where make_date(jahr, monat, 1) <= '2026-11-01' order by jahr desc, monat desc limit 1");
  if (!ma) {
    const admin = await login("lohn-admin@example.com", "lokal-testgeraet-admin");
    const g = await admin("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.lara, year: 2026, month: 9 }) });
    ok(g.status === 200, `Momentaufnahme Lara 09/2026 erzeugt (${g.status})`);
    ma = sql("select profile_id || '|' || jahr || '|' || monat from lohn_fassungen_gueltig where make_date(jahr, monat, 1) <= '2026-11-01' order by jahr desc, monat desc limit 1");
  }
  const [maPid, maJ, maM] = ma.split("|");
  await platz(2);
  const r6 = await flow("vergleich", ausweis("erp-vergleich", { jahr: Number(maJ), monat: Number(maM), profile: [maPid, ID.elias] }).token);
  const v = r6.json?.personen?.find((p) => p.erp_profil_id === maPid)?.momentaufnahme;
  const dbM = sql(`select fassung || '|' || brutto || '|' || ahv_lohn || '|' || uvg_art || '|' || pruefsumme from lohn_fassungen_gueltig where profile_id = '${maPid}' and jahr = ${maJ} and monat = ${maM}`).split("|");
  ok(r6.status === 200 && r6.json?.monat === `${maJ}-${pad(maM)}`, `→ ${r6.status} ${r6.json?.monat}`);
  ok(v && v.fassung === Number(dbM[0]) && Math.abs(v.brutto - Number(dbM[1])) < 0.005 && Math.abs(v.ahv_lohn - Number(dbM[2])) < 0.005 && v.uvg_art === dbM[3] && v.pruefsumme === dbM[4],
    `Momentaufnahme wie in der DB (Fassung ${v?.fassung}, Brutto ${v?.brutto}, AHV-Lohn ${v?.ahv_lohn})`);
  ok(Array.isArray(v?.positionen) && v.positionen.length > 0 && v.positionen.every((p) => Object.keys(p).join(",") === "lohnart,minuten,betrag") && v.bisher && "versichert" in (v.nbu ?? {}), `Positionen nur Lohnart/Minuten/Betrag (${v?.positionen?.length}), NBU, bisher`);
  ok(!r6.json?.personen?.some((p) => p.erp_profil_id === ID.elias), "Elias (keine Anstellung) fehlt");
  const r6b = await flow("vergleich", ausweis("erp-vergleich", { jahr: 2026, monat: 12, profile: [ID.lara] }).token);
  ok(r6b.status === 422 && r6b.json?.code === "monat_nicht_erlaubt", `Dezember 2026 → ${r6b.status} ${r6b.json?.code}`);

  titel("F11 Stammdaten (A6)");
  await platz(4);
  sql(`update profiles set role = 'partner' where id = '${ID.mia}' and role = 'techniker'`);
  miaAlsPartner = true;
  const unbek11 = randomUUID();
  // jahr/monat werden ignoriert (auch ungültige) — sie gehören nicht zu A6.
  const a11 = ausweis("flow-stammdaten", { profile: [ID.luca, ID.lena, ID.mia, ID.ben, unbek11, ID.elias], jahr: 2026, monat: 13 });
  const r11 = await flow("stammdaten", a11.token);
  const stamm = r11.json?.personen ?? [];
  ok(r11.status === 200 && JSON.stringify(stamm.map((p) => p.erp_profil_id)) === JSON.stringify([ID.luca, ID.lena, ID.ben, ID.elias]),
    `→ ${r11.status}: interne Profile in Anfrage-Reihenfolge (auch Ben ausgetreten, Elias ohne Anstellung); Partner (Mia) und unbekannte ID fallen weg`);
  ok(Object.keys(r11.json ?? {}).join(",") === "personen"
    && stamm.every((p) => Object.keys(p).join(",") === "erp_profil_id,name,vorname,geburtsdatum,anstellungen,lohnzeilen"
      && p.anstellungen.every((x) => Object.keys(x).join(",") === "firma,eintritt,austritt,vertragsart")
      && p.lohnzeilen.every((x) => Object.keys(x).join(",") === "gueltig_ab,ansatz,standard,quellensteuer_pct,nbu_pct,bvg_pct,ansatz_art,ferien_pct")),
    "Antwort hat genau die Felder des Vertrags (VERTRAG.md)");
  const verboten = ["ahv", "alv", "ktg", "employer", "notes", "notiz", "iban", "email", "phone", "adresse", "konfession", "pensum", "wage_exempt"];
  ok(!verboten.some((v) => r11.text.toLowerCase().includes(v)), `keine verbotenen Felder (${verboten.join(", ")})`);
  const luca = stamm.find((p) => p.erp_profil_id === ID.luca);
  const lucaDb = sql(`select string_agg(effective_from || '|' || hourly_wage_chf::float8 || '|' || quellensteuer_pct::float8 || '|' || nbu_pct::float8 || '|' || bvg_pct::float8, ';' order by effective_from) from employee_compensation where profile_id = '${ID.luca}'`);
  const lucaApi = (luca?.lohnzeilen ?? []).map((z) => `${z.gueltig_ab}|${z.ansatz}|${z.quellensteuer_pct}|${z.nbu_pct}|${z.bvg_pct}`).join(";");
  ok(luca?.lohnzeilen.every((z) => z.standard === false) && lucaApi === lucaDb, `Luca individuell: Sätze wie in der DB (${lucaApi})`);
  const lena = stamm.find((p) => p.erp_profil_id === ID.lena);
  ok(lena?.lohnzeilen.length === 2 && lena.lohnzeilen.every((z) => z.standard === true && z.quellensteuer_pct === null && z.nbu_pct === null && z.bvg_pct === null)
    && lena.lohnzeilen[0].gueltig_ab < lena.lohnzeilen[1].gueltig_ab, "Lena Standard: Sätze null, Verlauf nach gültig ab sortiert");
  ok(stamm.every((p) => p.lohnzeilen.every((z) => z.ansatz_art === "inkl_ferien")), "ansatz_art überall inkl_ferien (ERP-Ansatz enthält den Ferienzuschlag)");
  // Lena: Zeile ab 01.10.2026 mit fester Übersteuerung 8.33 % (Seed), die frühere nach Alter (null); Luca individuell ohne.
  const lenaFerien = sql(`select string_agg(coalesce(ferienanteil_pct_override::float8::text, 'null'), '|' order by effective_from) from employee_compensation where profile_id = '${ID.lena}'`);
  ok(lena?.lohnzeilen.map((z) => String(z.ferien_pct)).join("|") === lenaFerien && lenaFerien === "null|8.33"
    && luca?.lohnzeilen.every((z) => z.ferien_pct === null), `ferien_pct: Lena ${lenaFerien} (feste Übersteuerung ab 01.10.), Luca null`);
  const lenaDb = sql(`select split_part(full_name, ' ', 1) || '|' || split_part(full_name, ' ', 2) || '|' || birthdate from profiles where id = '${ID.lena}'`);
  ok(`${lena?.vorname}|${lena?.name}|${lena?.geburtsdatum}` === lenaDb, "Vorname, Name, Geburtsdatum wie im ERP");
  const ben = stamm.find((p) => p.erp_profil_id === ID.ben);
  ok(JSON.stringify(ben?.anstellungen) === JSON.stringify([{ firma: "eventline", eintritt: "2026-03-09", austritt: "2026-06-30", vertragsart: "stundenlohn" }]),
    `Ben: Anstellung mit Austritt, abruf_unecht → stundenlohn (${JSON.stringify(ben?.anstellungen)})`);
  ok(stamm.find((p) => p.erp_profil_id === ID.elias)?.anstellungen.length === 0, "Elias: keine ERP-Anstellung → []");
  ok(sql(`select status || '|' || geliefert || '|' || angefragt || '|' || coalesce(jahr::text, 'null') || '|' || coalesce(monat::text, 'null') || '|' || antwort_sha256 from flow_abrufe where jti = '${a11.jti}' and status = 'ok'`)
    === `ok|4|6|null|null|${sha256(r11.text)}` && r11.headers.get("x-antwort-sha256") === sha256(r11.text),
    "Protokoll: ok, 4 von 6 geliefert, ohne Monat, sha256 der Antwort = Kopfzeile");
  ok(sql("select count(*) from flow_abrufe where aud = 'flow-stammdaten' and gruppe = 'abruf'") !== "0", "A6 zählt zur Gruppe «abruf»");
  const r11b = await flow("stammdaten", a11.token);
  ok(r11b.status === 409 && r11b.json?.code === "ausweis_verwendet" && !r11b.text.includes(ID.luca), `gleicher Ausweis nochmals → ${r11b.status} ${r11b.json?.code}`);
  for (const [was, a] of [
    ["abgelaufen", ausweis("flow-stammdaten", { profile: [ID.lena] }, { iat: Math.floor(Date.now() / 1000) - 120 })],
    ["falscher aud (erp-personen)", ausweis("erp-personen", { profile: [ID.lena] })],
    ["fremder Schlüssel", ausweis("flow-stammdaten", { profile: [ID.lena] }, { privat: FREMD })],
  ]) {
    const r = await flow("stammdaten", a.token);
    ok(r.status === 401 && r.json?.code === "ausweis_ungueltig", `${was} → ${r.status} ${r.json?.code}`);
  }
  ok((await flow("personen", ausweis("flow-stammdaten", { profile: [ID.lena] }).token)).status === 401, "Stammdaten-Ausweis an /api/flow/personen → 401");
  const r11c = await flow("stammdaten", ausweis("flow-stammdaten", { profile: Array.from({ length: 51 }, () => randomUUID()) }).token);
  ok(r11c.status === 400 && r11c.json?.code === "profile_zu_viele", `51 Profil-IDs → ${r11c.status} ${r11c.json?.code}`);
  const r11d = await flow("stammdaten", ausweis("flow-stammdaten", { profile: [ID.mia] }).token);
  ok(r11d.status === 200 && JSON.stringify(r11d.json) === JSON.stringify({ personen: [] }), `nur Partner-Zugang → ${r11d.status} ${JSON.stringify(r11d.json)}`);
  sql(`update profiles set role = 'techniker' where id = '${ID.mia}' and role = 'partner'`);
  miaAlsPartner = false;

  titel("F7 Wartung «lohn» → 503 mit Hinweis");
  const lohnWarVorher = wartungVorher.split(",").includes("lohn");
  sql("select public.wartung_setzen(array['lohn'], null, 'Pruefung Flow', null, 'pruefen-flow')");
  await schlafe(11_000); // App-Cache 10 s
  const a7 = ausweis("erp-personen");
  const r7 = await flow("personen", a7.token);
  ok(r7.status === 503 && r7.json?.code === "wartung" && /Umbauten/.test(r7.json?.error ?? ""), `→ ${r7.status} ${r7.json?.code}: ${String(r7.json?.error).slice(0, 60)}…`);
  ok(zeileVon(a7.jti) === "", "Ausweis bleibt unverbraucht (kein Protokoll)");
  const a7s = ausweis("flow-stammdaten", { profile: [ID.lena] });
  const r7s = await flow("stammdaten", a7s.token);
  ok(r7s.status === 503 && r7s.json?.code === "wartung" && zeileVon(a7s.jti) === "", `Stammdaten in der Wartung → ${r7s.status} ${r7s.json?.code}, Ausweis unverbraucht`);
  if (!lohnWarVorher) sql("select public.wartung_setzen(null, array['lohn'], null, null, 'pruefen-flow')");
  await schlafe(11_000);
  ok((await flow("personen", "a.b.c")).status === 401, "Wartung aus → wieder erreichbar");

  titel("F8 Höchstzahl 10 Abrufe je Minute (Personen und Stammdaten zusammen)");
  await platz(10);
  const zehn = [];
  for (let i = 0; i < 10; i++) {
    zehn.push(i < 9
      ? (await flow("personen", ausweis("erp-personen").token)).status
      : (await flow("stammdaten", ausweis("flow-stammdaten", { profile: [ID.lena] }).token)).status);
  }
  const elf = await flow("stammdaten", ausweis("flow-stammdaten", { profile: [ID.lena] }).token);
  ok(zehn.every((s) => s === 200), `9 Personen + 1 Stammdaten → ${zehn.join(",")}`);
  ok(elf.status === 429 && elf.json?.code === "zu_viele" && Number(elf.headers.get("retry-after")) > 0, `11. Abruf (Stammdaten) → ${elf.status}, Retry-After ${elf.headers.get("retry-after")} s`);

  titel("F9 Lohnabrechnung aus Bexio (A5)");
  const basis = Number(sql(`select coalesce(max(fassung), 0) from lohn_bexio_fassungen where profile_id = '${ID.lara}' and jahr = 2026 and monat = 12`));
  if (basis > 90) console.log("       Hinweis: viele Läufe — bash supabase/lokal/aufbauen.sh --nur-seed setzt zurück");
  const f1 = basis + 1;
  const pdf1 = testPdf(`Testabrechnung Dezember 2026 Fassung ${f1} ${Date.now()}`);
  const objVorher = speicherObjekte(ID.lara, "2026-12");
  const r9 = await ablage(pdf1, { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: f1 });
  const docId = r9.json?.dokument_id;
  ok(r9.status === 200 && r9.json?.modus === "abgelegt" && !!docId, `Fassung ${f1} → ${r9.status} ${r9.json?.modus}, ERP-Fassung ${r9.json?.erp_fassung}`);
  const w = sql(`select source || '|' || doc_type || '|' || year || '|' || period_month || '|' || storage_path || '|' || version from wage_documents where id = '${docId}'`).split("|");
  ok(w[0] === "bexio" && w[1] === "lohnabrechnung" && w[2] === "2026" && w[3] === "12", `wage_documents: Quelle ${w[0]}, ${w[1]} ${w[2]}-${w[3]}`);
  const { data: blob } = await service.storage.from("lohndokumente").download(w[4]);
  ok(blob && sha256(Buffer.from(await blob.arrayBuffer())) === sha256(pdf1), "PDF im Bucket lohndokumente, Prüfsumme stimmt");
  ok(sql(`select count(*) from lohn_bexio_fassungen where wage_document_id = '${docId}' and fassung = ${f1} and pdf_sha256 = '${sha256(pdf1)}'`) === "1", "Zuordnung Bexio-Fassung ↔ Lohndokument gespeichert");
  ok(sql(`select aktion || '|' || (details->>'quelle') || '|' || actor_name from lohn_dokument_protokoll where wage_document_id = '${docId}' order by occurred_at desc limit 1`) === "hochgeladen|bexio|Trust flow (Bexio)", "Protokoll: hochgeladen, Quelle bexio, Trust flow");
  ok(sql(`select (bereitgestellt_at is not null)::int || '|' || (benachrichtigt_at is not null)::int from lohn_dokument_zustellung where wage_document_id = '${docId}'`) === "1|1", "Zustellung: bereitgestellt und benachrichtigt");
  const meldung = sql(`select title || ' ' || message from notifications where user_id = '${ID.lara}' and resource_id = '${docId}' order by created_at desc limit 1`);
  ok(/Lohnabrechnung Dezember 2026/.test(meldung) && !/CHF|\d+\.\d{2}/.test(meldung), `Meldung an Lara ohne Beträge: «${meldung.slice(0, 70)}…»`);
  ok(speicherObjekte(ID.lara, "2026-12") === objVorher + 1, "genau eine neue Datei im Speicher");

  const r9b = await ablage(pdf1, { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: f1 });
  ok(r9b.status === 200 && r9b.json?.modus === "vorhanden" && r9b.json?.dokument_id === docId && speicherObjekte(ID.lara, "2026-12") === objVorher + 1,
    `gleiche Fassung + gleiche PDF nochmals (neuer Ausweis) → ${r9b.status} ${r9b.json?.modus}, keine zusätzliche Datei`);
  const r9c = await ablage(testPdf("andere PDF"), { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: f1 });
  ok(r9c.status === 409 && r9c.json?.code === "fassung_abweichend" && speicherObjekte(ID.lara, "2026-12") === objVorher + 1, `gleiche Fassung, andere PDF → ${r9c.status} ${r9c.json?.code}, eigene Datei wieder weg`);

  const f2 = f1 + 1;
  const pdf2 = testPdf(`Testabrechnung Dezember 2026 Fassung ${f2} ${Date.now()}`);
  const r9d = await ablage(pdf2, { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: f2 });
  ok(r9d.status === 200 && r9d.json?.modus === "abgelegt" && r9d.json?.erp_fassung > Number(w[5]), `Fassung ${f2} → ${r9d.status} ${r9d.json?.modus}, ERP-Fassung ${w[5]} → ${r9d.json?.erp_fassung}`);
  const { data: altBlob } = await service.storage.from("lohndokumente").download(w[4]);
  ok(altBlob && sha256(Buffer.from(await altBlob.arrayBuffer())) === sha256(pdf1) && speicherObjekte(ID.lara, "2026-12") === objVorher + 2, "frühere Fassung bleibt unverändert im Speicher (nie überschrieben)");
  const zust = sql(`select z.fassung || '|' || (select count(*) from lohn_dokument_zustellung_verlauf v where v.wage_document_id = z.wage_document_id) from lohn_dokument_zustellung z where wage_document_id = '${r9d.json?.dokument_id}'`);
  ok(/^\d+\|\d+$/.test(zust), `Zustellnachweis gilt für die neue Fassung (${zust})`);

  const nb = Number(sql(`select coalesce(max(fassung), 0) from lohn_bexio_fassungen where profile_id = '${ID.noah}' and jahr = 2027 and monat = 1`));
  const rn1 = await ablage(testPdf(`Noah Januar ${nb + 2} ${Date.now()}`), { erp_profil_id: ID.noah, jahr: 2027, monat: 1, fassung: nb + 2 });
  const rn2 = await ablage(testPdf(`Noah Januar ${nb + 1} ${Date.now()}`), { erp_profil_id: ID.noah, jahr: 2027, monat: 1, fassung: nb + 1 });
  ok(rn1.status === 200 && rn2.status === 409 && rn2.json?.code === "veraltet", `ältere Fassung nach neuerer → ${rn2.status} ${rn2.json?.code}`);

  const rNov = await ablage(testPdf("November"), { erp_profil_id: ID.lara, jahr: 2026, monat: 11, fassung: 1 });
  ok(rNov.status === 422 && rNov.json?.code === "erp_monat", `November 2026 (rechnet das ERP) → ${rNov.status} ${rNov.json?.code}`);
  sql("update lohn_einstellungen set lauf_bis = '2026-12-01' where id = 'default'");
  const rLb = await ablage(testPdf("lauf_bis Dezember"), { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: 99 });
  sql(`update lohn_einstellungen set lauf_bis = '${laufBisVorher}' where id = 'default'`);
  ok(rLb.status === 422 && rLb.json?.code === "erp_monat", `lauf_bis = Dezember → Dezember aus Bexio abgelehnt (${rLb.status} ${rLb.json?.code})`);
  const pdfA = testPdf("A");
  const rSha = await flow("lohnabrechnung", JSON.stringify({ ausweis: ausweis("erp-lohnabrechnung-ablage", { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: 98, sha256: sha256(pdfA) }).token, pdf_base64: testPdf("B").toString("base64") }), "application/json");
  ok(rSha.status === 422 && rSha.json?.code === "sha256_abweichend", `PDF passt nicht zur signierten Prüfsumme → ${rSha.status} ${rSha.json?.code}`);
  const fEl = Number(sql(`select coalesce(max(fassung), 0) from lohn_bexio_fassungen where profile_id = '${ID.elias}' and jahr = 2026 and monat = 12`)) + 1;
  const rEl = await ablage(testPdf(`Elias ${fEl} ${Date.now()}`), { erp_profil_id: ID.elias, jahr: 2026, monat: 12, fassung: fEl });
  ok(rEl.status === 200 && rEl.json?.modus === "abgelegt", `internes Profil ohne ERP-Anstellung (Elias) → ${rEl.status} ${rEl.json?.modus} (Anstellungen führt Trust flow)`);
  const rUnb = await ablage(testPdf("unbekannt"), { erp_profil_id: randomUUID(), jahr: 2026, monat: 12, fassung: 1 });
  ok(rUnb.status === 422 && rUnb.json?.code === "person_unbekannt", `unbekannte ERP-Profil-ID → ${rUnb.status} ${rUnb.json?.code}`);
  const gross = Buffer.concat([testPdf("gross"), Buffer.alloc(2 * 1024 * 1024, 0x20)]);
  const rGr = await ablage(gross, { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: 97 });
  ok(rGr.status === 413 && rGr.json?.code === "zu_gross", `PDF über 2 MB → ${rGr.status} ${rGr.json?.code}`);
  const falscherAud = ablageKoerper(pdf2, { erp_profil_id: ID.lara, jahr: 2026, monat: 12, fassung: f2 });
  const rAud = await flow("stempel", JSON.parse(falscherAud.body).ausweis);
  ok(rAud.status === 401, `Ablage-Ausweis an /api/flow/stempel → ${rAud.status}`);

  const lara = await login("lara.steiner@example.com");
  const meine = await lara("/api/hr/wage-documents");
  const dok = meine.json?.documents?.find((d) => d.id === r9d.json?.dokument_id);
  ok(meine.status === 200 && dok?.source === "bexio" && dok?.year === 2026 && dok?.period_month === 12, `«Meine Lohndokumente» (Lara): Dezember 2026 aus Bexio sichtbar (Fassung ${dok?.version})`);
  const link = await lara(`/api/hr/wage-documents/${r9d.json?.dokument_id}`);
  const pdfGeladen = link.json?.url ? Buffer.from(await (await fetch(link.json.url)).arrayBuffer()) : Buffer.alloc(0);
  ok(link.status === 200 && sha256(pdfGeladen) === sha256(pdf2), `Herunterladen wie bisher → aktuelle Fassung ${f2} (${link.json?.filename})`);

  const admin = await login("lohn-admin@example.com", "lokal-testgeraet-admin");
  const st = await admin("/api/hr/monatsstatus?month=2026-12");
  const zLara = st.json?.zeilen?.find((z) => z.profile_id === ID.lara);
  ok(st.status === 200 && zLara?.status === "trust_flow" && /Bexio/.test(zLara?.text ?? ""), `Statusspalte Dezember: Lara «${zLara?.status}» — ${zLara?.text}`);
  if (env.CRON_SECRET) {
    const probe = await fetch(`${APP}/api/cron/auto-lohnabrechnung?probe=1`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    const pj = await probe.json().catch(() => ({}));
    const dez = JSON.stringify(pj.ergebnisse ?? pj.plan ?? []).includes("2026-12");
    ok(probe.status === 200 && !dez, `Lohnlauf (Probe): nichts für Dezember 2026 geplant, Status ${pj.status ?? probe.status}`);
  } else {
    console.log("       (Lohnlauf-Probe übersprungen: CRON_SECRET fehlt in .env.local)");
  }

  titel("F10 ohne FLOW_ABRUF_PUBLIC_KEY → 503 (nie offen)");
  setzeEnv(null);
  try {
    ok(await warteAufServer(503), "Dev-Server ohne Schlüssel");
    for (const route of ["stempel", "personen", "vergleich"]) {
      const r = await flow(route, ausweis(`erp-${route}`, monatsClaims(2026, 9, [ID.lara])).token);
      ok(r.status === 503 && r.json?.code === "nicht_eingerichtet", `/api/flow/${route} → ${r.status} ${r.json?.code}`);
    }
    const rs = await flow("stammdaten", ausweis("flow-stammdaten", { profile: [ID.lara] }).token);
    ok(rs.status === 503 && rs.json?.code === "nicht_eingerichtet", `/api/flow/stammdaten → ${rs.status} ${rs.json?.code}`);
    const rl = await flow("lohnabrechnung", "kein json", "application/json");
    ok(rl.status === 503 && rl.json?.code === "nicht_eingerichtet", `/api/flow/lohnabrechnung → ${rl.status} ${rl.json?.code}`);
  } finally {
    setzeEnv(KEY.oeffentlich);
  }
  ok(await warteAufServer(401), "Testschlüssel wieder gesetzt");
} catch (e) {
  ok(false, `abgebrochen — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  try { aufraeumen(); } catch (e) { console.log(`Aufräumen der Prüf-Stempel fehlgeschlagen: ${e.message}`); }
  if (jonasDeaktiviert) sql(`update profiles set is_active = true where id = '${ID.jonas}'`);
  if (miaAlsPartner) sql(`update profiles set role = 'techniker' where id = '${ID.mia}' and role = 'partner'`);
  if (laufBisVorher) sql(`update lohn_einstellungen set lauf_bis = '${laufBisVorher}' where id = 'default'`);
  if (wartungVorher !== null && !wartungVorher.split(",").includes("lohn")
      && sql("select coalesce(array_to_string(bereiche, ','), '') from wartung where id = 'default'").split(",").includes("lohn")) {
    sql("select public.wartung_setzen(null, array['lohn'], null, null, 'pruefen-flow')");
  }
  if (leseEnv().FLOW_ABRUF_PUBLIC_KEY !== KEY.oeffentlich) setzeEnv(KEY.oeffentlich);
  for (const s of sitzungen) await s.auth.signOut({ scope: "local" }).catch(() => {});
}
console.log(fehler === 0 ? `\nALLES OK (${anzahl} Prüfungen)` : `\n${fehler} FEHLER von ${anzahl} Prüfungen`);
process.exit(fehler === 0 ? 0 : 1);
