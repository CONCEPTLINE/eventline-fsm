// Doppel-Fristen zusammenfuehren (einmalig, nach Migration 321) — PLANT NUR.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/fristen-duplikate.mjs <ausgabeordner>
//
// Liest ablage_fristen (nur lesen, Management-API mit SUPABASE_ACCESS_TOKEN
// aus .env.local), plant mit src/lib/ki/fristen-sachverhalt.ts und schreibt
//   <ausgabeordner>/fristen-sicherung-<zeit>.json   alle betroffenen Zeilen, vollstaendig
//   <ausgabeordner>/fristen-bereinigung-<zeit>.sql  das Skript zum Einspielen
// und gibt nur Zahlen aus (nie Pfade). Geaendert wird hier NICHTS.
//
// Einspielen erst nach Freigabe:
//   node scripts/apply-migration.mjs <ausgabeordner>/fristen-bereinigung-<zeit>.sql
// Das SQL laeuft als EIN Block: weicht ein Zaehler ab (inzwischen bestaetigt,
// verworfen, geloescht), bricht es ab und aendert gar nichts.
//
// Regeln (planeBereinigung): zusammengefuehrt werden NUR unbestaetigte
// KI-Vorschlaege mit gleichem Sachverhalt (Art + Partei) und gleichem Datum.
// Die beste Zeile bleibt und bekommt die anderen Dokumente als
// weitere_pfade; die anderen werden geloescht. Bestaetigte, erledigte,
// verworfene sowie beim Ablegen/von Hand erfasste Fristen bleiben, wie sie
// sind (sie bekommen hoechstens den Sachverhalt nachgetragen).

import fs from "node:fs";
import path from "node:path";
import { planeBereinigung } from "../src/lib/ki/fristen-sachverhalt.ts";

const envText = fs.readFileSync(".env.local", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const ACCESS = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ACCESS || !ref) {
  console.error("SUPABASE_ACCESS_TOKEN oder NEXT_PUBLIC_SUPABASE_URL fehlt in .env.local");
  process.exit(1);
}
const OUT = process.argv[2];
if (!OUT) {
  console.error("Aufruf: node scripts/fristen-duplikate.mjs <ausgabeordner>");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

async function abfrage(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) throw new Error(`HTTP ${res.status}`);
  return json;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (liste) => (liste.length ? `array[${liste.map(q).join(", ")}]::text[]` : "'{}'::text[]");

const zeilen = (await abfrage("select to_jsonb(f) as z from public.ablage_fristen f order by f.datum, f.id")).map((r) => r.z);
const plan = planeBereinigung(zeilen);
const zeit = new Date().toISOString().replace(/[:.]/g, "-");

const betroffen = plan.gruppen.flatMap((g) => [g.behalten, ...g.weg]);
fs.writeFileSync(path.join(OUT, `fristen-sicherung-${zeit}.json`), JSON.stringify({ erstellt: new Date().toISOString(), zeilen: betroffen, setzen: plan.setzen }, null, 1));

const nachtragen = plan.setzen.filter((s) => !plan.gruppen.some((g) => g.behalten.id === s.id));
const sql = [];
sql.push(`-- Doppel-Fristen zusammenfuehren (geplant ${new Date().toISOString()}, scripts/fristen-duplikate.mjs).`);
sql.push(`-- ${plan.gruppen.length} Gruppen, ${plan.gruppen.reduce((n, g) => n + g.weg.length, 0)} Zeilen werden geloescht, ${nachtragen.length} weitere bekommen den Sachverhalt.`);
sql.push("do $$");
sql.push("declare n int;");
sql.push("begin");
sql.push("  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ablage_fristen' and column_name = 'sachverhalt') then");
sql.push("    raise exception 'Migration 321 fehlt — zuerst einspielen';");
sql.push("  end if;");
plan.gruppen.forEach((g, i) => {
  const nr = i + 1;
  sql.push(`  -- Gruppe ${nr}: ${g.sachverhalt} · ${g.datum} (${g.weg.length + 1} -> 1)`);
  sql.push(`  delete from public.ablage_fristen where id in (${g.weg.map((z) => q(z.id) + "::uuid").join(", ")}) and quelle = 'ki' and status = 'vorschlag';`);
  sql.push("  get diagnostics n = row_count;");
  sql.push(`  if n <> ${g.weg.length} then raise exception 'Gruppe ${nr}: % statt ${g.weg.length} Zeilen — Stand hat sich geaendert, nichts geaendert', n; end if;`);
  sql.push(`  update public.ablage_fristen set weitere_pfade = ${arr(g.weitere_pfade)}, sachverhalt = ${q(g.sachverhalt)}, updated_at = now() where id = ${q(g.behalten.id)}::uuid and quelle = 'ki' and status = 'vorschlag';`);
  sql.push("  get diagnostics n = row_count;");
  sql.push(`  if n <> 1 then raise exception 'Gruppe ${nr}: behaltene Frist ist kein offener Vorschlag mehr — nichts geaendert'; end if;`);
});
if (nachtragen.length) {
  sql.push("  -- Sachverhalt nachtragen (nur wo noch leer; Status bleibt).");
  sql.push(`  update public.ablage_fristen f set sachverhalt = v.s from (values ${nachtragen.map((s) => `(${q(s.id)}::uuid, ${q(s.sachverhalt)})`).join(", ")}) v(id, s) where f.id = v.id and f.sachverhalt is null;`);
}
sql.push("end $$;");
sql.push("-- Kontrolle: offene KI-Vorschlaege mit gleichem Sachverhalt + Datum (soll 0 sein)");
sql.push("select count(*) as doppel_rest from (select sachverhalt, datum from public.ablage_fristen where status = 'vorschlag' and sachverhalt is not null group by 1, 2 having count(*) > 1) x;");
const sqlDatei = path.join(OUT, `fristen-bereinigung-${zeit}.sql`);
fs.writeFileSync(sqlDatei, sql.join("\n") + "\n");

console.log(`Fristen gesamt: ${zeilen.length}`);
console.log(`Gruppen mit Doppeln: ${plan.gruppen.length}`);
for (const g of plan.gruppen) console.log(`  ${g.sachverhalt} · ${g.datum}: ${g.weg.length + 1} -> 1`);
console.log(`Zu loeschen (in weitere_pfade uebernommen): ${plan.gruppen.reduce((n, g) => n + g.weg.length, 0)}`);
console.log(`Sachverhalt nachtragen: ${nachtragen.length}`);
console.log(`SQL: ${sqlDatei}`);
