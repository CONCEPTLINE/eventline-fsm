// Loescht den Vermietentwurf "Test" (INT-26249) komplett: zugehoerige
// Termine, Dokumente (DB-Rows + Storage), und den Job selbst.
import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});
const PAT = env.SUPABASE_ACCESS_TOKEN;
const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const REF = "uxtotpniwbwyoznwkygd";
const JOB_ID = "109c4b13-5ee3-4475-a6f2-ea3c1e2dceaa";

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

console.log("== Dokumente am Job ==");
const docs = await sql(`select id, name, storage_path from public.documents where job_id='${JOB_ID}'`);
console.log(docs);

if (docs.length > 0) {
  // Storage-Files via Service-Role-Endpoint loeschen (kein Direct-SQL fuer Storage)
  const paths = docs.map(d => d.storage_path);
  const r = await fetch(`${SUPA_URL}/storage/v1/object/documents`, {
    method: "DELETE",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths }),
  });
  console.log(`  Storage-Delete -> status ${r.status}`);
}

await sql(`delete from public.documents where job_id='${JOB_ID}'`);
console.log("  documents-Rows geloescht");

await sql(`delete from public.job_appointments where job_id='${JOB_ID}'`);
console.log("  job_appointments geloescht");

await sql(`delete from public.job_assignments where job_id='${JOB_ID}'`);
console.log("  job_assignments geloescht");

await sql(`delete from public.jobs where id='${JOB_ID}'`);
console.log("  Job geloescht");

const v = await sql(`select count(*)::int as c from public.jobs where id='${JOB_ID}'`);
console.log("Verify (sollte 0 sein):", v);
