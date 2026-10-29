#!/usr/bin/env node
// Sicherung VOR dem Live-Gang Phase 2 (nur LESEND, Standardformate CSV).
//
// Liest auf Live über den read-only Endpoint der Management API (Rolle
// supabase_read_only_user, kann nichts schreiben) und legt ab:
//   <ziel>/tabellen/<tabelle>.csv   Lohnzeilen, Firmensätze, Lohndokumente, Lohn-Einstellungen,
//                                   Lauf, Protokolle, Stempel (vollständig), Profile (Lohnfelder)
//   <ziel>/storage-objekte.csv      Dateiliste lohndokumente
//   <ziel>/LIESMICH.txt             Zeitpunkt, Zeilenzahlen
// Phase 2 ändert keine bestehenden Zeilen und keine PDFs (nur neue Tabellen,
// Trigger, Funktionen und eine Spalte in lohn_einstellungen). Die Sicherung
// dient dem Vergleich und dem Rückweg.
//
// Aufruf: node supabase/lokal/live-gang-phase2/sicherung.mjs [zielordner]
//         node supabase/lokal/live-gang-phase2/sicherung.mjs --lokal [zielordner]
//   Standard-Ziel: C:\Users\misch\projects\_lohn-korrektur\sicherung\<YYYY-MM-DD>-phase2
// Token: SUPABASE_ACCESS_TOKEN oder C:\Users\misch\projects\_secrets\supabase-access-token.txt.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const args = process.argv.slice(2);
const LOKAL = args[0] === "--lokal";
if (LOKAL) args.shift();
const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
const ziel = args[0] ?? `C:/Users/misch/projects/_lohn-korrektur/sicherung/${heute}-phase2`;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const line = fs.readFileSync("C:/Users/misch/projects/_secrets/supabase-access-token.txt", "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function lesen(query) {
  const q = `select coalesce(json_agg(t), '[]'::json) as j from (${query}) t`;
  if (LOKAL) {
    const out = execFileSync("docker", ["exec", "-i", "supabase_db_eventline-fsm-lohn", "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], { input: `${q};`, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
    return JSON.parse(out.trim());
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Live-Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 300)}`);
  return JSON.parse(txt)[0].j;
}

function csv(rows) {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const tabellen = {
  employee_compensation: "select * from public.employee_compensation order by profile_id, effective_from",
  payroll_defaults: "select * from public.payroll_defaults order by effective_from",
  wage_documents: "select * from public.wage_documents order by profile_id, year, period_month, version",
  lohn_einstellungen: "select * from public.lohn_einstellungen",
  lohn_lauf: "select * from public.lohn_lauf order by gestartet_at",
  lohn_dokument_protokoll: "select * from public.lohn_dokument_protokoll order by occurred_at",
  time_entries: "select id, user_id, clock_in, clock_out, entry_number from public.time_entries order by clock_in",
  profiles_lohn: "select id, full_name, role, is_active, birthdate from public.profiles order by id",
};

fs.mkdirSync(path.join(ziel, "tabellen"), { recursive: true });
const zahlen = [];
for (const [name, q] of Object.entries(tabellen)) {
  const rows = await lesen(q);
  fs.writeFileSync(path.join(ziel, "tabellen", `${name}.csv`), csv(rows));
  zahlen.push(`${name}: ${rows.length} Zeilen`);
}
const objekte = await lesen("select bucket_id, name, created_at, metadata->>'size' as groesse from storage.objects where bucket_id = 'lohndokumente' order by name");
fs.writeFileSync(path.join(ziel, "storage-objekte.csv"), csv(objekte));
zahlen.push(`storage.objects (lohndokumente): ${objekte.length}`);
fs.writeFileSync(path.join(ziel, "LIESMICH.txt"), [`Sicherung vor Lohn-Umbau Phase 2, ${new Date().toISOString()} (${LOKAL ? "LOKAL" : "Live, nur gelesen"})`, ...zahlen].join("\r\n") + "\r\n");
console.log(`Sicherung abgelegt: ${ziel}`);
for (const z of zahlen) console.log(`  ${z}`);
