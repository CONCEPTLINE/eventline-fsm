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

const leo = await sql(`SELECT id, full_name, role FROM profiles WHERE email='leo@eventline-basel.com'`);
console.log("LEO:", leo);
const leoId = leo[0]?.id;
if (!leoId) process.exit(0);

const folders = await sql(`
  SELECT id, parent_id, name, sort_order, created_at, updated_at
  FROM vertrieb_folders WHERE owner_id = '${leoId}'
  ORDER BY sort_order, name
`);
console.log("\nFOLDERS:", folders.length);
for (const f of folders) {
  console.log(`  ${f.id} | parent=${f.parent_id ?? "(root)"} | name="${f.name}" | sort=${f.sort_order}`);
}

const lfs = await sql(`
  SELECT lf.lead_id, lf.folder_id, f.name AS folder_name, vc.firma, vc.nr, lf.created_at
  FROM vertrieb_lead_folders lf
  LEFT JOIN vertrieb_folders f ON f.id = lf.folder_id
  LEFT JOIN vertrieb_contacts vc ON vc.id = lf.lead_id
  WHERE lf.owner_id = '${leoId}'
  ORDER BY lf.created_at DESC
`);
console.log("\nLEAD-FOLDER-MAPPINGS:", lfs.length);
for (const lf of lfs) {
  console.log(`  Lead Nr.${lf.nr} "${lf.firma}" -> Folder "${lf.folder_name ?? '(folder weg!)'}"`);
}
