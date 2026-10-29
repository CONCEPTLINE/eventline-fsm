#!/usr/bin/env node
// Prüfungen für den Live-Gang Phase 1 — NUR LESEND (read-only Endpoint der
// Management API, Rolle supabase_read_only_user). Gibt je Prüfung OK/FEHLER aus,
// keine Personendaten, keine Beträge.
//
//   node supabase/lokal/live-gang-phase1/pruefen-live.mjs vorher
//   node supabase/lokal/live-gang-phase1/pruefen-live.mjs nach-360-361
//   node supabase/lokal/live-gang-phase1/pruefen-live.mjs nach-362
//   … --lokal  (gleiche Prüfungen gegen die lokale Test-DB, ohne Live-Zugriff)
//
// Token: SUPABASE_ACCESS_TOKEN oder C:\Users\misch\projects\_secrets\supabase-access-token.txt.
// Exit-Code 0 = alle Prüfungen OK.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const args = process.argv.slice(2);
const LOKAL = args.includes("--lokal");
const schritt = args.find((a) => !a.startsWith("--"));
if (!["vorher", "nach-360-361", "nach-362"].includes(schritt ?? "")) {
  console.error("Aufruf: pruefen-live.mjs vorher | nach-360-361 | nach-362 [--lokal]");
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
  await pruefe("Profile mit is_active = NULL (muss 0 sein)", "select count(*) from public.profiles where is_active is null", 0);
  await pruefe("aktive Admins (mind. 2 für Vier Augen, sonst Notweg)", "select count(*) from public.profiles where role = 'admin' and is_active", (v) => Number(v) >= 2);
  await pruefe("aktive Admins ohne freigegebenes Gerät (0 = jeder kann bestätigen)", "select count(*) from public.profiles p where p.role = 'admin' and p.is_active and not exists (select 1 from public.trusted_devices d where d.user_id = p.id and d.status = 'approved' and d.revoked_at is null and (d.expires_at is null or d.expires_at > now()))", (v) => { if (Number(v) > 0) console.log("       Hinweis: diese Admins brauchen nach dem Deploy eine Freigabe durch den anderen Admin oder den Notweg"); return true; });
  await pruefe("Rollen mit Lohnrecht (ausser admin, nur Info)", "select coalesce(string_agg(slug, ', '), '—') from public.roles where permissions ? 'lohn:manage' and slug <> 'admin'", () => true);
  await pruefe("Phase 1 noch nicht eingespielt (lohn_lauf fehlt)", "select to_regclass('public.lohn_lauf') is null", true);
  await pruefe("Einmaligkeits-Regel wage_doc_unique_per_period vorhanden", "select count(*) from pg_constraint where conname = 'wage_doc_unique_per_period'", 1);
}

if (schritt === "nach-360-361" || schritt === "nach-362") {
  for (const t of ["lohn_dokument_protokoll", "lohn_lauf", "lohn_einstellungen", "lohn_dossiers", "rechte_antraege"]) {
    await pruefe(`Tabelle ${t} vorhanden`, `select to_regclass('public.${t}') is not null`, true);
  }
  await pruefe("Schutz-Trigger (12 aus 360 + 5 aus 361)", "select count(*) from pg_trigger where not tgisinternal and (tgname like '%lohn_schutz%' or tgname like '%rechte_schutz%')", 17);
  await pruefe("lauf_ab = 2026-10-01", "select lauf_ab::text from public.lohn_einstellungen where id = 'default'", "2026-10-01");
  await pruefe("Vertretung leer (Entscheid 29.10.)", "select coalesce(vertretung_profile_id::text, 'leer') from public.lohn_einstellungen where id = 'default'", "leer");
  await pruefe("RPCs vorhanden", "select count(*) from pg_proc where proname in ('lohn_fassung_speichern','lohn_dokument_archivieren','lohn_dokument_wiederherstellen','lohn_lauf_starten','geraet_notfreigabe','rechte_antrag_ausfuehren')", 6);
  await pruefe("RPCs nicht für Browser ausführbar", "select count(*) from pg_proc where proname in ('lohn_fassung_speichern','rechte_antrag_ausfuehren','geraet_notfreigabe') and has_function_privilege('authenticated', oid, 'execute')", 0);
  await pruefe("Browser ohne Rechte auf trusted_devices", "select has_table_privilege('authenticated', 'public.trusted_devices', 'SELECT') or has_table_privilege('authenticated', 'public.trusted_devices', 'UPDATE')", false);
  await pruefe("get_monthly_payroll_stats lässt den Server zu", "select position('service_role' in pg_get_functiondef('public.get_monthly_payroll_stats(date)'::regprocedure)) > 0", true);
  await pruefe("Rechte-Protokoll kennt die neuen Aktionen", "select position('rechte.antrag_notweg' in pg_get_constraintdef(oid)) > 0 from pg_constraint where conname = 'permission_audit_log_action_check'", true);
  await pruefe("bestehende Gerätefreigaben unverändert gültig (mail_link)", "select count(*) from public.trusted_devices where status = 'approved' and freigabe_art is null", 0);
}

if (schritt === "nach-360-361") {
  await pruefe("Browser liest Lohnzeilen noch (362 noch nicht eingespielt)", "select has_table_privilege('authenticated', 'public.employee_compensation', 'SELECT')", true);
}

if (schritt === "nach-362") {
  await pruefe("keine Policies mehr auf Lohnzeilen/Firmensätzen/Lohndokumenten", "select count(*) from pg_policies where schemaname = 'public' and tablename in ('employee_compensation','payroll_defaults','wage_documents')", 0);
  for (const t of ["employee_compensation", "payroll_defaults", "wage_documents"]) {
    await pruefe(`Browser ohne Rechte auf ${t}`, `select has_table_privilege('authenticated', 'public.${t}', 'SELECT') or has_table_privilege('anon', 'public.${t}', 'SELECT')`, false);
  }
  await pruefe("Lohnstatistik-Funktionen nicht für Browser", "select count(*) from pg_proc where proname in ('get_monthly_payroll_stats','get_current_bvg_threshold','get_location_stats') and has_function_privilege('authenticated', oid, 'execute')", 0);
  await pruefe("Testfunktion _test_payroll entfernt", "select to_regprocedure('public._test_payroll()') is null", true);
  await pruefe("eigene Einwilligung weiter lesbar (get_my_wage_consent)", "select has_function_privilege('authenticated', 'public.get_my_wage_consent()', 'execute')", true);
}

console.log(fehler === 0 ? "\nALLES OK" : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
