#!/usr/bin/env node
// One-Shot: dev-Kunden mit Bexio-Kontakten verknuepfen via Name-Match.
// Refresh-Token aus dev's bexio_connection -> fresh access_token -> Bexio-
// Kontakte holen -> per Name-exact-Match (case-insensitive) zu customers
// matchen -> bexio_contact_id + bexio_nr setzen.

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
const DEV = "uxtotpniwbwyoznwkygd";
const CLIENT_ID = env.BEXIO_CLIENT_ID;
const CLIENT_SECRET = env.BEXIO_CLIENT_SECRET;
const TOKEN_URL = "https://auth.bexio.com/realms/bexio/protocol/openid-connect/token";
const API_BASE = "https://api.bexio.com";

if (!PAT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing env: SUPABASE_ACCESS_TOKEN / BEXIO_CLIENT_ID / BEXIO_CLIENT_SECRET");
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${DEV}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.message) throw new Error(`SQL error: ${json.message}`);
  return json;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token-Refresh failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function bexioFetch(token, path, init = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function normalize(s) {
  return (s || "").trim().toLowerCase();
}

(async () => {
  console.log("=== Bexio-Match dev ===");

  // 1. Token refresh
  const conn = await sql("select access_token, refresh_token, expires_at from public.bexio_connection where id = 1;");
  if (conn.length === 0) {
    console.error("Keine bexio_connection in dev. Erst per OAuth verbinden.");
    process.exit(1);
  }
  const expiresAt = new Date(conn[0].expires_at).getTime();
  let accessToken = conn[0].access_token;
  if (expiresAt - Date.now() < 60_000) {
    console.log("Token abgelaufen — refresh...");
    const fresh = await refreshAccessToken(conn[0].refresh_token);
    accessToken = fresh.access_token;
    const newExpiry = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
    await sql(`update public.bexio_connection set access_token = '${fresh.access_token}', refresh_token = '${fresh.refresh_token ?? conn[0].refresh_token}', expires_at = '${newExpiry}', updated_at = now() where id = 1;`);
    console.log("  Token erneuert.");
  } else {
    console.log("Token noch gueltig.");
  }

  // 2. Alle Bexio-Kontakte holen (paginiert)
  console.log("Hole Bexio-Kontakte...");
  const allContacts = [];
  let offset = 0;
  const LIMIT = 500;
  while (true) {
    const res = await bexioFetch(accessToken, `/2.0/contact?limit=${LIMIT}&offset=${offset}&order_by=id`);
    if (!res.ok) {
      throw new Error(`Bexio /contact failed (${res.status}): ${await res.text()}`);
    }
    const batch = await res.json();
    allContacts.push(...batch);
    console.log(`  offset=${offset}: ${batch.length} kontakte`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
  }
  console.log(`Total Bexio-Kontakte: ${allContacts.length}`);

  // 3. Index nach Name (lowercase trimmed)
  const byName = new Map();
  for (const c of allContacts) {
    const key = normalize(c.name_1);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }

  // 4. Eventline-Kunden holen
  const customers = await sql("select id, name, email, type from public.customers where archived_at is null and bexio_contact_id is null order by name;");
  console.log(`Dev-Kunden ohne Bexio-Link: ${customers.length}`);

  // 5. Match + Update
  let matched = 0;
  let ambiguous = 0;
  let none = 0;
  for (const cust of customers) {
    const key = normalize(cust.name);
    const candidates = byName.get(key) || [];
    if (candidates.length === 0) {
      // Fallback: substring match (Bexio-Name enthaelt customer-Name oder umgekehrt)
      const partial = allContacts.filter((c) => {
        const n1 = normalize(c.name_1);
        return n1 && (n1.includes(key) || key.includes(n1));
      });
      if (partial.length === 1) {
        candidates.push(partial[0]);
      } else if (partial.length > 1) {
        console.log(`  ? ${cust.name}: ${partial.length} substring-Matches — skip (ambig)`);
        ambiguous++;
        continue;
      } else {
        console.log(`  - ${cust.name}: kein Bexio-Treffer`);
        none++;
        continue;
      }
    } else if (candidates.length > 1) {
      console.log(`  ? ${cust.name}: ${candidates.length} exact-Matches — skip (ambig)`);
      ambiguous++;
      continue;
    }
    const bx = candidates[0];
    const nr = bx.nr ? String(bx.nr).replace(/'/g, "''") : null;
    const updateSql = `update public.customers set bexio_contact_id = '${bx.id}', bexio_nr = ${nr ? `'${nr}'` : "null"} where id = '${cust.id}';`;
    await sql(updateSql);
    console.log(`  + ${cust.name} -> Bexio #${bx.id}${bx.nr ? ` (Nr ${bx.nr})` : " (keine Nr)"}`);
    matched++;
  }

  console.log(`\n=== Done ===`);
  console.log(`Matched: ${matched}`);
  console.log(`Ambig:   ${ambiguous}`);
  console.log(`None:    ${none}`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
