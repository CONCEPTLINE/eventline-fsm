#!/usr/bin/env node
// Live-Gang Lohn-Umbau Phase 4 — Prüfungen auf LIVE, NUR LESEND.
//
//   node supabase/lokal/live-gang-phase4/pruefen-live.mjs vorher        (vor 367)
//   node supabase/lokal/live-gang-phase4/pruefen-live.mjs nach-367
//   node supabase/lokal/live-gang-phase4/pruefen-live.mjs vorher-368    (Code live, vor 368)
//   node supabase/lokal/live-gang-phase4/pruefen-live.mjs nach-368
//   … --lokal   gleiche Prüfungen gegen die lokale Test-DB (Docker)
//
// Lesen über den read-only-Endpunkt der Management API (Rolle
// supabase_read_only_user). Ausnahme: Funktionen, die nur service_role
// ausführen darf (lohn_tag_gesperrt, lohn_nach_lauf_bis) — diese über den
// normalen Endpunkt, und dort NUR ein einzelnes SELECT (wert() erzwingt das).
// Ausgabe nur Zählungen, Daten und Minuten (keine Namen, keine Beträge).

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE_REF = "uxtotpniwbwyoznwkygd";
const args = process.argv.slice(2);
const LOKAL = args.includes("--lokal");
const schritt = args.find((a) => !a.startsWith("--"));
const SCHRITTE = ["vorher", "nach-367", "vorher-368", "nach-368"];
if (!SCHRITTE.includes(schritt ?? "")) {
  console.error(`Aufruf: pruefen-live.mjs ${SCHRITTE.join(" | ")} [--lokal]`);
  process.exit(2);
}

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const f = "C:/Users/misch/projects/_secrets/supabase-access-token.txt";
  const line = fs.readFileSync(f, "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!line) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return line.slice(line.indexOf("=") + 1).trim();
}

async function zeilen(query, endpunkt = "read-only") {
  if (LOKAL) {
    const out = execFileSync("docker", ["exec", "-i", "supabase_db_eventline-fsm-lohn", "psql", "-U", "postgres", "-d", "postgres", "-At", "-f", "-"], {
      input: `select coalesce(json_agg(t), '[]'::json) from (${query}) t;`,
    }).toString("utf8");
    return JSON.parse(out.trim());
  }
  if (endpunkt === "voll" && (!/^\s*select\s/i.test(query) || query.includes(";"))) throw new Error("voller Endpunkt nur für ein einzelnes SELECT");
  const pfad = endpunkt === "voll" ? "database/query" : "database/query/read-only";
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/${pfad}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}
async function wert(query, endpunkt) {
  const r = (await zeilen(query, endpunkt))[0] ?? {};
  return Object.values(r)[0];
}

let fehler = 0;
async function pruefe(text, query, erwartet, endpunkt = "read-only") {
  let v;
  try {
    v = await wert(query, endpunkt);
  } catch (e) {
    console.log(`FEHLER ${text}: ${e instanceof Error ? e.message : String(e)}`);
    fehler++;
    return;
  }
  const ok = typeof erwartet === "function" ? erwartet(v) : String(v) === String(erwartet);
  console.log(`${ok ? "OK    " : "FEHLER"} ${text} → ${v}`);
  if (!ok) fehler++;
}
const info = (text, query) => pruefe(`(Info) ${text}`, query, () => true);

// Überlappende Stempel-Paare (ohne Namen): Tag, Minuten, Person aktiv, schon markiert
const PAARE = `select (a.clock_in at time zone 'Europe/Zurich')::date as tag,
       round(extract(epoch from (least(coalesce(a.clock_out,'infinity'), coalesce(b.clock_out,'infinity')) - greatest(a.clock_in, b.clock_in))) / 60) as minuten,
       p.is_active as aktiv, a.id as a_id, b.id as b_id
  from public.time_entries a
  join public.time_entries b on a.user_id = b.user_id and a.id < b.id
   and tstzrange(a.clock_in, coalesce(a.clock_out, 'infinity'::timestamptz), '[)') && tstzrange(b.clock_in, coalesce(b.clock_out, 'infinity'::timestamptz), '[)')
  join public.profiles p on p.id = a.user_id`;
