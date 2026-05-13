#!/usr/bin/env node
// Setup-Skript: Migration 086 anwenden + fehlende auth.users fuer Mischa+Dario
// erstellen. Mit Retry-Loop weil Supabase Management-API gerade flaky ist.

import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const SRK = env.SUPABASE_SERVICE_ROLE_KEY;
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = "uxtotpniwbwyoznwkygd";

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sql(q, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (r.status >= 500 || r.status === 403) {
        console.log(`  retry ${i + 1}/${retries} (${r.status})...`);
        await sleep(15000);
        continue;
      }
      const j = await r.json();
      if (j.message) throw new Error(j.message);
      return j;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  catch retry ${i + 1}: ${e.message}`);
      await sleep(15000);
    }
  }
}

(async () => {
  console.log("== Step 1: Migration 086 anwenden ==");
  const mig = readFileSync("supabase/migrations/086_handle_new_user_idempotent.sql", "utf-8");
  await sql(mig);
  console.log("  Migration angewendet.");

  console.log("\n== Step 2: Fehlende auth.users anlegen ==");
  const targets = await sql("select p.id, p.email, p.full_name from public.profiles p left join auth.users u on u.id = p.id where u.id is null order by p.email;");
  for (const t of targets) {
    const res = await fetch(`${URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, email: t.email, email_confirm: true, user_metadata: { full_name: t.full_name } }),
    });
    const json = await res.json();
    if (res.ok) console.log(`  + ${t.email}: angelegt`);
    else console.log(`  ! ${t.email}: ${JSON.stringify(json)}`);
  }

  console.log("\n== Verify ==");
  const after = await sql("select p.email, p.role, u.id is not null as has_auth, u.email_confirmed_at is not null as confirmed from public.profiles p left join auth.users u on u.id = p.id order by p.email;");
  for (const a of after) console.log(`  ${a.email.padEnd(35)} role=${a.role.padEnd(10)} auth=${a.has_auth} confirmed=${a.confirmed}`);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
