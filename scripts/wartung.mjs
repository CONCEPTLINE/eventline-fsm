#!/usr/bin/env node
// Wartungsmodus schalten (Umbauten) — Migration 363, Regeln: src/lib/wartung.ts.
//
//   node scripts/wartung.mjs status
//   node scripts/wartung.mjs an <bereich…|alle> [--grund "…"]
//   node scripts/wartung.mjs aus [<bereich…>|alle]            (ohne Bereich = alle)
//   node scripts/wartung.mjs ausnahmen <mail|profil-id …>     (ersetzt die Liste)
//   node scripts/wartung.mjs ausnahmen --keine
//   … --lokal          gegen die lokale Testumgebung (Docker), sonst LIVE
//   … --durch "Name"   Name im Rechte-Protokoll (sonst «Wartungs-Skript (<Windows-Konto>)»)
//
// Bereiche: lohn, rechte, geraete, finanzen.
// Live: Supabase Management API, Projekt uxtotpniwbwyoznwkygd (fest). Token aus
// SUPABASE_ACCESS_TOKEN oder C:\Users\misch\projects\_secrets\supabase-access-token.txt
// (wie supabase/lokal/live-gang-phase1/pruefen-live.mjs) — wird nie ausgegeben.
// Geschaltet wird über public.wartung_setzen / wartung_ausnahmen_setzen
// (protokolliert im Rechte-Protokoll: wartung.an / wartung.aus / wartung.ausnahmen).
// Die App liest den Stand höchstens 10 s gecacht — nach spätestens 10 s wirkt es überall.
//
// Umlaute im Grund: aus PowerShell aufrufen. Git Bash kann sie verstümmeln
// (U+FFFD) — das Skript bricht dann ab statt Unsinn zu speichern.

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const LOKAL_DB = "supabase_db_eventline-fsm-lohn";
const BEREICHE = ["lohn", "rechte", "geraete", "finanzen"];
const LABEL = { lohn: "Lohn", rechte: "Rechte", geraete: "Geräte", finanzen: "Finanzen" };

const argv = process.argv.slice(2);
function stop(text, code = 2) {
  console.error(text);
  process.exit(code);
}
function wertNach(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) stop(`${flag} braucht einen Wert`);
  argv.splice(i, 2);
  return v;
}

const LOKAL = argv.includes("--lokal");
if (LOKAL) argv.splice(argv.indexOf("--lokal"), 1);
const KEINE = argv.includes("--keine");
if (KEINE) argv.splice(argv.indexOf("--keine"), 1);
const grund = wertNach("--grund");
const durch = wertNach("--durch");
const [befehl, ...rest] = argv;

for (const a of [grund, durch, ...rest]) {
  if (a && a.includes("\uFFFD")) stop("Abbruch: ein Argument enthält verstümmelte Zeichen (U+FFFD). Aus PowerShell aufrufen.");
}
const unbekannt = rest.find((a) => a.startsWith("--"));
if (unbekannt) stop(`Unbekannte Option: ${unbekannt}`);

const HILFE = `Aufruf:
  node scripts/wartung.mjs status [--lokal]
  node scripts/wartung.mjs an <${BEREICHE.join("|")}…|alle> [--grund "…"] [--lokal]
  node scripts/wartung.mjs aus [<bereich…>|alle] [--lokal]
  node scripts/wartung.mjs ausnahmen <mail|profil-id …> | --keine [--lokal]`;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const f = "C:/Users/misch/projects/_secrets/supabase-access-token.txt";
  if (!fs.existsSync(f)) stop("SUPABASE_ACCESS_TOKEN fehlt (Umgebung oder Token-Register)", 1);
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) stop("SUPABASE_ACCESS_TOKEN im Token-Register nicht gefunden", 1);
  return line.slice(line.indexOf("=") + 1).trim();
}

/** SQL ausführen, Zeilen als Objekte. `lesend` = read-only Endpoint (Live). */
async function abfrage(query, { lesend = false } = {}) {
  if (LOKAL) {
    const out = execFileSync(
      "docker",
      ["exec", "-i", LOKAL_DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
      { input: Buffer.from(`select coalesce(json_agg(t), '[]'::json) from (${query}) t;`, "utf8") },
    ).toString("utf8");
    return JSON.parse(out.trim());
  }
  const senden = (endpunkt) =>
    fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/${endpunkt}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ query }),
    });
  let res = await senden(lesend ? "query/read-only" : "query");
  // Darf die Nur-Lese-Rolle public.wartung nicht lesen: dieselbe (lesende) Abfrage normal.
  if (lesend && !res.ok) res = await senden("query");
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

/** json/jsonb-Spalten kommen je nach Weg als Objekt oder als Text. */
const json = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const lit = (s) => (s === null || s === undefined ? "null" : `'${String(s).replace(/'/g, "''")}'`);
const textArr = (xs) => `array[${xs.map(lit).join(", ")}]::text[]`;
const uuidArr = (xs) => `array[${xs.map(lit).join(", ")}]::uuid[]`;
const zeit = (iso) => new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const name = durch?.trim() || `Wartungs-Skript (${os.userInfo().username})`;
const ziel = LOKAL ? "LOKAL (Testumgebung)" : `LIVE (${LIVE_REF})`;

