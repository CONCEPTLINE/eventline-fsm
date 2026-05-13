#!/usr/bin/env node
// One-shot data-sync script: prod -> dev (read-only on prod, insert on dev).
// Liest Reihen aus prod via Management API, baut JSONB-Insert auf dev mit
// jsonb_populate_recordset() — das casted Typen automatisch sauber.

import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#"))
  .reduce((acc, line) => {
    const eq = line.indexOf("=");
    if (eq > 0) acc[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    return acc;
  }, {});

const PAT = env.SUPABASE_ACCESS_TOKEN;
const PROD = "lyzvkoxlebecwikgsrqb";
const DEV = "uxtotpniwbwyoznwkygd";

if (!PAT) {
  console.error("SUPABASE_ACCESS_TOKEN fehlt in .env.local");
  process.exit(1);
}

async function sql(projectRef, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.message) {
    throw new Error(`SQL error on ${projectRef}: ${json.message}\nQuery: ${query.slice(0, 200)}...`);
  }
  return json;
}

// User-UUID-Remap: prod-Email -> {prod_id -> dev_id}.
// Bei Email-Konflikten zwischen prod und dev wird die prod-UUID auf die
// existierende dev-UUID gemappt (sonst klaschen unique-emails). Das
// ermoeglicht: Leo's dev-Login bleibt funktional + alle prod-Daten die
// auf prod-Leo zeigen werden auf dev-Leo umgeschrieben.
let userRemap = new Map();

async function buildUserRemap() {
  const prodProfiles = await sql(PROD, "select id, email from public.profiles;");
  const devProfiles = await sql(DEV, "select id, email from public.profiles;");
  const devByEmail = new Map(devProfiles.map((p) => [p.email, p.id]));
  for (const p of prodProfiles) {
    const devId = devByEmail.get(p.email);
    if (devId && devId !== p.id) {
      userRemap.set(p.id, devId);
      console.log(`  remap: ${p.email}  ${p.id.slice(0, 8)} -> ${devId.slice(0, 8)}`);
    }
  }
  return prodProfiles;
}

// Walkt rekursiv durch JSON, ersetzt UUIDs aus userRemap.
// String-typische Properties (created_by, user_id, etc.) sind die Felder
// die wir ersetzen — wir replacen aber jeden String der ein Mapping hat,
// um auch unbekannte FK-Felder abzudecken.
function applyRemap(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(applyRemap);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyRemap(v);
    return out;
  }
  if (typeof value === "string" && userRemap.has(value)) {
    return userRemap.get(value);
  }
  return value;
}

// FK-respecting Reihenfolge. Nur Tabellen die auf prod existieren UND
// nicht-trivial Daten haben.
const TABLES_IN_ORDER = [
  "profiles",
  "customers",
  "locations",
  "rooms",
  "room_contacts",
  "room_prices",
  "location_contacts",
  "jobs",
  "job_assignments",
  "job_appointments",
  "service_reports",
  "report_photos",
  "documents",
  "todos",
  "todo_attachments",
  "time_entries",
  "vertrieb_contacts",
  "maintenance_tasks",
  "rental_requests",
];

async function getColumns(projectRef, tableName) {
  const res = await sql(
    projectRef,
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = '${tableName}' order by ordinal_position;`
  );
  return res.map((r) => r.column_name);
}

async function syncTable(tableName) {
  let rows = await sql(PROD, `select * from public.${tableName};`);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(`  ${tableName}: 0 rows on prod, skipping`);
    return 0;
  }

  // Spezialfall profiles: drop Rows deren Email schon auf dev existiert
  // (sonst unique-key-conflict). Andere prod-User werden 1:1 angelegt.
  if (tableName === "profiles") {
    rows = rows.filter((r) => !userRemap.has(r.id));
    if (rows.length === 0) {
      console.log(`  profiles: alle prod-Profile via Email schon auf dev — skipping`);
      return 0;
    }
  } else {
    // Andere Tabellen: User-UUID-Remap auf alle Werte anwenden.
    rows = rows.map(applyRemap);
  }

  // Schema-Drift: prod hat alte job-status ('geplant', 'in_arbeit') die dev
  // nicht mehr im Constraint hat. Mappe beide auf 'offen' (Job ist aktiv,
  // nicht abgeschlossen — naheste Semantik).
  if (tableName === "jobs") {
    let mapped = 0;
    rows = rows.map((r) => {
      if (r.status === "geplant" || r.status === "in_arbeit") {
        mapped++;
        return { ...r, status: "offen" };
      }
      return r;
    });
    if (mapped > 0) console.log(`  jobs: ${mapped} status 'geplant'/'in_arbeit' -> 'offen' gemappt`);
  }

  // Spalten-Intersection: nur Felder die auf BEIDEN Seiten existieren,
  // sonst greift bei dev-only NOT-NULL-Spalten kein Default.
  const prodCols = await getColumns(PROD, tableName);
  const devCols = await getColumns(DEV, tableName);
  const prodSet = new Set(prodCols);
  const shared = devCols.filter((c) => prodSet.has(c));
  if (shared.length === 0) {
    console.log(`  ${tableName}: no shared columns, skipping`);
    return 0;
  }
  const colList = shared.map((c) => `"${c}"`).join(", ");

  // JSON-encode + escape single quotes for SQL literal
  const jsonStr = JSON.stringify(rows).replace(/'/g, "''");
  const query = `INSERT INTO public.${tableName} (${colList}) SELECT ${colList} FROM jsonb_populate_recordset(null::public.${tableName}, '${jsonStr}'::jsonb);`;
  try {
    await sql(DEV, query);
    console.log(`  ${tableName}: ${rows.length} rows synced (${shared.length} shared cols)`);
    return rows.length;
  } catch (e) {
    console.error(`  ${tableName}: FAILED — ${e.message}`);
    throw e;
  }
}

(async () => {
  console.log("Sync prod -> dev starting...");
  console.log("Building user-UUID-remap...");
  await buildUserRemap();
  console.log(`  ${userRemap.size} email-conflicts gefunden, werden remapped.`);
  let total = 0;
  for (const t of TABLES_IN_ORDER) {
    try {
      const n = await syncTable(t);
      total += n;
    } catch {
      console.error(`Aborting at ${t}.`);
      process.exit(1);
    }
  }
  console.log(`\nSync done. ${total} rows total.`);
})();
