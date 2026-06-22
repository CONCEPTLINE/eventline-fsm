// Entfernt die doppelten Auto-Stempel-Eintraege bei INT-26283.
// Hintergrund: Vor dem Fix hat auto-stempel/route.ts auch dann gestempelt
// wenn der User real schon einen time_entry hatte (Idempotency-Check ging
// nur ueber identischen clock_in, nicht ueber Kalendertag). Hier loeschen
// wir die ueberzaehligen Auto-Stempel-Eintraege wieder.

import fs from "node:fs";

const envText = fs.readFileSync(".env.local", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ACCESS = process.env.SUPABASE_ACCESS_TOKEN;
const ref = URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];

async function sql(q) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const t = await r.text();
  if (!r.ok) { console.error(t); process.exit(1); }
  return JSON.parse(t);
}

// Nur Eintraege loeschen, die in Auto-Stempel-Konflikt mit echtem Stempel
// am gleichen Kalendertag stehen.
const job = await sql(`SELECT id FROM jobs WHERE job_number = 26283`);
const jobId = job[0].id;

const dupes = await sql(`
  SELECT te.id, te.user_id, p.full_name, te.clock_in, te.clock_out, te.description
  FROM time_entries te
  LEFT JOIN profiles p ON p.id = te.user_id
  WHERE te.job_id = '${jobId}'
    AND te.description LIKE 'Auto-Stempel aus Rapport%'
    AND EXISTS (
      SELECT 1 FROM time_entries te2
      WHERE te2.job_id = te.job_id
        AND te2.user_id = te.user_id
        AND te2.id <> te.id
        AND (te2.description IS NULL OR te2.description NOT LIKE 'Auto-Stempel aus Rapport%')
        AND DATE(te2.clock_in AT TIME ZONE 'Europe/Zurich') = DATE(te.clock_in AT TIME ZONE 'Europe/Zurich')
    )
  ORDER BY te.user_id, te.clock_in
`);

console.log(`Gefundene Duplikat-Auto-Stempel (${dupes.length}):`);
for (const d of dupes) {
  console.log(`  - ${d.full_name} | ${d.clock_in} → ${d.clock_out}`);
}

if (dupes.length === 0) {
  console.log("Nichts zu loeschen.");
  process.exit(0);
}

const ids = dupes.map(d => `'${d.id}'`).join(",");
const del = await sql(`DELETE FROM time_entries WHERE id IN (${ids}) RETURNING id`);
console.log(`\nGeloescht: ${del.length} Eintraege.`);
