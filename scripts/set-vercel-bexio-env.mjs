// Setzt BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET, BEXIO_REDIRECT_URI als
// Production-Env-Vars in Vercel. Liest die Werte aus .env.local und
// pusht sie via Vercel-API (api.vercel.com/v10/projects/{id}/env).
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const TOKEN = env.VERCEL_TOKEN;
const PROJECT_ID = env.VERCEL_PROJECT_ID;
if (!TOKEN || !PROJECT_ID) { console.error("VERCEL_TOKEN oder VERCEL_PROJECT_ID fehlt"); process.exit(1); }

const VARS = [
  { key: "BEXIO_CLIENT_ID", value: env.BEXIO_CLIENT_ID, type: "encrypted" },
  { key: "BEXIO_CLIENT_SECRET", value: env.BEXIO_CLIENT_SECRET, type: "encrypted" },
  { key: "BEXIO_REDIRECT_URI", value: env.BEXIO_REDIRECT_URI, type: "plain" },
];

// 1. Liste existing envs damit wir wissen ob wir upserten oder neu anlegen
const listRes = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
if (!listRes.ok) { console.error("List failed:", await listRes.text()); process.exit(1); }
const { envs } = await listRes.json();

for (const v of VARS) {
  if (!v.value) { console.log(`! ${v.key}: kein Wert in .env.local — skip`); continue; }
  // Falls existing: pruefen ob 'production' im target ist
  const existing = envs.filter((e) => e.key === v.key);
  const prodExists = existing.some((e) => (e.target ?? []).includes("production"));

  if (prodExists) {
    // Update (per id). Wir nehmen den ersten Production-Eintrag.
    const e = existing.find((x) => (x.target ?? []).includes("production"));
    const r = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env/${e.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: v.value, type: v.type }),
    });
    console.log(`PATCH ${v.key}: ${r.status}`);
    if (!r.ok) console.log("  ", await r.text());
  } else {
    // Neu anlegen
    const r = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env?upsert=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        key: v.key,
        value: v.value,
        type: v.type,
        target: ["production", "preview", "development"],
      }),
    });
    console.log(`POST ${v.key}: ${r.status}`);
    if (!r.ok) console.log("  ", await r.text());
  }
}

console.log("\n== Verify ==");
const verifyRes = await fetch(`https://api.vercel.com/v10/projects/${PROJECT_ID}/env`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const verifyJson = await verifyRes.json();
const bexioVars = verifyJson.envs.filter((e) => e.key.startsWith("BEXIO_"));
for (const e of bexioVars) {
  console.log(`  ${e.key} -> targets: ${(e.target ?? []).join(",")}`);
}

console.log("\n== Trigger Redeploy ==");
// Letzten Deploy von main holen + neu deployen
const deployListRes = await fetch(`https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&limit=1&target=production`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const { deployments } = await deployListRes.json();
const latest = deployments?.[0];
if (latest) {
  console.log(`  latest deploy: ${latest.uid} (${latest.url})`);
  const redeployRes = await fetch(`https://api.vercel.com/v13/deployments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: latest.name,
      deploymentId: latest.uid,
      target: "production",
    }),
  });
  console.log(`  redeploy: ${redeployRes.status}`);
  if (!redeployRes.ok) console.log("  ", await redeployRes.text());
  else {
    const j = await redeployRes.json();
    console.log(`  new deploy: ${j.id} -> https://${j.url}`);
  }
}
