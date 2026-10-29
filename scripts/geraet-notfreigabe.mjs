// Notweg Gerätefreigabe (Lohn-Umbau Phase 1) — NUR für Mischa, wenn kein
// anderer Admin und keine Vertretung ein Gerät freigeben kann (z. B. beide
// Admins haben ihr vertrautes Gerät verloren).
//
// Ablauf:
//   1. Die Person fragt das Gerät in der App an (Finanzen oder Lohn › Team →
//      «Freigabe anfragen»). Dadurch gibt es eine offene Anfrage + Cookie.
//   2. Mischa listet die offenen Anfragen:
//        node scripts/geraet-notfreigabe.mjs
//   3. Mischa gibt mit Grund frei:
//        node scripts/geraet-notfreigabe.mjs <geraet-id> "<Grund>" "<Name>"
//
// Die Freigabe läuft über die DB-Funktion public.geraet_notfreigabe
// (Migration 360, nur service_role). Sie schreibt einen Eintrag
// «device.notfreigabe» mit Grund und Name ins Rechte-Protokoll
// (Einstellungen › Rechte-Protokoll). Liest .env.local
// (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) — nie ausgeben.

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
  const res = await fetch(
    `${URL}/rest/v1/trusted_devices?status=eq.pending&revoked_at=is.null&select=id,device_name,requested_at,user:profiles!user_id(full_name,email)&order=requested_at.desc`,
    { headers },
  );
  if (!res.ok) {
    console.error("Laden fehlgeschlagen:", res.status, await res.text());
    process.exit(1);
  }
  const rows = await res.json();
  if (rows.length === 0) console.log("Keine offenen Anfragen.");
  for (const r of rows) {
    const wann = new Date(r.requested_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
    console.log(`${r.id}  ${r.user?.full_name ?? "?"} <${r.user?.email ?? "?"}>  «${r.device_name}»  angefragt ${wann}`);
  }
  console.log('\nFreigeben: node scripts/geraet-notfreigabe.mjs <id> "<Grund>" "<Name>"');
  process.exit(0);
}

if (!grund || !durch) {
  console.error('Grund und Name sind Pflicht: node scripts/geraet-notfreigabe.mjs <id> "<Grund>" "<Name>"');
  process.exit(1);
}

const res = await fetch(`${URL}/rest/v1/rpc/geraet_notfreigabe`, {
  method: "POST",
  headers,
  body: JSON.stringify({ p_device_id: id, p_grund: grund, p_durch: durch }),
});
const text = await res.text();
if (!res.ok) {
  console.error("Notfreigabe fehlgeschlagen:", res.status, text);
  process.exit(1);
}
const r = JSON.parse(text);
console.log(`Freigegeben: «${r.geraet}» — protokolliert (device.notfreigabe).`);
