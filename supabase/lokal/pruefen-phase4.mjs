#!/usr/bin/env node
// Prüftor Lohn-Umbau Phase 4 «Stempel und Monatsabschluss» — NUR LOKAL
// (Docker-Supabase + Dev-Server :3100). Ändert nur die lokale Test-DB.
//
//   A  Stempel (phase4/stempel.mjs): Überlappung (Regel 368, Altfälle
//      ausgenommen, angrenzend erlaubt, gleichzeitige Geräte), lange Stempel
//      nur mit Begründung, Felder der Lohnverwaltung geschützt, Sperre auch für
//      den Server, Stempel-Antrag nach der Sperre (Vier Augen), Ticket-Nachtrag
//   B  Abrechnung (phase4/abrechnung.mjs): Zusatzposten in Brutto/Abzügen/
//      Auszahlung, Jahresliste, Lohnausweis; Zusatzposten nach der Sperre nur
//      per Antrag; Inhalt der Lohnabrechnung (Klartext, keine internen Angaben)
//   C  Monatsabschluss (phase4/monatsabschluss.mjs): offener/langer Stempel
//      blockiert den Monat im Lauf, Alarm, Erinnerung vor der Sperre,
//      Statusspalte (fehlt/erstellt/blockiert/Korrektur/Fehler/ausbezahlt),
//      «ausbezahlt» von Hand, Zustellung (Meldung, Wahl, geöffnet), Zähler «Anträge»
//
// Aufruf: bash supabase/lokal/aufbauen.sh --nur-seed && node supabase/lokal/pruefen-phase4.mjs [stempel|abrechnung|monatsabschluss]
// Meldet sich überall nur LOKAL ab (signOut({ scope: "local" })).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

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
if (!env.CRON_SECRET) {
  console.error("ABBRUCH: CRON_SECRET fehlt in .env.local.");
  process.exit(1);
}

const P = (n) => `a0000000-0000-4000-8000-0000000000${n}`;
const ID = { admin: P("01"), admin2: P("02"), lena: P("11"), noah: P("12"), mia: P("13"), elias: P("14"), sara: P("15"), jonas: P("16"), lara: P("17"), luca: P("18"), ben: P("19") };
const MAIL = { admin: "lohn-admin@example.com", admin2: "lohn-admin2@example.com", lena: "lena.jung@example.com", noah: "noah.brunner@example.com", mia: "mia.keller@example.com", elias: "elias.meier@example.com", sara: "sara.huber@example.com", jonas: "jonas.frei@example.com", lara: "lara.steiner@example.com", luca: "luca.rossi@example.com", ben: "ben.wyss@example.com" };
const GERAET = { admin: "lokal-testgeraet-admin", admin2: "lokal-testgeraet-admin2" };
const PW = "LohnTest-2026!";
const service = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fehler = 0;
let anzahl = 0;
const ok = (b, msg) => { anzahl++; console.log(`${b ? "OK    " : "FEHLER"} ${msg}`); if (!b) fehler++; return b; };
const titel = (t) => console.log(`\n== ${t}`);
/** SQL als postgres (umgeht RLS, NICHT die Trigger). Notweg für Testvorbereitung:
 *  sql("select set_config('lohn.notweg','an',true); …") in EINEM Aufruf. */
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sqlFehler = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };
const gleich = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;
const mm = (j, m) => `${j}-${String(m).padStart(2, "0")}`;

const sitzungen = [];
/** Anmelden (App über Cookies + supabase-js wie im Browser). geraet = Cookie «vertrautes Gerät». */
async function login(wer, geraet = GERAET[wer]) {
  const email = MAIL[wer] ?? wer;
  const jar = new Map();
  const supa = createServerClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (l) => l.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { data, error } = await supa.auth.signInWithPassword({ email, password: PW });
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
    return { status: res.status, json, buf, headers: res.headers };
  };
  /** supabase-js wie im Browser (RLS, Stempeln direkt gegen die DB). */
  return { api, supa, userId: data.user.id };
}
const post = (s, pfad, body, method = "POST") => s.api(pfad, { method, body: JSON.stringify(body) });
/** Lohnlauf wie der Cron (Systemweg). */
const lauf = async (query = "") => {
  const res = await fetch(`${APP}/api/cron/auto-lohnabrechnung${query}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, json };
};
const cron = async (pfad) => {
  const res = await fetch(`${APP}${pfad}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  let json = null;
  try { json = await res.json(); } catch { /* leer */ }
  return { status: res.status, json };
};

const ctx = { ok, titel, sql, sqlFehler, gleich, mm, login, post, lauf, cron, ID, MAIL, APP, env, service, root };

const nur = process.argv[2];
const module = ["stempel", "abrechnung", "monatsabschluss"].filter((m) => !nur || m === nur);
try {
  // Lauf holt gesperrte Monate ab März nach (wie pruefen-phase1).
  sql("update lohn_einstellungen set lauf_ab = '2026-03-01' where id = 'default'");
  for (const m of module) {
    const datei = path.join(here, "phase4", `${m}.mjs`);
    if (!fs.existsSync(datei)) { ok(false, `Prüfmodul fehlt: phase4/${m}.mjs`); continue; }
    const mod = await import(`file://${datei.replace(/\\/g, "/")}`);
    try {
      await mod.pruefe(ctx);
    } catch (e) {
      ok(false, `${m}: abgebrochen — ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
} finally {
  for (const s of sitzungen) await s.auth.signOut({ scope: "local" }).catch(() => {});
}
console.log(fehler === 0 ? `\nALLES OK (${anzahl} Prüfungen)` : `\n${fehler} FEHLER von ${anzahl} Prüfungen`);
process.exit(fehler === 0 ? 0 : 1);
