// Korrigiert die buggy partner_anfrage termine die als UTC interpretiert
// wurden statt als Zurich-Zeit. Zurich = UTC+2 (CEST) am 12.05.2026.
// Subtrahiert 2h von start_time/end_time damit die Zeit im UI wieder
// dem entspricht was der Partner eingegeben hat.
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

const ID = "6d5a8e97-e222-4843-8a25-bb44ad2cbb67";
console.log("Vorher:");
console.log(await sql(`select id, title, start_time, end_time from public.job_appointments where id='${ID}'`));

console.log("\nKorrigiere (start_time -= 2h, end_time -= 2h):");
console.log(await sql(`
  update public.job_appointments
  set start_time = start_time - interval '2 hours',
      end_time   = end_time   - interval '2 hours'
  where id = '${ID}'
  returning id, title, start_time, end_time
`));