async function zeigePaare(titel, mitAltfall) {
  const q = mitAltfall
    ? `select x.tag, x.minuten, x.aktiv, (select bool_and(ueberlappung_altfall) from public.time_entries where id in (x.a_id, x.b_id)) as markiert from (${PAARE}) x order by 1`
    : `select x.tag, x.minuten, x.aktiv from (${PAARE}) x order by 1`;
  const rows = await zeilen(q);
  console.log(`       ${titel}: ${rows.length} Paar(e)`);
  for (const r of rows) console.log(`         ${r.tag}  ${r.minuten} min  Person ${r.aktiv ? "aktiv" : "ausgetreten"}${mitAltfall ? `  ${r.markiert ? "als Altfall markiert" : "NICHT markiert"}` : ""}`);
  return rows;
}

console.log(`Prüfung «${schritt}» ${LOKAL ? "(LOKAL)" : `(Live ${LIVE_REF}, nur lesend)`}`);

if (schritt === "vorher") {
  await pruefe("Phase 2 live (lohn_momentaufnahmen, lohn_aenderungs_antraege)", "select to_regclass('public.lohn_momentaufnahmen') is not null and to_regclass('public.lohn_aenderungs_antraege') is not null", true);
  await pruefe("367 noch nicht eingespielt (lohn_zusatzposten fehlt)", "select to_regclass('public.lohn_zusatzposten') is null", true);
  await pruefe("Erweiterung btree_gist verfügbar (für 368)", "select count(*) from pg_available_extensions where name = 'btree_gist'", 1);
  await pruefe("kein Lohnlauf läuft gerade", "select count(*) from public.lohn_lauf where status = 'laeuft'", 0);
  // Schutz gegen Befund «Momentaufnahme irgendeiner Person sperrt alle»: keine Fassung in einem noch offenen Monat.
  await pruefe("keine Lohnabrechnung (Momentaufnahme) in einem noch nicht gesperrten Monat",
    "select count(*) from public.lohn_momentaufnahmen where not public.is_time_entry_locked((make_date(jahr, monat, 15) + time '12:00') at time zone 'Europe/Zurich')", 0);
  await info("offene Stempel (Erinnerung ab dem 1. des Folgemonats)", "select count(*) from public.time_entries where clock_out is null");
  await info("Stempel > 16 h im Lauf-Bereich ab Oktober 2026 (blockieren den Monat, bis geprüft)",
    "select count(*) from public.time_entries where clock_in >= '2026-09-30' and clock_out - clock_in > interval '16 hours'");
  await info("Digital-Einwilligungen in profiles (367 übernimmt sie in lohn_zustellung_wahl)", "select count(*) from public.profiles where lohndokumente_digital_accepted_at is not null");
  const paare = await zeigePaare("Überlappungen (368 markiert sie als Altfall)", false);
  if (paare.length !== 2) console.log("       ACHTUNG: erwartet 2 (29.10.: 03.05.2026 30 min, 12.06.2026 1 min) — neue Fälle zuerst ansehen");
}

