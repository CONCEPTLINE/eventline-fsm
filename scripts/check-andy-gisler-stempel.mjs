import fs from "node:fs";

const envText = fs.readFileSync(".env.local", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

const job = await sql(`SELECT id, job_number, title FROM jobs WHERE job_number = 26283 LIMIT 1`);
console.log("JOB:", job);
const jobId = job[0]?.id;
if (!jobId) process.exit(0);

const te = await sql(`
  SELECT te.id, te.user_id, p.full_name, te.clock_in, te.clock_out, te.description,
    EXTRACT(EPOCH FROM (te.clock_out - te.clock_in))/60 AS minutes
  FROM time_entries te
  LEFT JOIN profiles p ON p.id = te.user_id
  WHERE te.job_id = '${jobId}'
  ORDER BY te.user_id, te.clock_in
`);
console.log("\nTIME_ENTRIES (alle):");
for (const t of te) {
  console.log(`  ${t.full_name} | ${t.clock_in} → ${t.clock_out} | ${Math.round(t.minutes)}min | ${t.description ?? ""}`);
}

const sr = await sql(`
  SELECT id, status, time_ranges FROM service_reports WHERE job_id = '${jobId}' ORDER BY created_at
`);
console.log("\nSERVICE_REPORTS:");
for (const r of sr) {
  console.log(`  report ${r.id} (${r.status})`);
  for (const tr of (r.time_ranges ?? [])) {
    console.log(`    range: ${tr.date} ${tr.start}-${tr.end} pause=${tr.pause} tech=${tr.technician_id} not_billable=${tr.not_billable} reason=${tr.not_billable_reason ?? ''}`);
  }
}
