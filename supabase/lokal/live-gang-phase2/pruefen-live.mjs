#!/usr/bin/env node
// Live-Gang Lohn-Umbau Phase 2 — Prüfungen auf LIVE, NUR LESEND (read-only
// Endpoint der Management API, Rolle supabase_read_only_user).
//
//   node supabase/lokal/live-gang-phase2/pruefen-live.mjs vorher
//   node supabase/lokal/live-gang-phase2/pruefen-live.mjs nach-364
//   node supabase/lokal/live-gang-phase2/pruefen-live.mjs nach-altbestand
//   … --lokal   gleiche Prüfungen gegen die lokale Test-DB (Docker)
//
// Ausgabe nur Zählungen (keine Personendaten).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const args = process.argv.slice(2);
const LOKAL = args.includes("--lokal");
const schritt = args.find((a) => !a.startsWith("--"));
if (!["vorher", "nach-364", "nach-altbestand"].includes(schritt ?? "")) {
  console.error("Aufruf: pruefen-live.mjs vorher | nach-364 | nach-altbestand [--lokal]");
  process.exit(2);
}

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const f = "C:/Users/misch/projects/_secrets/supabase-access-token.txt";
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function wert(query) {
  let rows;
  if (LOKAL) {
    const out = execFileSync("docker", ["exec", "-i", "supabase_db_eventline-fsm-lohn", "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], {
      input: `select coalesce(json_agg(t), '[]'::json) from (${query}) t;`,
    }).toString("utf8");
    rows = JSON.parse(out.trim());
  } else {
    const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 200)}`);
    rows = JSON.parse(txt);
  }
  const r = rows[0] ?? {};
  return Object.values(r)[0];
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
  const ok = typeof erwartet === "function" ? erwartet(v) : String(v) === String(erwartet);
  console.log(`${ok ? "OK    " : "FEHLER"} ${text} → ${v}`);
  if (!ok) fehler++;
}

console.log(`Prüfung «${schritt}» ${LOKAL ? "(LOKAL)" : `(Live ${LIVE_REF}, nur lesend)`}`);

if (schritt === "vorher") {
  await pruefe("Phase 1 live (lohn_lauf, rechte_antraege vorhanden)", "select to_regclass('public.lohn_lauf') is not null and to_regclass('public.rechte_antraege') is not null", true);
  await pruefe("Wartungsmodus live (Migration 363, Tabelle wartung)", "select to_regclass('public.wartung') is not null", true);
  await pruefe("Phase 2 noch nicht eingespielt (lohn_momentaufnahmen fehlt)", "select to_regclass('public.lohn_momentaufnahmen') is null", true);
  await pruefe("Firmensätze vollständig (keine leeren Sätze)", "select count(*) from public.payroll_defaults where default_ahv_iv_eo_pct is null or default_alv_pct is null or default_nbu_pct is null or default_bvg_pct is null or default_ktg_pct is null or default_quellensteuer_pct is null or default_employer_ahv_pct is null or default_employer_alv_pct is null or default_employer_fak_pct is null or default_employer_bu_pct is null or default_employer_bvg_pct is null or default_employer_verwaltung_pct is null or bvg_threshold_chf is null", 0);
  await pruefe("Firmensätze gelten seit Beginn der Lohnzeilen", "select coalesce(min(c.effective_from) >= (select min(effective_from) from public.payroll_defaults), true) from public.employee_compensation c", true);
  await pruefe("Lohnzeilen mit eigenen Sätzen, aber leerem Satz (ausser «kein Lohn»)", "select count(*) from public.employee_compensation where uses_standard_lohn = false and not coalesce(wage_exempt, false) and (ahv_iv_eo_pct is null or alv_pct is null or nbu_pct is null or bvg_pct is null or ktg_pct is null or quellensteuer_pct is null or employer_ahv_pct is null or employer_alv_pct is null or employer_fak_pct is null or employer_bu_pct is null or employer_bvg_pct is null or employer_verwaltung_pct is null)", 0);
  await pruefe("überlappende Lohnzeilen einer Person", "select count(*) from public.employee_compensation a join public.employee_compensation b on a.profile_id = b.profile_id and a.id < b.id and a.effective_from <= coalesce(b.effective_to, 'infinity'::date) and b.effective_from <= coalesce(a.effective_to, 'infinity'::date)", 0);
  await pruefe("Personen mit Lohn ohne Geburtsdatum (und ohne festen Ferienzuschlag)", "select count(distinct c.profile_id) from public.employee_compensation c join public.profiles p on p.id = c.profile_id where p.birthdate is null and c.ferienanteil_pct_override is null and not coalesce(c.wage_exempt, false)", 0);
  await pruefe("Stempel 2026 ausserhalb jeder Lohnzeile (Info: Kern meldet Fehler)", "select count(*) from public.time_entries t where t.clock_out is not null and t.clock_in >= '2026-01-01' and not exists (select 1 from public.employee_compensation c where c.profile_id = t.user_id and (t.clock_in at time zone 'Europe/Zurich')::date between c.effective_from and coalesce(c.effective_to, 'infinity'::date))", (v) => { if (Number(v) > 0) console.log("       Hinweis: diese Stempel brauchen eine Lohnzeile oder eine Anstellung, die sie ausschliesst"); return true; });
  await pruefe("Lohnabrechnungen (PDF) ohne Momentaufnahme = Altbestand", "select count(*) from public.wage_documents where doc_type = 'lohnabrechnung' and superseded_at is null", (v) => Number(v) >= 28);
}

if (schritt === "nach-364" || schritt === "nach-altbestand") {
  for (const t of ["lohn_anstellungen", "lohn_momentaufnahmen", "lohn_aenderungen", "lohn_aenderungs_antraege", "lohn_korrektur_vorschlaege"]) {
    await pruefe(`Tabelle ${t} vorhanden, Browser ohne Rechte`, `select to_regclass('public.${t}') is not null and not has_table_privilege('authenticated', 'public.${t}', 'SELECT') and not has_table_privilege('anon', 'public.${t}', 'SELECT')`, true);
  }
  await pruefe("Sicht lohn_fassungen_gueltig vorhanden", "select to_regclass('public.lohn_fassungen_gueltig') is not null", true);
  await pruefe("Sperre + Protokoll auf Lohnzeilen, Firmensätzen, Anstellungen (6 Trigger)", "select count(*) from pg_trigger where not tgisinternal and (tgname like '%lohn_sperre' or tgname like '%lohn_protokoll')", 6);
  await pruefe("RPCs vorhanden, nicht für Browser", "select count(*) filter (where not has_function_privilege('authenticated', oid, 'execute')) from pg_proc where proname in ('lohn_momentaufnahme_speichern','lohn_aenderung_ausfuehren','lohn_aenderung_direkt','lohn_operationen_anwenden')", 4);
  await pruefe("Auszahlung am 5. Arbeitstag (lohn_einstellungen)", "select auszahlung_arbeitstag from public.lohn_einstellungen where id = 'default'", 5);
  await pruefe("Sperre greift (März 2026 gesperrt)", "select public.lohn_tag_gesperrt('employee_compensation', '2026-03-15')", true);
}

if (schritt === "nach-altbestand") {
  await pruefe("jede gültige Lohnabrechnung hat eine Momentaufnahme", "select count(*) from public.wage_documents w where w.doc_type = 'lohnabrechnung' and w.superseded_at is null and w.archived_at is null and not exists (select 1 from public.lohn_momentaufnahmen m where m.wage_document_id = w.id)", 0);
  await pruefe("Altbestand: Brutto − Abzüge = Netto", "select count(*) from public.lohn_momentaufnahmen where art = 'altbestand' and abs(brutto - total_abzuege - netto) > 0.005", 0);
  await pruefe("Momentaufnahmen «altbestand» (Anzahl, Info)", "select count(*) from public.lohn_momentaufnahmen where art = 'altbestand'", (v) => Number(v) >= 28);
}

console.log(fehler === 0 ? "\nALLES OK" : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
