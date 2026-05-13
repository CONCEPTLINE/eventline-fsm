// One-shot: applies Migrations 094 + 095 auf Live-Prod (Zurich,
// REF=uxtotpniwbwyoznwkygd) via Supabase Management-API.

import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = "uxtotpniwbwyoznwkygd";
if (!PAT) { console.error("SUPABASE_ACCESS_TOKEN fehlt in .env.local"); process.exit(1); }

async function sql(q, label, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (r.status >= 500 || r.status === 403) {
        console.log(`  ${label} retry ${i + 1}/${retries} (${r.status})`);
        await new Promise(rs => setTimeout(rs, 10000));
        continue;
      }
      const j = await r.json();
      if (j.message) throw new Error(j.message);
      return j;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  ${label} catch ${i + 1}: ${e.message}`);
      await new Promise(rs => setTimeout(rs, 10000));
    }
  }
}

const migrations = [
  "supabase/migrations/094_drop_legacy_tickets_policies.sql",
  "supabase/migrations/095_scaling_indices_2.sql",
];

for (const path of migrations) {
  console.log(`\n== Applying ${path} ==`);
  const q = readFileSync(path, "utf-8");
  await sql(q, path);
  console.log(`  OK`);
}

console.log("\n== Verify: tickets-Policies aktuell ==");
const policies = await sql(
  "select polname from pg_policy where polrelid = 'public.tickets'::regclass order by polname;",
  "verify-policies",
);
console.log(policies);

console.log("\n== Verify: neue Indexes ==");
const idx = await sql(
  "select indexname from pg_indexes where schemaname='public' and indexname in ('jobs_project_lead_idx','job_appointments_assigned_to_idx','notifications_created_at_idx') order by indexname;",
  "verify-idx",
);
console.log(idx);
