#!/usr/bin/env node
// Abgleich lokales Schema <-> Live (nur LESEND).
//
// Führt supabase/lokal/katalog-fingerabdruck.sql
//   - lokal im DB-Container (docker exec psql) und
//   - auf Live über den read-only Endpoint der Supabase Management API
//     (Rolle supabase_read_only_user, kann nichts schreiben)
// aus und vergleicht beide Listen. Ausgabe: Zusammenfassung + Datei
// supabase/lokal/abgleich-ergebnis.txt (gitignored).
//
// Token: Umgebungsvariable SUPABASE_ACCESS_TOKEN oder Token-Register
// C:\Users\misch\projects\_secrets\supabase-access-token.txt (NAME=wert).
// Der Token wird nie ausgegeben.
//
// Aufruf (im Worktree-Root):  node supabase/lokal/abgleich.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIVE_REF = "uxtotpniwbwyoznwkygd";
const CONTAINER = "supabase_db_eventline-fsm-lohn";
const sql = fs.readFileSync(path.join(here, "katalog-fingerabdruck.sql"), "utf8").trim().replace(/;\s*$/, "");

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const f = "C:/Users/misch/projects/_secrets/supabase-access-token.txt";
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function live() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Live-Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

function lokal() {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`;
  const out = execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], {
    input: wrapped,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  return JSON.parse(out.trim());
}

const [L, R] = await Promise.all([Promise.resolve(lokal()), live()]);
const toMap = (rows) => new Map(rows.map((r) => [r.k, r.v]));
const lm = toMap(L), rm = toMap(R);

// Bewusst nicht nachgebaute Live-Objekte (siehe TESTUMGEBUNG.md, «Bekannte Abweichungen»)
const BEKANNT = new Set([
  "fn|public._test_payroll()",     // Test-Überbleibsel auf Live (verweist auf eine echte Profil-ID)
  "fnacl|public._test_payroll()",
  "role|sicherung_lesen",          // Nur-Lese-Rolle der Datensicherung (Login mit Passwort, nur Live)
]);

const nurLive = [], nurLokal = [], anders = [], bekannt = [];
for (const [k, v] of rm) {
  if (BEKANNT.has(k) && !lm.has(k)) bekannt.push(k);
  else if (!lm.has(k)) nurLive.push(k);
  else if (lm.get(k) !== v) anders.push(`${k}\n    live : ${v}\n    lokal: ${lm.get(k)}`);
}
for (const k of lm.keys()) if (!rm.has(k)) nurLokal.push(k);

const zaehle = (keys) => keys.reduce((m, k) => ((m[k.split("|")[0]] = (m[k.split("|")[0]] ?? 0) + 1), m), {});
const lines = [];
lines.push(`Abgleich lokal <-> Live (${new Date().toISOString()})`);
lines.push(`Objekte: live ${rm.size}, lokal ${lm.size}`);
lines.push(`Nur live: ${nurLive.length} ${JSON.stringify(zaehle(nurLive))}`);
lines.push(`Nur lokal: ${nurLokal.length} ${JSON.stringify(zaehle(nurLokal))}`);
lines.push(`Unterschiedlich: ${anders.length} ${JSON.stringify(zaehle(anders.map((a) => a.split("\n")[0])))}`);
lines.push(`Bekannt (nur Live, gewollt): ${bekannt.length} ${JSON.stringify(bekannt)}`);
lines.push("", "== Nur live ==", ...nurLive, "", "== Nur lokal ==", ...nurLokal, "", "== Unterschiedlich ==", ...anders,
  "", "== Bekannt (nur Live, gewollt) ==", ...bekannt);
const outFile = path.join(here, "abgleich-ergebnis.txt");
fs.writeFileSync(outFile, lines.join("\n") + "\n");
console.log(lines.slice(0, 6).join("\n"));
console.log(`Details: ${outFile}`);
process.exitCode = nurLive.length + nurLokal.length + anders.length === 0 ? 0 : 2;
