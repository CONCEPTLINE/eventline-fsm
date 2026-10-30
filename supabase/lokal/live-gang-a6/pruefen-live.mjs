#!/usr/bin/env node
// Live-Gang A6 Stammdaten-Abruf (Migration 370) — Prüfungen auf LIVE, NUR LESEND.
//
//   node supabase/lokal/live-gang-a6/pruefen-live.mjs vorher             (369 live, vor 370)
//   node supabase/lokal/live-gang-a6/pruefen-live.mjs nachher            (nach 370)
//   node supabase/lokal/live-gang-a6/pruefen-live.mjs app [<url>]        (nach dem Deploy: Routen da, Schlüssel gesetzt)
//   … --lokal   Datenbank-Prüfungen gegen die lokale Test-DB (Docker), app gegen http://localhost:3100
//
// Lesen über den read-only-Endpunkt der Management API (Token aus
// _secrets/supabase-access-token.txt oder SUPABASE_ACCESS_TOKEN). Ausgabe nur
// Zählungen und Ja/Nein (keine Namen, keine Beträge). «app» schickt nur einen
// ungültigen Ausweis («a.b.c»): 401 = Route da und Schlüssel gesetzt, 503 = Schlüssel
// fehlt, 404 = Code (noch) nicht deployt.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const LIVE_APP = "https://eventline-fsm-usyk.vercel.app";
const args = process.argv.slice(2);
const LOKAL = args.includes("--lokal");
const [schritt, urlArg] = args.filter((a) => !a.startsWith("--"));
const SCHRITTE = ["vorher", "nachher", "app"];
if (!SCHRITTE.includes(schritt ?? "")) {
  console.error(`Aufruf: pruefen-live.mjs ${SCHRITTE.join(" | ")} [<url>] [--lokal]`);
  process.exit(2);
}

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const line = fs.readFileSync("C:/Users/misch/projects/_secrets/supabase-access-token.txt", "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function wert(query) {
  if (LOKAL) {
    const out = execFileSync("docker", ["exec", "-i", "supabase_db_eventline-fsm-lohn", "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], {
      input: `select coalesce(json_agg(t), '[]'::json) from (${query}) t;`,
    }).toString("utf8");
    return Object.values(JSON.parse(out.trim())[0] ?? {})[0];
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  return Object.values(JSON.parse(txt)[0] ?? {})[0];
}

let fehler = 0;
async function pruefe(text, query, erwartet) {
  let v;
  try {
    v = await wert(query);
  } catch (e) {
    console.log(`FEHLER ${text}: ${e instanceof Error ? e.message : String(e)}`);
    fehler++;
    return;
  }
  const ok = String(v) === String(erwartet);
  console.log(`${ok ? "OK    " : "FEHLER"} ${text} → ${v}`);
  if (!ok) fehler++;
}

const REGEL_A6 = "select pg_get_constraintdef(oid) like '%flow-stammdaten%' from pg_constraint where conname = 'flow_abrufe_aud_check' and conrelid = 'public.flow_abrufe'::regclass";
const FUNKTION_A6 = "select prosrc like '%flow-stammdaten%' from pg_proc where proname = 'flow_abruf_beginnen' and pronamespace = 'public'::regnamespace";

console.log(`Prüfung «${schritt}» ${LOKAL ? "(LOKAL)" : `(Live ${LIVE_REF}, nur lesend)`}`);

if (schritt === "vorher") {
  await pruefe("369 live: flow_abrufe und flow_abruf_beginnen vorhanden",
    "select to_regclass('public.flow_abrufe') is not null and to_regprocedure('public.flow_abruf_beginnen(uuid,text,uuid,integer,integer,integer,timestamptz,timestamptz)') is not null", true);
  await pruefe("370 noch nicht eingespielt: Regel kennt flow-stammdaten nicht", REGEL_A6, false);
  await pruefe("370 noch nicht eingespielt: flow_abruf_beginnen kennt flow-stammdaten nicht", FUNKTION_A6, false);
}

if (schritt === "nachher") {
  await pruefe("Regel flow_abrufe_aud_check kennt flow-stammdaten", REGEL_A6, true);
  await pruefe("flow_abruf_beginnen nimmt flow-stammdaten an", FUNKTION_A6, true);
  await pruefe("bisherige aud unverändert erlaubt (4 von A1/A5)",
    "select (select count(*) from unnest(array['erp-stempel','erp-personen','erp-vergleich','erp-lohnabrechnung-ablage']) a where pg_get_constraintdef(c.oid) like '%' || a || '%') from pg_constraint c where conname = 'flow_abrufe_aud_check'", 4);
  await pruefe("Funktionen nur für den Server (nicht authenticated/anon)",
    "select count(*) filter (where has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute')) from pg_proc where proname in ('flow_abruf_beginnen','flow_abruf_abschliessen')", 0);
  await pruefe("flow_abrufe: RLS an, Browser ohne Rechte",
    "select (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.flow_abrufe'::regclass) and not has_table_privilege('authenticated', 'public.flow_abrufe', 'SELECT') and not has_table_privilege('anon', 'public.flow_abrufe', 'SELECT')", true);
  await pruefe("Protokoll löschgeschützt (Trigger flow_abrufe_schutz)", "select count(*) from pg_trigger where not tgisinternal and tgname = 'flow_abrufe_schutz'", 1);
}

if (schritt === "app") {
  const basis = (urlArg ?? (LOKAL ? "http://localhost:3100" : LIVE_APP)).replace(/\/$/, "");
  for (const route of ["stammdaten", "personen", "stempel"]) {
    const r = await fetch(`${basis}/api/flow/${route}`, { method: "POST", headers: { "content-type": "application/jose" }, body: "a.b.c" });
    const ok = r.status === 401;
    const hinweis = r.status === 503 ? " (FLOW_ABRUF_PUBLIC_KEY fehlt?)" : r.status === 404 ? " (Code noch nicht deployt?)" : "";
    console.log(`${ok ? "OK    " : "FEHLER"} POST /api/flow/${route} mit ungültigem Ausweis → ${r.status}${hinweis}`);
    if (!ok) fehler++;
  }
}

console.log(fehler === 0 ? "\nALLES OK" : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