if (schritt === "nach-367" || schritt === "vorher-368" || schritt === "nach-368") {
  for (const t of ["lohn_zusatzposten", "lohn_auszahlungen", "lohn_zustellung_wahl", "lohn_dokument_zustellung", "lohn_dokument_zustellung_verlauf"]) {
    await pruefe(`Tabelle ${t} vorhanden, Browser ohne Rechte`, `select to_regclass('public.${t}') is not null and not has_table_privilege('authenticated', 'public.${t}', 'SELECT') and not has_table_privilege('anon', 'public.${t}', 'SELECT')`, true);
  }
  await pruefe("time_entries: 5 neue Spalten", "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'time_entries' and column_name in ('lang_begruendung','geprueft_at','geprueft_von','geprueft_von_name','ueberlappung_altfall')", 5);
  await pruefe("time_entries: Trigger Feldschutz, Sperre, Protokoll", "select count(*) from pg_trigger where not tgisinternal and tgrelid = 'public.time_entries'::regclass and tgname in ('time_entries_lohn_felder','time_entries_lohn_sperre','time_entries_lohn_protokoll')", 3);
  await pruefe("Zusatzposten: Sperre, Protokoll, lauf_bis", "select count(*) from pg_trigger where not tgisinternal and tgrelid = 'public.lohn_zusatzposten'::regclass and tgname in ('lohn_zusatzposten_lohn_sperre','lohn_zusatzposten_lohn_protokoll','lohn_zusatzposten_lauf_bis')", 3);
  await pruefe("lauf_bis = November 2026", "select lauf_bis from public.lohn_einstellungen where id = 'default'", "2026-11-01");
  await pruefe("Dezember 2026 gesperrt für das ERP (Klartext)", "select public.lohn_nach_lauf_bis(2026, 12) like 'Ab Dezember 2026 läuft der Lohn über Trust flow/Bexio%'", true, "voll");
  await pruefe("November 2026 im ERP möglich", "select public.lohn_nach_lauf_bis(2026, 11) is null", true, "voll");
  await pruefe("Stempel-Sperre greift (September 2026)", "select public.lohn_tag_gesperrt('time_entries', '2026-09-15')", true, "voll");
  await pruefe("Stempel-Sperre nur nach dem 5. (heute offen)", "select public.lohn_tag_gesperrt('time_entries', (now() at time zone 'Europe/Zurich')::date)", false, "voll");
  await pruefe("Momentaufnahmen: Spalte auszahlungsbetrag (auch in der Sicht)", "select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('lohn_momentaufnahmen','lohn_fassungen_gueltig') and column_name = 'auszahlungsbetrag'", 2);
  await pruefe("Einwilligungen übernommen (jede in profiles hat einen Eintrag in der Historie)", "select count(*) from public.profiles p where p.lohndokumente_digital_accepted_at is not null and not exists (select 1 from public.lohn_zustellung_wahl w where w.profile_id = p.id)", 0);
  await pruefe("stempel_ueberlappung: eingeloggt ja, anonym nein", "select has_function_privilege('authenticated', 'public.stempel_ueberlappung(uuid, timestamptz, timestamptz, uuid)', 'execute') and not has_function_privilege('anon', 'public.stempel_ueberlappung(uuid, timestamptz, timestamptz, uuid)', 'execute')", true);
  await pruefe("Server-Funktionen nicht für den Browser", "select count(*) filter (where has_function_privilege('authenticated', oid, 'execute')) from pg_proc where proname in ('lohn_nach_lauf_bis','lohn_dokument_geoeffnet','lohn_tag_gesperrt','lohn_momentaufnahme_speichern')", 0);
  await pruefe("Antrags-Bereiche stempel/zusatzposten erlaubt", "select pg_get_constraintdef(oid) like '%stempel%zusatzposten%' from pg_constraint where conname = 'lohn_aenderungs_antraege_bereich_check'", true);
}

if (schritt === "vorher-368") {
  console.log("       Vorher: /api/version = gepushter SHA (Code mit Klartext-Meldungen live) und seit mindestens einer Nacht (Handy-Warteschlangen).");
  await pruefe("368 noch nicht eingespielt", "select count(*) from pg_constraint where conname = 'time_entries_keine_ueberlappung'", 0);
  await info("offene Stempel", "select count(*) from public.time_entries where clock_out is null");
  await info("Stempel > 16 h ohne Begründung (Bestand, bleibt unberührt)", "select count(*) from public.time_entries where clock_out - clock_in > interval '16 hours' and coalesce(trim(lang_begruendung), '') = ''");
  const paare = await zeigePaare("Überlappungen, die 368 als Altfall markiert", false);
  if (paare.length !== 2) console.log("       ACHTUNG: erwartet 2 — jede zusätzliche Überlappung ansehen, bevor 368 sie markiert");
}

if (schritt === "nach-368") {
  await pruefe("Regel gegen Überlappung aktiv", "select count(*) from pg_constraint where conname = 'time_entries_keine_ueberlappung' and contype = 'x'", 1);
  await pruefe("btree_gist installiert", "select count(*) from pg_extension where extname = 'btree_gist'", 1);
  await pruefe("Begründungspflicht > 16 h (Trigger)", "select count(*) from pg_trigger where not tgisinternal and tgname = 'time_entries_lang_begruendung'", 1);
  await pruefe("Grenze in der DB = 16 h (wie STEMPEL_LANG_STUNDEN)", "select extract(epoch from public.stempel_lang_grenze()) / 3600", 16);
  await pruefe("keine Überlappung ausserhalb der Altfälle", `select count(*) from (${PAARE}) x where not exists (select 1 from public.time_entries t where t.id in (x.a_id, x.b_id) and t.ueberlappung_altfall)`, 0);
  await zeigePaare("Altfälle", true);
  await info("Stempel als Altfall markiert", "select count(*) from public.time_entries where ueberlappung_altfall");
}

console.log(fehler === 0 ? "\nALLES OK" : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
