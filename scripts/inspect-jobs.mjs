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
console.log("Status-Verteilung:");
console.log(await sql("select status, count(*)::int from public.jobs where is_deleted is not true group by status order by status"));
console.log("\nPartner-Anfragen:");
console.log(await sql("select id, job_number, title, status, location_id, customer_id, created_at from public.jobs where status='partner_anfrage' order by created_at desc limit 10"));
