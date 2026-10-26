// Nachlauf «Neuerungen auch auf den Bestand» (CLAUDE.md B3, Leo 2026-10-25):
// baut die Positionsgruppen der NICHT archivierten Auftraege aus ihren
// Eingang-Elementen neu auf — mit demselben Kern wie Eingang-Tab und
// Mail-Webhook (verarbeiteEingangItem, Modus nurPositionsgruppen).
// Zusammenfassung, Termin-/Datumsvorschlaege und Status der Elemente bleiben
// unberuehrt; es gehen keine Mails raus.
//
// Ablauf je Auftrag:
//  1. Backup aller Gruppen + Einzelpositionen (--backup <datei.json>, Pflicht)
//  2. Neu aufbaubare KI-Eintraege entfernen: von der KI angelegt, nie von Hand
//     geaendert, ohne Rueckmeldung/Kommentar/Bestaetigung des Lieferanten
//     (eine Gruppe nur, wenn alle ihre Einzelpositionen so sind). Von Hand
//     Gepflegtes bleibt und steht der KI als «bestehend» im Kontext → keine
//     Duplikate, nichts Manuelles ueberschrieben.
//  3. Elemente aelteste zuerst neu verarbeiten (Chronologie wie im Eingang-Tab).
//
// Jedes Element = ein Claude-Aufruf mit dem App-Schluessel → nur auf Anweisung
// laufen lassen, Anzahl vorher mit --dry pruefen. Fehler je Element werden
// protokolliert; ist Claude gesperrt/ueberlastet, bricht der Lauf ab.
//
// Modus --zusammenhang (Migration 354, Leo 2026-10-26): schreibt NUR den Absatz
// «Zusammenhang» je Positionsgruppe nach — ein Claude-Aufruf je Auftrag mit
// allen verarbeiteten Eingang-Elementen (zusammenhangVorschlagen). Nur
// KI-Gruppen ohne Absatz, die nie von Hand geaendert wurden; Gruppen,
// Einzelpositionen, Termine und Zusammenfassung bleiben unveraendert. Gespeichert
// wird per SQL mit eventline.ohne_aenderungsmarker → kein «Geändert» im Portal
// (braucht SUPABASE_ACCESS_TOKEN). Keine Mails.
//
// Usage (im Projektordner, .env.local mit Live-Schluesseln):
//   npx tsx scripts/eingang-nachlauf.mts --dry [--job 26302,26306]
//   npx tsx scripts/eingang-nachlauf.mts --backup <datei.json> [--job …] [--ohne 26302] [--pause 4000]
//   npx tsx scripts/eingang-nachlauf.mts --zusammenhang --dry [--job …]
//   npx tsx scripts/eingang-nachlauf.mts --zusammenhang --backup <datei.json> [--job …] [--ohne …]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { verarbeiteEingangItem, zusammenhangVorschlagen, type ZusammenhangVorschlag } from "../src/lib/ai/eingang-verarbeitung";
import { auftragArchiviert } from "../src/lib/archiv";
import { aiAvailable, ClaudeNichtVerfuegbarError } from "../src/lib/ai/anthropic";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const nummern = (s?: string) => new Set((s ?? "").split(",").map((x) => Number(x.trim())).filter(Boolean));
const DRY = process.argv.includes("--dry");
const NUR = nummern(arg("--job"));
const OHNE = nummern(arg("--ohne"));
const PAUSE = Number(arg("--pause") ?? 3000);
const BACKUP = arg("--backup");
const ZUSAMMENHANG = process.argv.includes("--zusammenhang");
if (!DRY && !BACKUP) {
  console.error("--backup <datei.json> fehlt (oder --dry für die Liste)");
  process.exit(1);
}
if (!DRY && !aiAvailable()) {
  console.error("ANTHROPIC_API_KEY fehlt");
  process.exit(1);
}

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

type Item = { id: string; job_id: string; created_at: string; kind: string; file_name: string | null; ai_status: string };
type Job = { id: string; job_number: number; title: string; status: string; is_deleted: boolean };
type Pos = { id: string; gruppe_id: string; created_via: string | null; manuell_geaendert_at: string | null; status: string };
type Grp = { id: string; nummer: number; titel: string; created_via: string | null; manuell_geaendert_at: string | null };

const pruefe = <T,>(r:{ data: T | null; error: { message: string } | null }, was: string): T => {
  if (r.error) throw new Error(`${was}: ${r.error.message}`);
  return r.data as T;
};

