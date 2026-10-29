// Notweg Rechte-Anträge (Lohn-Umbau Phase 1, Vier Augen bei Rechten) — NUR für
// Mischa, wenn kein zweiter Admin einen Antrag bestätigen kann.
//
//   node scripts/rechte-notfreigabe.mjs                              offene Anträge anzeigen
//   node scripts/rechte-notfreigabe.mjs <antrag-id> "<Grund>" "<Name>"  bestätigen
//
// Führt den Antrag über die DB-Funktion public.rechte_antrag_ausfuehren aus
// (Migration 361, nur service_role) und schreibt «rechte.antrag_notweg» mit
// Grund und Name ins Rechte-Protokoll. Reaktivierte Konten bekommen ihren Login
// zurück (Auth-Sperre aufheben). Liest .env.local (NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY) — Werte werden nie ausgegeben.

import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt (.env.local)");
  process.exit(1);
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const [id, grund, durch] = process.argv.slice(2);

if (!id) {
  const res = await fetch(`${URL}/rest/v1/rechte_antraege?status=eq.offen&select=id,beschreibung,beantragt_von_name,beantragt_at,gueltig_bis&order=beantragt_at.desc`, { headers });
  if (!res.ok) {
    console.error("Laden fehlgeschlagen:", res.status, await res.text());
    process.exit(1);
  }
  const rows = await res.json();
  if (rows.length === 0) console.log("Keine offenen Anträge.");
  for (const r of rows) {
    const bis = new Date(r.gueltig_bis).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
    console.log(`${r.id}  ${r.beschreibung}  (von ${r.beantragt_von_name ?? "?"}, gültig bis ${bis})`);
  }
  console.log('\nBestätigen: node scripts/rechte-notfreigabe.mjs <id> "<Grund>" "<Name>"');
  process.exit(0);
}
if (!grund || !durch) {
  console.error('Grund und Name sind Pflicht: node scripts/rechte-notfreigabe.mjs <id> "<Grund>" "<Name>"');
  process.exit(1);
}

const res = await fetch(`${URL}/rest/v1/rpc/rechte_antrag_ausfuehren`, {
  method: "POST",
  headers,
  body: JSON.stringify({ p_id: id, p_bestaetiger: null, p_bestaetiger_name: durch, p_notweg_grund: grund }),
});
const text = await res.text();
if (!res.ok) {
  console.error("Notweg fehlgeschlagen:", res.status, text);
  process.exit(1);
}
const r = JSON.parse(text);
if (r.art === "person" && r.payload?.aktivieren === true && r.ziel_profile_id) {
  const ban = await fetch(`${URL}/auth/v1/admin/users/${r.ziel_profile_id}`, { method: "PUT", headers, body: JSON.stringify({ ban_duration: "none" }) });
  if (!ban.ok) console.error("Achtung: Login-Sperre nicht aufgehoben:", ban.status, await ban.text());
}
console.log(`Bestätigt per Notweg (${r.art}) — protokolliert (rechte.antrag_notweg).`);
