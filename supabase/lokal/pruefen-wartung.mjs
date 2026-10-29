#!/usr/bin/env node
// Prüfung Wartungsmodus (Migration 363) — NUR LOKAL (Docker-Supabase + Dev-Server :3100).
//
//   1  Vorher (aus): Seiten ohne Hinweis, Routen wie gewohnt.
//   2  Einschalten per Skript (scripts/wartung.mjs an … --lokal) für alle vier Bereiche:
//      Seiten zeigen den Hinweis (Mail- und Telefon-Link), Routen antworten 503 mit der
//      Meldung, der Cron pausiert (lohn_lauf «pausiert (Wartung)», keine Abrechnung),
//      die Ausnahme (Admin Zwei) arbeitet normal und sieht den Balken «Wartung aktiv».
//   3  Ausschalten in der App (POST /api/wartung, Admin auf vertrautem Gerät; ohne Gerät 403):
//      alles wie vorher, Rechte-Protokoll hat wartung.an / wartung.aus.
//
// Aufruf: node supabase/lokal/pruefen-wartung.mjs
// Voraussetzungen: Testdaten (bash supabase/lokal/aufbauen.sh), Dev-Server auf 3100,
// CRON_SECRET in .env.local (lokaler Testwert). Die App liest den Stand 10 s gecacht —
// das Skript wartet nach jedem Schalten 11 s. Setzt Wartung und Ausnahmen am Ende zurück,
// meldet sich nur LOKAL ab. Ändert nur die lokale Test-DB.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const APP = "http://localhost:3100";
const DB = "supabase_db_eventline-fsm-lohn";

const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(URL_ ?? "")) {
  console.error(`ABBRUCH: .env.local zeigt nicht auf das lokale Supabase (${URL_}).`);
  process.exit(1);
}
if (!env.CRON_SECRET) {
  console.error("ABBRUCH: CRON_SECRET fehlt in .env.local (lokalen Testwert setzen).");
  process.exit(1);
}

const ID = {
  admin: "a0000000-0000-4000-8000-000000000001",
  admin2: "a0000000-0000-4000-8000-000000000002",
  lara: "a0000000-0000-4000-8000-000000000017",
};
const PW = "LohnTest-2026!";
const MELDUNG =
  "Diese Funktion ist im Moment wegen Umbauten nicht möglich. Bitte Mischa Dittus kontaktieren: mischa@eventline-basel.com · 079 614 93 83";
const ZUFALL_ID = "00000000-0000-4000-8000-00000000abcd";

let fehler = 0;
const ok = (b, msg) => { console.log(`${b ? "OK    " : "FEHLER"} ${msg}`); if (!b) fehler++; return b; };
const titel = (t) => console.log(`\n== ${t}`);
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const skript = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/wartung.mjs"), ...args, "--lokal"], { cwd: root, encoding: "utf8" });
const warteCache = (grund) => { console.log(`   … 11 s warten (Cache der App, ${grund})`); return new Promise((r) => setTimeout(r, 11_000)); };

