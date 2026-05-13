// Loescht den 'Partner-Test admin'-User komplett: Auth + Profil + alle
// von ihm erstellten Anfragen (jobs mit status='partner_anfrage' + created_by).
import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});
const PAT = env.SUPABASE_ACCESS_TOKEN;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const REF = "uxtotpniwbwyoznwkygd";
const USER_ID = "b72cdd1f-fa81-484b-b0f9-85db0a8082de";

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

// 1. Schauen welche Anfragen er erstellt hat
console.log("== Vom Partner-Test erstellte Jobs ==");
const jobs = await sql(`select id, status, title, created_at from public.jobs where created_by='${USER_ID}'`);
console.log(jobs);

// 2. Termine zuerst loeschen, dann Jobs
if (jobs.length > 0) {
  await sql(`delete from public.job_appointments where job_id in (select id from public.jobs where created_by='${USER_ID}')`);
  await sql(`delete from public.jobs where created_by='${USER_ID}'`);
  console.log(`  ${jobs.length} Job(s) inkl. Termine geloescht`);
}

// 3. Profile loeschen
await sql(`delete from public.profiles where id='${USER_ID}'`);
console.log("  profiles-Row geloescht");

// 4. Auth-User loeschen
const r = await fetch(`${SUPA_URL}/auth/v1/admin/users/${USER_ID}`, {
  method: "DELETE",
  headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
});
console.log(`  auth.users DELETE -> status ${r.status}`);

// 5. Verify
const v = await sql(`select count(*)::int as c from public.profiles where id='${USER_ID}'`);
console.log("Verify (sollte 0 sein):", v);
