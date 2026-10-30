#!/usr/bin/env node
// Live-Gang Schnittstelle Trust flow (Migration 369) — Prüfungen auf LIVE, NUR LESEND.
//
//   node supabase/lokal/live-gang-flow/pruefen-live.mjs vorher             (Phase 4 live, vor 369)
//   node supabase/lokal/live-gang-flow/pruefen-live.mjs nachher            (nach 369)
//   node supabase/lokal/live-gang-flow/pruefen-live.mjs app [<url>]        (nach Deploy + Env: Routen da, Schlüssel gesetzt)
//   … --lokal   Datenbank-Prüfungen gegen die lokale Test-DB (Docker), app gegen http://localhost:3100
//
// Lesen über den read-only-Endpunkt der Management API (Token aus
// _secrets/supabase-access-token.txt oder SUPABASE_ACCESS_TOKEN). Ausgabe nur
// Zählungen und Ja/Nein (keine Namen, keine Beträge). «app» schickt nur einen
// ungültigen Ausweis («a.b.c»): 401 = Schlüssel gesetzt und Route da, 503 = Schlüssel fehlt.

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

console.log(`Prüfung «${schritt}» ${LOKAL ? "(LOKAL)" : `(Live ${LIVE_REF}, nur lesend)`}`);

if (schritt === "vorher") {
  await pruefe("Phase 4 live: lauf_bis = November 2026", "select lauf_bis from public.lohn_einstellungen where id = 'default'", "2026-11-01");
  await pruefe("Phase 4 live: lohn_dokument_zustellung vorhanden", "select to_regclass('public.lohn_dokument_zustellung') is not null", true);
  await pruefe("369 noch nicht eingespielt (flow_abrufe fehlt)", "select to_regclass('public.flow_abrufe') is null", true);
  await pruefe("Regel wage_documents_source_check vorhanden (369 erweitert sie um «bexio»)", "select count(*) from pg_constraint where conname = 'wage_documents_source_check' and conrelid = 'public.wage_documents'::regclass", 1);
  await pruefe("noch keine Lohndokumente mit Quelle ausser manual/auto", "select count(*) from public.wage_documents where source not in ('manual', 'auto')", 0);
}

if (schritt === "nachher") {
  for (const t of ["flow_abrufe", "lohn_bexio_fassungen"]) {
    await pruefe(`Tabelle ${t}: RLS an, Browser ohne Rechte`,
      `select to_regclass('public.${t}') is not null and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.${t}'::regclass) and not has_table_privilege('authenticated', 'public.${t}', 'SELECT') and not has_table_privilege('anon', 'public.${t}', 'SELECT')`, true);
  }
  await pruefe("Funktionen nur für den Server (nicht authenticated/anon)",
    "select count(*) filter (where has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute')) from pg_proc where proname in ('flow_abruf_beginnen','flow_abruf_abschliessen','lohn_bexio_fassung_speichern','lohn_fassung_speichern')", 0);
  await pruefe("Funktionen vorhanden", "select count(distinct proname) from pg_proc where proname in ('flow_abruf_beginnen','flow_abruf_abschliessen','lohn_bexio_fassung_speichern')", 3);
  await pruefe("Quelle «bexio» erlaubt", "select pg_get_constraintdef(oid) like '%bexio%' from pg_constraint where conname = 'wage_documents_source_check'", true);
  await pruefe("lohn_fassung_speichern nimmt «bexio» an", "select prosrc like '%''manual'', ''auto'', ''bexio''%' from pg_proc where proname = 'lohn_fassung_speichern'", true);
  await pruefe("Protokoll löschgeschützt (Trigger)", "select count(*) from pg_trigger where not tgisinternal and tgname in ('flow_abrufe_schutz','lohn_bexio_fassungen_lohn_schutz')", 2);
  await pruefe("Einmal-Schutz (jti) als eindeutiger Index", "select count(*) from pg_indexes where indexname = 'flow_abrufe_jti_einmal'", 1);
  await pruefe("lauf_bis unverändert November 2026", "select lauf_bis from public.lohn_einstellungen where id = 'default'", "2026-11-01");
}

if (schritt === "app") {
  const basis = (urlArg ?? (LOKAL ? "http://localhost:3100" : LIVE_APP)).replace(/\/$/, "");
  for (const route of ["stempel", "personen", "vergleich"]) {
    const r = await fetch(`${basis}/api/flow/${route}`, { method: "POST", headers: { "content-type": "application/jose" }, body: "a.b.c" });
    const ok = r.status === 401;
    console.log(`${ok ? "OK    " : "FEHLER"} POST /api/flow/${route} mit ungültigem Ausweis → ${r.status}${r.status === 503 ? " (FLOW_ABRUF_PUBLIC_KEY fehlt?)" : ""}`);
    if (!ok) fehler++;
  }
  const r = await fetch(`${basis}/api/flow/lohnabrechnung`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ausweis: "a.b.c", pdf_base64: "" }) });
  console.log(`${r.status === 401 ? "OK    " : "FEHLER"} POST /api/flow/lohnabrechnung mit ungültigem Ausweis → ${r.status}`);
  if (r.status !== 401) fehler++;
}

console.log(fehler === 0 ? "\nALLES OK" : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
