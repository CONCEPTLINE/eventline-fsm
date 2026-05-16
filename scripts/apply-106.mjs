import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});
const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = "uxtotpniwbwyoznwkygd";
async function sql(q) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.message) throw new Error(j.message);
  return j;
}
const q = readFileSync("supabase/migrations/106_service_reports_visibility_and_dedup.sql", "utf-8");
await sql(q);
console.log("106 applied");

console.log("\n--- Aktualisierte SELECT-Policy ---");
console.log(await sql("select polname, pg_get_expr(polqual, polrelid) as using_expr from pg_policy where polrelid='public.service_reports'::regclass and polcmd='r'"));

console.log("\n--- Trigger registriert? ---");
console.log(await sql("select tgname from pg_trigger where tgrelid='public.service_reports'::regclass and tgname like 'prevent%'"));

console.log("\n--- Smoke-Test: bestehende Duplikate sind unberuehrt ---");
console.log(await sql("select count(*) as dup_jobs from (select job_id, count(*) c from service_reports where status='abgeschlossen' group by job_id having count(*) > 1) s"));
