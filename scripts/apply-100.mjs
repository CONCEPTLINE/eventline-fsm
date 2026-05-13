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
const q = readFileSync("supabase/migrations/100_rename_partners_to_lieferanten.sql", "utf-8");
await sql(q);
console.log("100 applied");

console.log("--- lieferanten existiert? partners weg? ---");
console.log(await sql("select tablename from pg_tables where schemaname='public' and tablename in ('partners','lieferanten')"));

console.log("--- RLS Policies auf lieferanten ---");
console.log(await sql("select polname from pg_policy where polrelid='public.lieferanten'::regclass order by polname"));

console.log("--- Indexes auf lieferanten ---");
console.log(await sql("select indexname from pg_indexes where schemaname='public' and tablename='lieferanten' order by indexname"));

console.log("--- Rollen-Permissions (partner:* sollte weg, lieferanten:* da sein) ---");
console.log(await sql("select slug, permissions from public.roles where slug in ('admin','team-leiter','techniker','partner') order by slug"));
