// One-off: migriere die internen Übergabe-Auftraege an Barakuba in den
// Partner-Anfragen-Flow.
//
// Selection:
//   - location_id = Barakuba
//   - is_deleted is not true
//   - status = 'offen'
//   - was_anfrage = false        (Vermietungen bleiben Firmenportal-Sache)
//   - created_by != Partner-User (test-row die schon Partner gehoert raus)
//
// Aenderung:
//   - created_by → Barakuba-Partner-User
//   - status     → 'partner_anfrage' (Partner sieht "Wartet auf EVENTLINE")
//   - accepted_at / rejected_at / partner_response_message → NULL
//
// Was BLEIBT: was_anfrage-Flag, Title, Description, Dates, Termine,
// Job-Assignments (assigned_to), Notes etc. — beim erneuten Bestaetigen
// muss nichts neu zugewiesen werden.
//
// Idempotent: Re-Run findet keine offenen Eventline-eigenen Jobs mehr
// und tut nichts.

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

const BARAKUBA_LOC = "d0219c22-458a-4bb5-99fa-e532c5a6bc4e";
const PARTNER_USER = "c5bcbcd7-7502-44e2-b7f9-61148957fb83";

console.log("--- Kandidaten (vor Migration) ---");
const candidates = await sql(`
  select id, job_number, title, status, was_anfrage, start_date, created_by
  from public.jobs
  where location_id = '${BARAKUBA_LOC}'
    and is_deleted is not true
    and status = 'offen'
    and was_anfrage = false
    and created_by <> '${PARTNER_USER}'
  order by start_date
`);
console.log(candidates);
console.log(`→ ${Array.isArray(candidates) ? candidates.length : "?"} Jobs werden migriert.`);

console.log("\n--- Migration ---");
const result = await sql(`
  update public.jobs
  set created_by = '${PARTNER_USER}',
      status = 'partner_anfrage',
      accepted_at = null,
      rejected_at = null,
      partner_response_message = null
  where location_id = '${BARAKUBA_LOC}'
    and is_deleted is not true
    and status = 'offen'
    and was_anfrage = false
    and created_by <> '${PARTNER_USER}'
  returning id, job_number, title, status, created_by
`);
console.log(result);
console.log(`→ ${Array.isArray(result) ? result.length : "?"} Rows updated.`);

console.log("\n--- Status-Verteilung nachher (Barakuba aktiv) ---");
console.log(await sql(`
  select status, count(*)::int as n
  from public.jobs
  where location_id = '${BARAKUBA_LOC}'
    and is_deleted is not true
    and status not in ('abgeschlossen', 'storniert')
  group by status
  order by status
`));