const sitzungen = [];
async function login(email, geraet) {
  const jar = new Map();
  const supa = createServerClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await supa.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`Login ${email}: ${error.message}`);
  sitzungen.push(supa);
  const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).concat(geraet ? [`eventline_trusted_device=${geraet}`] : []).join("; ");
  const api = async (pfad, init = {}) => {
    const res = await fetch(`${APP}${pfad}`, {
      ...init,
      redirect: "manual",
      headers: { cookie: cookie(), ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, location: res.headers.get("location"), json, text };
  };
  return { api };
}

const cron = (q = "") =>
  fetch(`${APP}/api/cron/auto-lohnabrechnung${q}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// Seiten: Hinweis = Meldungstext + mailto + tel (im HTML bzw. in den mitgeschickten RSC-Daten).
const hatHinweis = (html) => html.includes("wegen Umbauten nicht m") && html.includes("mailto:mischa@eventline-basel.com") && html.includes("tel:+41796149383");
const hatBalken = (html) => html.includes("Wartung aktiv");
// Reiter «Rechte & Lohndaten» auf /antraege (früher eigene Seite /rechte-antraege): die
// Hinweisseite rendert WartungBereichSchranke im Browser — geprüft wird der Wartungs-Kontext
// im RSC-Datenstrom (wie Einstellungen › Mitarbeiter).
const RECHTE_REITER = "/antraege?tab=rechte";
const RECHTE_KONTEXT = {
  frei: /rechte\\?"\s*:\s*\\?"frei/,
  gesperrt: /rechte\\?"\s*:\s*\\?"gesperrt/,
  ausnahme: /rechte\\?"\s*:\s*\\?"ausnahme/,
};
const rechteKontext = (html, zugang) => RECHTE_KONTEXT[zugang].test(html);
// Alte Adresse leitet um (Server-Redirect im Stream: NEXT_REDIRECT, «&» als \u0026;
// oder 307 + Location).
const leitetUm = (r, ziel) =>
  (r.status === 307 && (r.location ?? "").endsWith(ziel)) ||
  r.text.includes(`NEXT_REDIRECT;replace;${ziel.replace(/&/g, "\\u0026")};307`);

const SEITEN = [
  ["/lohn", "lohn"],
  ["/finanzen", "finanzen"],
  [`/geraet-freigabe?id=${ZUFALL_ID}`, "geraete"],
];

// [Methode, Pfad, Body, Bereich] — Admin MIT vertrautem Gerät. Nur lesende bzw. ungültige
// Aufrufe, damit «aus» nichts verändert (POST mit leerem Body → 400 statt Anlegen).
const ROUTEN = [
  ["GET", "/api/hr/compensation", null, "lohn"],
  ["GET", "/api/hr/monthly-stats?month=2026-09", null, "lohn"],
  ["GET", "/api/hr/lohn-lauf", null, "lohn"],
  ["GET", "/api/hr/bvg-prognose?monat=2026-09", null, "lohn"],
  ["GET", `/api/hr/stundensaetze?ids=${ID.lara}`, null, "lohn"],
  ["GET", `/api/hr/wage-documents?profile_id=${ID.lara}`, null, "lohn"],
  ["POST", "/api/hr/wage-documents/generate", {}, "lohn"],
  ["GET", "/api/admin/roles", null, "rechte"],
  ["GET", "/api/admin/rechte-antraege", null, "rechte"],
  ["GET", "/api/admin/rechte-antraege/zaehler", null, "rechte"],
  ["POST", "/api/admin/users", {}, "rechte"],
  ["GET", `/api/admin/users/${ID.lara}/impact`, null, "rechte"],
  ["GET", `/api/trust/freigabe?id=${ZUFALL_ID}`, null, "geraete"],
  ["GET", "/api/finanzen/uebersicht", null, "finanzen"],
];

async function rufe(sess, [methode, pfad, body]) {
  return sess.api(pfad, { method: methode, body: body ? JSON.stringify(body) : undefined });
}

let ausnahmenVorher = "";
try {
  titel("Vorbereitung (nur lokal)");
  ok(sql(`select to_regclass('public.wartung') is not null`) === "t", "Tabelle public.wartung vorhanden (Migration 363)");
  ausnahmenVorher = sql(`select coalesce(array_to_string(ausnahmen, ','), '') from wartung where id = 'default'`);
  skript("aus");
  skript("ausnahmen", "lohn-admin2@example.com");
  ok(sql(`select ausnahmen = array['${ID.admin2}']::uuid[] from wartung`) === "t", "Ausnahme per Skript: Admin Zwei");
  const auditVorher = Number(sql(`select count(*) from permission_audit_log where action like 'wartung.%'`));
  await warteCache("Ausgangslage");

  const lara = await login("lara.steiner@example.com");
  const admin = await login("lohn-admin@example.com");                                  // ohne Gerät
  const adminG = await login("lohn-admin@example.com", "lokal-testgeraet-admin");        // mit Gerät, keine Ausnahme
  const admin2G = await login("lohn-admin2@example.com", "lokal-testgeraet-admin2");     // mit Gerät, Ausnahme

  // -------------------------------------------------------------------------
  titel("1  Vorher (Wartung aus)");
  const vorher = {};
  for (const [pfad] of SEITEN) {
    const r = await adminG.api(pfad);
    ok(r.status === 200 && !hatHinweis(r.text), `Seite ${pfad.split("?")[0]} → ${r.status}, kein Hinweis`);
  }
  const reiterVorher = await adminG.api(RECHTE_REITER);
  ok(reiterVorher.status === 200 && rechteKontext(reiterVorher.text, "frei"), `Anträge › Rechte & Lohndaten → ${reiterVorher.status}, Kontext «rechte: frei»`);
  const alteAdresse = await adminG.api(`/rechte-antraege?id=${ZUFALL_ID}`);
  ok(leitetUm(alteAdresse, `/antraege?tab=rechte&id=${ZUFALL_ID}`), `/rechte-antraege?id=… → /antraege?tab=rechte&id=… (${alteAdresse.status})`);
  for (const route of ROUTEN) {
    const r = await rufe(adminG, route);
    vorher[route[1]] = r.status;
    ok(r.status !== 503, `${route[0]} ${route[1].split("?")[0]} → ${r.status}`);
  }
  const eigeneVorher = await lara.api("/api/hr/wage-documents");
  ok(eigeneVorher.status === 200, `Techniker: eigene Lohndokumente → ${eigeneVorher.status}`);

  // -------------------------------------------------------------------------
  titel("2  Wartung an (Skript)");
  const ausgabe = skript("an", "lohn", "rechte", "geraete", "finanzen", "--grund", "Prüfung Wartung (Umbau)");
  ok(/Geändert: Lohn an, Rechte an, Geräte an, Finanzen an/.test(ausgabe), "Skript: vier Bereiche eingeschaltet");
  ok(sql(`select grund from wartung`) === "Prüfung Wartung (Umbau)", "Grund mit Umlauten unversehrt gespeichert");
  ok(/AN: Lohn, Rechte, Geräte, Finanzen/.test(skript("status")), "Skript-Status zeigt AN");
  await warteCache("nach dem Einschalten");

  for (const [pfad, bereich] of SEITEN) {
    const r = await adminG.api(pfad);
    ok(r.status === 200 && hatHinweis(r.text) && !hatBalken(r.text), `Admin: Seite ${pfad.split("?")[0]} zeigt Hinweis (${bereich})`);
  }
  const laraSeite = await lara.api("/lohn");
  ok(hatHinweis(laraSeite.text), "Techniker: /lohn zeigt Hinweis");
  const reiterAn = await adminG.api(RECHTE_REITER);
  ok(reiterAn.status === 200 && rechteKontext(reiterAn.text, "gesperrt"), "Anträge › Rechte & Lohndaten: Kontext «rechte: gesperrt» (Hinweis statt Inhalt)");
  const alteAdresseAn = await adminG.api("/rechte-antraege");
  ok(leitetUm(alteAdresseAn, "/antraege?tab=rechte") && !hatHinweis(alteAdresseAn.text), "/rechte-antraege leitet auch in der Wartung um (Hinweis zeigt der Reiter)");
  const einst = await adminG.api("/einstellungen?tab=mitarbeiter");
  ok(einst.status === 200 && /rechte\\?"\s*:\s*\\?"gesperrt/.test(einst.text), "Einstellungen: Kontext «rechte: gesperrt» für die Tabs");
  const sich = await adminG.api("/sicherheit");
  ok(sich.status === 200 && /geraete\\?"\s*:\s*\\?"gesperrt/.test(sich.text), "Sicherheit: Kontext «geraete: gesperrt» für «Vertraute Geräte»");

  for (const route of ROUTEN) {
    const r = await rufe(adminG, route);
    ok(r.status === 503 && r.json?.error === MELDUNG && r.json?.code === "wartung" && r.json?.bereich === route[3],
      `Admin ${route[0]} ${route[1].split("?")[0]} → ${r.status} ${r.json?.bereich ?? ""}`);
  }
  for (const [methode, pfad, body] of [
    ["GET", "/api/hr/wage-documents"],
    ["POST", "/api/hr/wage-documents/accept-digital"],
    ["POST", "/api/trust/devices", { device_name: "Prüfgerät Wartung" }],
  ]) {
    const r = await rufe(lara, [methode, pfad, body]);
    ok(r.status === 503 && r.json?.error === MELDUNG, `Techniker ${methode} ${pfad} → ${r.status}`);
  }
  const technikerOhneRecht = await lara.api("/api/hr/compensation");
  ok(technikerOhneRecht.status === 403, `Techniker ohne Lohnrecht bleibt bei 403 (nicht 503) → ${technikerOhneRecht.status}`);

  // Cron
  const docsVorher = sql(`select count(*) from wage_documents`);
  const laufVorher = sql(`select count(*) from lohn_lauf`);
  const probe = await cron("?probe=1");
  ok(probe.status === 200 && probe.json?.status === "pausiert", `Cron ?probe=1 → ${probe.status} ${probe.json?.status}`);
  ok(sql(`select count(*) from lohn_lauf`) === laufVorher, "Probe schreibt nichts");
  const lauf = await cron();
  ok(lauf.status === 200 && lauf.json?.status === "pausiert", `Cron → ${lauf.status} ${lauf.json?.status}`);
  ok(sql(`select status || '|' || zusammenfassung from lohn_lauf order by gestartet_at desc limit 1`) === "pausiert|pausiert (Wartung)", "lohn_lauf: «pausiert (Wartung)»");
  ok(sql(`select count(*) from wage_documents`) === docsVorher, "Cron hat keine Abrechnung erzeugt");
  const laufAnzeige = await admin2G.api("/api/hr/lohn-lauf");
  ok(laufAnzeige.json?.laeufe?.[0]?.zusammenfassung === "pausiert (Wartung)", "Lohn-Seite (Ausnahme) zeigt den pausierten Lauf");

  // Ausnahme
  for (const [pfad, bereich] of SEITEN) {
    const r = await admin2G.api(pfad);
    ok(r.status === 200 && !hatHinweis(r.text) && hatBalken(r.text), `Ausnahme: Seite ${pfad.split("?")[0]} normal + Balken (${bereich})`);
  }
  const reiterAusnahme = await admin2G.api(RECHTE_REITER);
  ok(reiterAusnahme.status === 200 && rechteKontext(reiterAusnahme.text, "ausnahme"), "Ausnahme: Anträge › Rechte & Lohndaten mit Kontext «rechte: ausnahme» (Inhalt + Balken)");
  for (const route of ROUTEN) {
    const r = await rufe(admin2G, route);
    ok(r.status !== 503, `Ausnahme ${route[0]} ${route[1].split("?")[0]} → ${r.status}`);
  }

  // Schalter in der App
  const ohneGeraet = await admin.api("/api/wartung", { method: "POST", body: JSON.stringify({ bereich: "lohn", aktiv: false }) });
  ok(ohneGeraet.status === 403, `App-Schalter ohne vertrautes Gerät → ${ohneGeraet.status}`);
  const lesen = await admin.api("/api/wartung");
  ok(lesen.status === 200 && lesen.json?.darf_schalten === false && lesen.json?.stand?.bereiche?.length === 4, "App-Schalter ohne Gerät: Stand lesbar, Schalten gesperrt");
  const technikerSchalter = await lara.api("/api/wartung");
  ok(technikerSchalter.status === 403, `Techniker: /api/wartung → ${technikerSchalter.status}`);
  const falsch = await adminG.api("/api/wartung", { method: "POST", body: JSON.stringify({ bereich: "alles", aktiv: false }) });
  ok(falsch.status === 400, `Unbekannter Bereich → ${falsch.status}`);

  // -------------------------------------------------------------------------
  titel("3  Wartung aus (App, Admin mit Gerät)");
  let letzte = null;
  for (const bereich of ["lohn", "rechte", "geraete", "finanzen"]) {
    letzte = await adminG.api("/api/wartung", { method: "POST", body: JSON.stringify({ bereich, aktiv: false }) });
    ok(letzte.status === 200, `Ausschalten ${bereich} → ${letzte.status}`);
  }
  ok(letzte?.json?.stand?.bereiche?.length === 0 && letzte?.json?.stand?.grund === null, "Stand danach: nichts in Wartung, Grund leer");
  const audit = sql(`select string_agg(action, ',' order by occurred_at) from permission_audit_log where action like 'wartung.%' offset 0`);
  const neu = Number(sql(`select count(*) from permission_audit_log where action like 'wartung.%'`)) - auditVorher;
  ok(neu === 5 && audit.endsWith("wartung.an,wartung.aus,wartung.aus,wartung.aus,wartung.aus"), `Rechte-Protokoll: 1× wartung.an (Skript), 4× wartung.aus (App) → ${neu} neu`);
  ok(sql(`select actor_label from permission_audit_log where action = 'wartung.aus' order by occurred_at desc limit 1`) === sql(`select full_name from profiles where id = '${ID.admin}'`), "Protokoll nennt den schaltenden Admin");
  await warteCache("nach dem Ausschalten");

  for (const [pfad] of SEITEN) {
    const r = await adminG.api(pfad);
    ok(r.status === 200 && !hatHinweis(r.text) && !hatBalken(r.text), `Seite ${pfad.split("?")[0]} → wieder normal`);
  }
  const reiterNachher = await adminG.api(RECHTE_REITER);
  ok(reiterNachher.status === 200 && rechteKontext(reiterNachher.text, "frei"), "Anträge › Rechte & Lohndaten → wieder «rechte: frei»");
  for (const route of ROUTEN) {
    const r = await rufe(adminG, route);
    ok(r.status === vorher[route[1]], `${route[0]} ${route[1].split("?")[0]} → ${r.status} (wie vorher ${vorher[route[1]]})`);
  }
  const eigeneNachher = await lara.api("/api/hr/wage-documents");
  ok(eigeneNachher.status === 200, `Techniker: eigene Lohndokumente → ${eigeneNachher.status}`);
  const probeNachher = await cron("?probe=1");
  ok(probeNachher.status === 200 && probeNachher.json?.status === "probe", `Cron ?probe=1 → ${probeNachher.json?.status} (läuft wieder)`);
} catch (e) {
  ok(false, `Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try {
    skript("aus");
    sql(`update wartung set ausnahmen = '{${ausnahmenVorher}}'::uuid[] where id = 'default'`);
    console.log("   Wartung aus, Ausnahmen zurückgesetzt");
  } catch (e) {
    ok(false, `Zurücksetzen: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const s of sitzungen) await s.auth.signOut({ scope: "local" });
  console.log(`\n${fehler === 0 ? "ALLES OK" : fehler + " FEHLER"} — Sitzungen nur lokal abgemeldet.`);
  process.exitCode = fehler === 0 ? 0 : 1;
}
