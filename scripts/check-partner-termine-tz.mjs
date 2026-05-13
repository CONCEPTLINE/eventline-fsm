// Prüft job_appointments die zu partner_anfrage gehören und prüft ob start_time
// ohne TZ-Suffix als UTC interpretiert wurde (alte buggy Inserts).
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
  return r.json();
}

console.log("Alle Termine von Partner-Anfrage Jobs (egal welcher Status):");
console.log(await sql(`
  select ja.id, ja.job_id, ja.title, ja.start_time, ja.end_time, ja.created_at, j.status, j.title as job_title
  from public.job_appointments ja
  join public.jobs j on j.id = ja.job_id
  where j.created_by in (select id from auth.users where raw_user_meta_data->>'role' = 'partner')
     or j.status = 'partner_anfrage'
     or j.accepted_at is not null
  order by ja.created_at desc
  limit 20
`));