function bereicheAus(liste, leerHeisstAlle) {
  if (liste.length === 0) return leerHeisstAlle ? [...BEREICHE] : null;
  if (liste.length === 1 && liste[0] === "alle") return [...BEREICHE];
  const falsch = liste.filter((b) => !BEREICHE.includes(b));
  if (falsch.length) stop(`Unbekannter Bereich: ${falsch.join(", ")} (gültig: ${BEREICHE.join(", ")}, alle)`);
  return [...new Set(liste)];
}

async function zeigeStatus() {
  const rows = await abfrage(
    `select json_build_object(
              'bereiche', to_json(w.bereiche), 'grund', w.grund, 'seit', w.seit,
              'geaendert_at', w.geaendert_at, 'geaendert_von_name', w.geaendert_von_name,
              'ausnahmen', coalesce((select json_agg(coalesce(p.full_name, p.email) order by p.full_name)
                                       from public.profiles p where p.id = any (w.ausnahmen)), '[]'::json),
              'ausnahmen_anzahl', cardinality(w.ausnahmen)) as w
       from public.wartung w where w.id = 'default'`,
    { lesend: true },
  );
  const w = rows[0] ? json(rows[0].w) : null;
  if (!w) stop("Keine Zeile in public.wartung — Migration 363 eingespielt?", 1);
  console.log(`Wartung ${ziel}`);
  if (w.bereiche.length === 0) {
    console.log("  aus (kein Bereich in Wartung)");
  } else {
    console.log(`  AN: ${w.bereiche.map((b) => LABEL[b] ?? b).join(", ")}${w.seit ? ` · seit ${zeit(w.seit)}` : ""}`);
    if (w.grund) console.log(`  Grund: ${w.grund}`);
  }
  const fehlend = Number(w.ausnahmen_anzahl) - w.ausnahmen.length;
  console.log(`  Ausnahmen: ${w.ausnahmen.length ? w.ausnahmen.join(", ") : "keine"}${fehlend > 0 ? ` (+${fehlend} unbekannte ID)` : ""}`);
  if (w.geaendert_von_name) console.log(`  zuletzt geändert ${zeit(w.geaendert_at)} von ${w.geaendert_von_name}`);
}

async function setzen(an, aus) {
  const rows = await abfrage(
    `select public.wartung_setzen(${textArr(an)}, ${textArr(aus)}, ${lit(grund)}, null, ${lit(name)}) as r`,
  );
  const r = rows[0] ? json(rows[0].r) : null;
  if (!r) throw new Error("keine Antwort von wartung_setzen");
  const geaendert = [...r.an.map((b) => `${LABEL[b]} an`), ...r.aus.map((b) => `${LABEL[b]} aus`)];
  console.log(geaendert.length ? `Geändert: ${geaendert.join(", ")} — protokolliert.` : "Keine Änderung (war schon so).");
}

async function ausnahmenSetzen(liste) {
  let ids = [];
  if (!KEINE) {
    if (liste.length === 0) stop("ausnahmen: Mail oder Profil-ID angeben (oder --keine)");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const mails = liste.filter((x) => !uuid.test(x)).map((x) => x.toLowerCase());
    ids = liste.filter((x) => uuid.test(x)).map((x) => x.toLowerCase());
    if (mails.length) {
      const rows = await abfrage(
        `select id, lower(email) as email from public.profiles where lower(email) = any (${textArr(mails)})`,
        { lesend: true },
      );
      const fehlt = mails.filter((m) => !rows.some((r) => r.email === m));
      if (fehlt.length) stop(`Kein Profil mit dieser Mail: ${fehlt.join(", ")}`, 1);
      ids.push(...rows.map((r) => r.id));
    }
  } else if (liste.length) {
    stop("ausnahmen: entweder Liste oder --keine");
  }
  const rows = await abfrage(`select public.wartung_ausnahmen_setzen(${uuidArr(ids)}, null, ${lit(name)}) as r`);
  const namen = (rows[0] ? json(rows[0].r) : null)?.namen ?? [];
  console.log(`Ausnahmen: ${namen.length ? namen.join(", ") : "keine"} — protokolliert.`);
}

try {
  if (befehl === "status") {
    if (rest.length) stop(HILFE);
    await zeigeStatus();
  } else if (befehl === "an") {
    const b = bereicheAus(rest, false);
    if (!b) stop(`an: Bereich angeben\n${HILFE}`);
    console.log(`Wartung EIN ${ziel}: ${b.map((x) => LABEL[x]).join(", ")}`);
    await setzen(b, []);
    await zeigeStatus();
  } else if (befehl === "aus") {
    if (grund) stop("--grund gilt nur beim Einschalten");
    const b = bereicheAus(rest, true);
    console.log(`Wartung AUS ${ziel}: ${b.map((x) => LABEL[x]).join(", ")}`);
    await setzen([], b);
    await zeigeStatus();
  } else if (befehl === "ausnahmen") {
    if (grund) stop("--grund gilt nur beim Einschalten");
    await ausnahmenSetzen(rest);
    await zeigeStatus();
  } else {
    stop(HILFE);
  }
} catch (e) {
  stop(`Fehler: ${e instanceof Error ? e.message : String(e)}`, 1);
}
