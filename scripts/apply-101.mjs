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
const q = readFileSync("supabase/migrations/101_partner_active_collab.sql", "utf-8");
await sql(q);
console.log("101 applied");

console.log("--- documents policies ---");
console.log(await sql("select polname, polcmd from pg_policy where polrelid='public.documents'::regclass and polname like '%partner%' order by polname"));

console.log("--- partner_update_notes Function ---");
console.log(await sql("select proname, pg_get_function_arguments(oid) as args from pg_proc where proname='partner_update_notes'"));
