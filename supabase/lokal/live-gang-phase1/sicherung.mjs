#!/usr/bin/env node
// Sicherung VOR dem Live-Gang Phase 1 (nur LESEND, Standardformate CSV + SQL).
//
// Liest auf Live über den read-only Endpoint der Management API (Rolle
// supabase_read_only_user, kann nichts schreiben) und legt ab:
//   <ziel>/tabellen/<tabelle>.csv        Daten der betroffenen Tabellen
//   <ziel>/storage-objekte.csv           Dateiliste lohndokumente + personal-dossiers
//   <ziel>/policies.sql                  CREATE POLICY der betroffenen Tabellen (Ist-Stand)
//   <ziel>/rechte.csv                    Tabellen- und Funktionsrechte (Ist-Stand)
//   <ziel>/funktionen.sql                Definitionen get_monthly_payroll_stats, _test_payroll, …
//   <ziel>/constraints.sql               permission_audit_log_action_check, wage_doc_unique_per_period
//   <ziel>/LIESMICH.txt                  Zeitpunkt, Zeilenzahlen
//
// Die PDFs selbst ändert Phase 1 nicht (nichts wird überschrieben oder gelöscht);
// die 28 Alt-PDFs sind am 28.10. gesichert. Wer die Dateien zusätzlich sichern
// will: Supabase-Dashboard bzw. scripts/… (nicht Teil dieser Sicherung).
//
// Aufruf: node supabase/lokal/live-gang-phase1/sicherung.mjs [zielordner]
//         node supabase/lokal/live-gang-phase1/sicherung.mjs --lokal [zielordner]
//           (Probe gegen die LOKALE Test-DB im Docker-Container, ohne Live-Zugriff)
//   Standard-Ziel: C:\Users\misch\projects\_lohn-korrektur\sicherung\<YYYY-MM-DD>-phase1
// Token: SUPABASE_ACCESS_TOKEN oder C:\Users\misch\projects\_secrets\supabase-access-token.txt
// (nur diese Datei, Wert wird nie ausgegeben).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const args = process.argv.slice(2);
const LOKAL = args[0] === "--lokal";
if (LOKAL) args.shift();
const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
const ziel = args[0] ?? `C:/Users/misch/projects/_lohn-korrektur/sicherung/${heute}-phase1`;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const f = "C:/Users/misch/projects/_secrets/supabase-access-token.txt";
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function lesen(query) {
  if (LOKAL) {
    const out = execFileSync("docker", ["exec", "-i", "supabase_db_eventline-fsm-lohn", "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], {
      input: `select coalesce(json_agg(t), '[]'::json) from (${query.trim().replace(/;\s*$/, "")}) t;`,
      maxBuffer: 256 * 1024 * 1024,
    }).toString("utf8");
    return JSON.parse(out.trim());
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Live-Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

function csv(rows) {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

fs.mkdirSync(path.join(ziel, "tabellen"), { recursive: true });
const zahlen = [];

// Tabellen (Lohn-Objekte, die Phase 1 mit Triggern/Rechten belegt).
// trusted_devices ohne Token-Hashes (für den Rückweg nicht nötig).
const tabellen = {
  wage_documents: "select * from public.wage_documents order by profile_id, year, period_month",
  employee_compensation: "select * from public.employee_compensation order by profile_id, effective_from",
  payroll_defaults: "select * from public.payroll_defaults order by effective_from",
  time_off: "select * from public.time_off order by user_id, start_date",
  trusted_devices: "select id, user_id, device_name, user_agent_hint, status, requested_at, approved_at, approved_by_email, last_seen_at, expires_at, revoked_at from public.trusted_devices order by requested_at",
  permission_audit_log: "select * from public.permission_audit_log order by occurred_at",
  time_entries_zaehlung: "select user_id, date_trunc('month', clock_in at time zone 'Europe/Zurich')::date as monat, count(*) as anzahl from public.time_entries group by 1, 2 order by 1, 2",
};
for (const [name, q] of Object.entries(tabellen)) {
  const rows = await lesen(q);
  fs.writeFileSync(path.join(ziel, "tabellen", `${name}.csv`), csv(rows));
  zahlen.push(`${name}: ${rows.length} Zeilen`);
}

const objekte = await lesen("select bucket_id, name, created_at, updated_at, metadata->>'size' as groesse from storage.objects where bucket_id in ('lohndokumente','personal-dossiers') order by bucket_id, name");
fs.writeFileSync(path.join(ziel, "storage-objekte.csv"), csv(objekte));
zahlen.push(`storage.objects (lohndokumente, personal-dossiers): ${objekte.length}`);

const policies = await lesen(`
  select tablename, policyname, cmd, roles::text as roles, qual, with_check, permissive
    from pg_policies
   where schemaname = 'public'
     and tablename in ('employee_compensation','payroll_defaults','wage_documents','trusted_devices','time_off','time_entries','permission_audit_log')
   order by tablename, policyname`);
const policySql = policies.map((p) => {
  const rollen = String(p.roles).replace(/[{}]/g, "").split(",").filter(Boolean).join(", ");
  return [
    `drop policy if exists "${p.policyname}" on public.${p.tablename};`,
    `create policy "${p.policyname}" on public.${p.tablename} as ${String(p.permissive).toLowerCase()} for ${String(p.cmd).toLowerCase()}`,
    rollen && rollen !== "public" ? `  to ${rollen}` : "",
    p.qual ? `  using (${p.qual})` : "",
    p.with_check ? `  with check (${p.with_check})` : "",
  ].filter(Boolean).join("\n") + ";";
}).join("\n\n");
fs.writeFileSync(path.join(ziel, "policies.sql"), `-- Policies Live, Stand ${new Date().toISOString()}\n\n${policySql}\n`);
zahlen.push(`Policies: ${policies.length}`);

const rechte = await lesen(`
  select 'table' as art, table_name as objekt, grantee, privilege_type
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon','authenticated','service_role','public')
     and table_name in ('employee_compensation','payroll_defaults','wage_documents','trusted_devices')
  union all
  select 'function', p.oid::regprocedure::text, coalesce(r.rolname, 'public'), a.privilege_type
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where p.proname in ('get_monthly_payroll_stats','get_current_bvg_threshold','get_location_stats','get_my_wage_consent','get_my_compensation','_test_payroll','is_trusted_device')
  order by 1, 2, 3`);
fs.writeFileSync(path.join(ziel, "rechte.csv"), csv(rechte));

const funktionen = await lesen(`
  select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where p.proname in ('get_monthly_payroll_stats','get_current_bvg_threshold','get_location_stats','get_my_wage_consent','_test_payroll','is_trusted_device','is_time_entry_locked')`);
fs.writeFileSync(path.join(ziel, "funktionen.sql"), funktionen.map((f) => `-- ${f.name}\n${f.def};\n`).join("\n"));

const constraints = await lesen(`
  select conrelid::regclass::text as tabelle, conname, pg_get_constraintdef(oid) as def
    from pg_constraint
   where conname in ('permission_audit_log_action_check','wage_doc_unique_per_period')`);
fs.writeFileSync(path.join(ziel, "constraints.sql"), constraints.map((c) => `-- ${c.tabelle}\nalter table ${c.tabelle} add constraint ${c.conname} ${c.def};`).join("\n") + "\n");

fs.writeFileSync(
  path.join(ziel, "LIESMICH.txt"),
  `Sicherung vor Live-Gang Lohn-Umbau Phase 1\nZeitpunkt: ${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}\nQuelle: Live ${LIVE_REF} (nur gelesen)\n\n${zahlen.join("\n")}\n`,
);
console.log(`Sicherung abgelegt: ${ziel}`);
for (const z of zahlen) console.log(`  ${z}`);