/** SQL ueber die Management-API (UTF-8-JSON aus Node, nicht ueber die Shell). */
async function sql(query: string): Promise<Record<string, unknown>[]> {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref || !process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN oder Projekt fehlt");
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL fehlgeschlagen (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>[];
}

/** Text als Dollar-Quote mit einem Tag, das im Text nicht vorkommt. */
function dollar(text: string): string {
  let tag: string;
  do tag = `zh${Math.random().toString(36).slice(2, 8)}`; while (text.includes(`$${tag}$`));
  return `$${tag}$${text}$${tag}$`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absaetze in EINER Anweisung speichern (eine Transaktion) — nur wo noch
 *  kein Absatz steht und nie von Hand geaendert; ohne «Geändert»-Marker
 *  (Migration 354). Liefert die Zahl der geschriebenen Gruppen. */
async function absaetzeSpeichern(jobId: string, absaetze: ZusammenhangVorschlag[]): Promise<number> {
  if (!UUID_RE.test(jobId) || absaetze.some((a) => !UUID_RE.test(a.gruppe_id))) throw new Error("Ungültige ID");
  const werte = absaetze.map((a) => `('${a.gruppe_id}'::uuid, ${dollar(a.zusammenhang)})`).join(",\n  ");
  const r = await sql(
    `select set_config('eventline.ohne_aenderungsmarker', 'an', true);\n` +
    `with v(id, zusammenhang) as (values\n  ${werte}\n), u as (\n` +
    `  update public.job_anforderungen g set zusammenhang = v.zusammenhang from v\n` +
    `  where g.id = v.id and g.job_id = '${jobId}'::uuid and g.created_via = 'ki' and g.manuell_geaendert_at is null\n` +
    `    and coalesce(btrim(g.zusammenhang), '') = ''\n` +
    `  returning g.id\n)\nselect count(*)::int as n from u;`,
  );
  return Number(r[0]?.n ?? 0);
}

async function nachlaufZusammenhang(): Promise<void> {
  const grp = pruefe(
    await admin.from("job_anforderungen").select("job_id, created_via, manuell_geaendert_at, zusammenhang"),
    "Gruppen laden",
  ) as { job_id: string; created_via: string | null; manuell_geaendert_at: string | null; zusammenhang: string | null }[];
  const jobsAlle = pruefe(
    await admin.from("jobs").select("id, job_number, title, status, is_deleted").in("id", [...new Set(grp.map((g) => g.job_id))]),
    "Aufträge laden",
  ) as Job[];
  const jobs = jobsAlle
    .filter((j) => !j.is_deleted && !auftragArchiviert(j.status))
    .filter((j) => (NUR.size ? NUR.has(j.job_number) : true) && !OHNE.has(j.job_number))
    .sort((a, b) => a.job_number - b.job_number);
  const gesucht = (jobId: string) => grp.filter((g) =>
    g.job_id === jobId && g.created_via === "ki" && !g.manuell_geaendert_at && !(g.zusammenhang ?? "").trim()).length;
  console.log(`Aufträge mit Positionsgruppen (nicht archiviert): ${jobs.length}`);
  for (const j of jobs) {
    console.log(`  INT-${j.job_number} ${j.title} — ${grp.filter((g) => g.job_id === j.id).length} Gruppen, Absatz gesucht für ${gesucht(j.id)}`);
  }
  if (DRY) return;
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN fehlt (Speichern ohne Änderungsmarker)");

  // 1. Backup (alle Spalten) der betroffenen Auftraege.
  const backup = [];
  for (const j of jobs) {
    const gruppen = pruefe(await admin.from("job_anforderungen").select("*").eq("job_id", j.id).order("nummer"), "Backup Gruppen");
    const positionen = pruefe(await admin.from("job_technik_positionen").select("*").eq("job_id", j.id).order("created_at"), "Backup Positionen");
    backup.push({ job_id: j.id, job_number: j.job_number, gruppen, positionen });
  }
  mkdirSync(dirname(BACKUP!), { recursive: true });
  writeFileSync(BACKUP!, JSON.stringify({ erstellt: new Date().toISOString(), modus: "zusammenhang", jobs: backup }, null, 2));
  console.log(`Backup: ${BACKUP}`);

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let aufrufe = 0;
  let geschrieben = 0;
  let fehler = 0;
  for (const j of jobs) {
    if (!gesucht(j.id)) continue;
    aufrufe++;
    try {
      const r = await zusammenhangVorschlagen({ admin, jobId: j.id });
      const n = r.absaetze.length ? await absaetzeSpeichern(j.id, r.absaetze) : 0;
      geschrieben += n;
      console.log(`\nINT-${j.job_number}: ${n}/${r.gesucht} Absätze geschrieben (${r.elemente} Elemente gelesen` +
        `${r.verworfen ? `, ${r.verworfen} mit Preis-/Offert-Bezug verworfen` : ""})`);
      for (const a of r.absaetze) console.log(`  Pos ${String(a.nummer).padStart(2, "0")} – ${a.titel}: ${a.zusammenhang}`);
      if (n) {
        const { error } = await admin.from("job_technik_aktivitaet").insert({
          job_id: j.id,
          actor_id: null,
          actor_name: "Eingang-KI",
          aktion: "ki_nachlauf",
          beschreibung: `Zusammenhang je Position aus dem Eingang ergänzt (${n} ${n === 1 ? "Position" : "Positionen"}); Positionen und Einzelpositionen unverändert`,
        });
        if (error) console.error(`  Aktivität nicht protokolliert: ${error.message}`);
      }
    } catch (err) {
      fehler++;
      console.error(`  FEHLER INT-${j.job_number}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof ClaudeNichtVerfuegbarError) {
        console.error("Claude nicht verfügbar — Lauf abgebrochen (Backup liegt).");
        break;
      }
    }
    await pause(PAUSE);
  }
  console.log(`\nClaude-Aufrufe: ${aufrufe}, Absätze geschrieben: ${geschrieben}, Fehler: ${fehler}`);
  if (fehler) process.exitCode = 1;
}

// Modus --zusammenhang: eigener Ablauf (oben), danach Ende.
if (ZUSAMMENHANG) {
  await nachlaufZusammenhang();
  process.exit();
}

const items = pruefe(
  await admin.from("job_inbox_items").select("id, job_id, created_at, kind, file_name, ai_status").order("created_at"),
  "Elemente laden",
) as Item[];
const jobIds = [...new Set(items.map((i) => i.job_id))];
const jobsAlle = pruefe(
  await admin.from("jobs").select("id, job_number, title, status, is_deleted").in("id", jobIds),
  "Aufträge laden",
) as Job[];
const jobs = jobsAlle
  .filter((j) => !j.is_deleted && !auftragArchiviert(j.status))
  .filter((j) => (NUR.size ? NUR.has(j.job_number) : true) && !OHNE.has(j.job_number))
  .sort((a, b) => a.job_number - b.job_number);

console.log(`Aufträge: ${jobs.length}`);
for (const j of jobs) {
  const eig = items.filter((i) => i.job_id === j.id);
  console.log(`  INT-${j.job_number} ${j.title} — ${eig.length} Elemente (${eig.filter((i) => i.ai_status === "verarbeitet").length} verarbeitet)`);
}
if (DRY) process.exit(0);

// 1. Backup (alle Spalten), bevor irgendetwas geaendert wird.
const backup = [];
for (const j of jobs) {
  const gruppen = pruefe(await admin.from("job_anforderungen").select("*").eq("job_id", j.id).order("nummer"), "Backup Gruppen");
  const positionen = pruefe(await admin.from("job_technik_positionen").select("*").eq("job_id", j.id).order("created_at"), "Backup Positionen");
  backup.push({ job_id: j.id, job_number: j.job_number, gruppen, positionen });
}
writeFileSync(BACKUP!, JSON.stringify({ erstellt: new Date().toISOString(), jobs: backup }, null, 2));
console.log(`Backup: ${BACKUP}`);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const protokoll: { job: number; item: string; ok: boolean; fehler?: string; verworfen?: number }[] = [];
let aufrufe = 0;

lauf: for (const j of jobs) {
  // 2. Neu aufbaubare KI-Eintraege entfernen.
  const [g, p, r, k] = await Promise.all([
    admin.from("job_anforderungen").select("id, nummer, titel, created_via, manuell_geaendert_at").eq("job_id", j.id),
    admin.from("job_technik_positionen").select("id, gruppe_id, created_via, manuell_geaendert_at, status").eq("job_id", j.id),
    admin.from("job_technik_reviews").select("position_id").eq("job_id", j.id),
    admin.from("job_technik_kommentare").select("position_id").eq("job_id", j.id),
  ]);
  const gruppen = pruefe(g, "Gruppen laden") as Grp[];
  const positionen = pruefe(p, "Positionen laden") as Pos[];
  const mitRueckmeldung = new Set([...(pruefe(r, "Reviews laden") as { position_id: string | null }[]), ...(pruefe(k, "Kommentare laden") as { position_id: string | null }[])]
    .map((x) => x.position_id).filter(Boolean));
  const posWeg = positionen.filter((x) => x.created_via === "ki" && !x.manuell_geaendert_at && x.status !== "bestaetigt" && !mitRueckmeldung.has(x.id));
  const posWegIds = new Set(posWeg.map((x) => x.id));
  const grpWeg = gruppen.filter((x) => x.created_via === "ki" && !x.manuell_geaendert_at &&
    positionen.every((y) => y.gruppe_id !== x.id || posWegIds.has(y.id)));
  if (posWeg.length) {
    const d = await admin.from("job_technik_positionen").delete({ count: "exact" }).in("id", posWeg.map((x) => x.id)).eq("job_id", j.id);
    if (d.error || d.count !== posWeg.length) throw new Error(`INT-${j.job_number}: Einzelpositionen entfernen (${d.count}/${posWeg.length}) ${d.error?.message ?? ""}`);
  }
  if (grpWeg.length) {
    const d = await admin.from("job_anforderungen").delete({ count: "exact" }).in("id", grpWeg.map((x) => x.id)).eq("job_id", j.id);
    if (d.error || d.count !== grpWeg.length) throw new Error(`INT-${j.job_number}: Gruppen entfernen (${d.count}/${grpWeg.length}) ${d.error?.message ?? ""}`);
  }
  console.log(`\nINT-${j.job_number}: ${grpWeg.length} KI-Gruppen / ${posWeg.length} KI-Einzelpositionen zum Neuaufbau entfernt, ` +
    `${gruppen.length - grpWeg.length} Gruppen bleiben (von Hand gepflegt/geschützt)`);
  const { error: logErr } = await admin.from("job_technik_aktivitaet").insert({
    job_id: j.id,
    actor_id: null,
    actor_name: "Eingang-KI",
    aktion: "ki_nachlauf",
    beschreibung: "Positionen aus dem Eingang nach neuer Regel neu aufgebaut (nur Kundenaussagen, nichts aus Offerten, keine Preise); von Hand Gepflegtes unverändert",
  });
  if (logErr) console.error(`  Aktivität nicht protokolliert: ${logErr.message}`);

  // 3. Elemente aelteste zuerst.
  for (const it of items.filter((i) => i.job_id === j.id && i.ai_status === "verarbeitet")) {
    aufrufe++;
    try {
      const e = await verarbeiteEingangItem({ admin, jobId: j.id, itemId: it.id, actorUserId: null, nurPositionsgruppen: true });
      protokoll.push({ job: j.job_number, item: it.id, ok: true, verworfen: e.verworfen });
      console.log(`  ok   ${it.id} ${it.kind}${it.file_name ? ` ${it.file_name}` : ""}${e.verworfen ? ` (${e.verworfen} mit Preis-/Offert-Bezug verworfen)` : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      protokoll.push({ job: j.job_number, item: it.id, ok: false, fehler: msg });
      console.error(`  FEHLER ${it.id}: ${msg}`);
      if (err instanceof ClaudeNichtVerfuegbarError) {
        console.error("Claude nicht verfügbar — Lauf abgebrochen (Backup liegt).");
        break lauf;
      }
    }
    await pause(PAUSE);
  }

  const neu = pruefe(await admin.from("job_anforderungen").select("id, nummer, titel, text").eq("job_id", j.id).order("nummer"), "Ergebnis laden") as
    { id: string; nummer: number; titel: string; text: string }[];
  const neuPos = pruefe(await admin.from("job_technik_positionen").select("gruppe_id, menge, bezeichnung, details").eq("job_id", j.id).order("created_at"), "Ergebnis laden") as
    { gruppe_id: string; menge: number; bezeichnung: string; details: string | null }[];
  for (const x of neu) {
    console.log(`  Pos ${String(x.nummer).padStart(2, "0")} – ${x.titel}: ${x.text}`);
    for (const y of neuPos.filter((q) => q.gruppe_id === x.id)) console.log(`      ${y.menge}× ${y.bezeichnung}${y.details ? ` (${y.details})` : ""}`);
  }
}

const fehler = protokoll.filter((x) => !x.ok);
console.log(`\nClaude-Aufrufe: ${aufrufe}, ok: ${protokoll.length - fehler.length}, Fehler: ${fehler.length}`);
if (fehler.length) process.exitCode = 1;
