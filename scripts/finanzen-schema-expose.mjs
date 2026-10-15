// Finanzen Welle 1: Schema `finanzen` in PostgREST exponieren (db_schema).
//
// Usage:
//   node scripts/finanzen-schema-expose.mjs          GET → ggf. PATCH → GET
//   node scripts/finanzen-schema-expose.mjs --check  nur GET (nichts aendern)
//
// Braucht SUPABASE_ACCESS_TOKEN (persoenlicher sbp_-Schluessel) in .env.local.
// Exit 0 = exponiert (oder --check), Exit 1 = HTTP ≠ 2xx / Konfig unlesbar.
//
// ACHTUNG (Spec B.2 / D.4):
//   * Der PATCH startet PostgREST des GANZEN Projekts neu — localhost und
//     Prod teilen die DB. Einige Sekunden fehlschlagende Supabase-Calls in
//     der Live-App, danach Schema-Cache-Aufbau. Deshalb ausserhalb der
//     Buerozeit ausfuehren, Leo vorher informieren, danach 30 s warten und
//     `GET ${SUPABASE_URL}/rest/v1/` mit Anon-Key muss 200 liefern, bevor
//     scripts/finanzen-probe.mjs laeuft.
//   * Die Antworten der Management-API enthalten Secrets (JWT-Secret u. a.).
//     Dieses Skript gibt NUR db_schema, db_extra_search_path und max_rows
//     aus — nie den ganzen Body einer 2xx-Antwort.
//   * Sicherheit kommt NICHT von der Exposition: anon/authenticated haben
//     keine USAGE auf dem Schema (Migration 323). Exponiert wird nur, damit
//     der service_role-Client in src/lib/finanzen/db.ts arbeiten kann.
//   * Kein process.exit(): Node 24 auf Windows bricht sonst nach offenen
//     fetch-Handles mit einer libuv-Assertion ab (Exit-Code unbrauchbar).
//     Stattdessen process.exitCode + return.

import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});
const PAT = env.SUPABASE_ACCESS_TOKEN;
const REF = "uxtotpniwbwyoznwkygd";
const URL_POSTGREST = `https://api.supabase.com/v1/projects/${REF}/postgrest`;
const SCHEMA = "finanzen";
const NUR_PRUEFEN = process.argv.includes("--check");

/** Abbruch mit Meldung — wird in main() gefangen und zu Exit 1. */
class Abbruch extends Error {}

/** Kappt Fehlertexte, entfernt Zeilenumbrueche. Nur fuer Nicht-2xx-Antworten. */
function kappe(s, n = 300) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function api(method, body) {
  const res = await fetch(URL_POSTGREST, {
    method,
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Fehlertext ausgeben (enthaelt keine Konfigurationswerte), Exit 1.
    throw new Abbruch(`${method} ${URL_POSTGREST} → HTTP ${res.status}: ${kappe(text)}`);
  }
  try { return JSON.parse(text); } catch {
    throw new Abbruch(`${method}: Antwort ist kein JSON (HTTP ${res.status}).`);
  }
}

/** Druckt NUR die drei unkritischen Felder. */
function zeige(label, cfg) {
  console.log(label);
  console.log(`  db_schema:            ${cfg.db_schema ?? "(fehlt)"}`);
  console.log(`  db_extra_search_path: ${cfg.db_extra_search_path ?? "(fehlt)"}`);
  console.log(`  max_rows:             ${cfg.max_rows ?? "(fehlt)"}`);
}

function schemaListe(dbSchema) {
  return String(dbSchema ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

async function main() {
  if (!PAT) throw new Abbruch("SUPABASE_ACCESS_TOKEN fehlt in .env.local (persoenlicher Supabase-Zugangsschluessel, sbp_…).");

  const vorher = await api("GET");
  zeige("PostgREST-Konfiguration (aktuell):", vorher);

  const bisher = schemaListe(vorher.db_schema);
  if (bisher.includes(SCHEMA)) {
    console.log(`\nSchema "${SCHEMA}" ist bereits exponiert — nichts zu tun.`);
    return;
  }

  if (NUR_PRUEFEN) {
    console.log(`\n--check: Schema "${SCHEMA}" ist NICHT exponiert. Ohne --check wuerde gepatcht: db_schema = "${[...bisher, SCHEMA].join(", ")}"`);
    return;
  }

  if (bisher.length === 0) {
    // Sicherheitsnetz: nie eine leere Liste ueberschreiben (wuerde public verlieren).
    throw new Abbruch("db_schema ist leer oder unlesbar — breche ab, um die bestehende Konfiguration nicht zu zerstoeren.");
  }

  const neu = [...bisher, SCHEMA].join(", ");
  console.log(`\nPATCH db_schema → "${neu}" (PostgREST startet neu, einige Sekunden Ausfall)…`);
  await api("PATCH", { db_schema: neu });

  const nachher = await api("GET");
  zeige("PostgREST-Konfiguration (nachher):", nachher);

  if (!schemaListe(nachher.db_schema).includes(SCHEMA)) {
    throw new Abbruch(`PATCH angenommen, aber db_schema enthaelt "${SCHEMA}" nicht — bitte im Supabase-Dashboard pruefen (Settings → API → Exposed schemas).`);
  }
  console.log("\nFertig. Jetzt 30 s warten, dann GET <SUPABASE_URL>/rest/v1/ mit Anon-Key muss 200 liefern — erst danach node scripts/finanzen-probe.mjs.");
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Abbruch ? e.message : `Fehler: ${kappe(e?.message ?? e)}`);
  process.exitCode = 1;
}
