import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});
const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = "uxtotpniwbwyoznwkygd";
const q = process.argv.slice(2).join(" ");
if (!q) { console.error("usage: node scripts/sql-once.mjs <SQL>"); process.exit(1); }
const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
if (j.message) { console.error(j.message); process.exit(1); }
console.log(JSON.stringify(j, null, 2));
