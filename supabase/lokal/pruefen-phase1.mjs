#!/usr/bin/env node
// Prüftor Lohn-Umbau Phase 1 — NUR LOKAL (Testumgebung, Docker-Supabase + Dev-Server :3100).
//
// Spielt durch:
//   A  Sicherheit direkt (Supabase-REST mit anon-Key): nicht angemeldet, Techniker ohne
//      Lohnrecht, Admin — keine Lohndaten (Tabellen, RPCs, Storage).
//   B  Sicherheit über die API-Routen: Techniker, Admin ohne vertrautes Gerät, Admin mit Gerät.
//   C  Automatischer Lauf: mehrere gesperrte Monate nachholen, Fehler (simuliert) nur bei
//      einer Person, 0-CHF-Monat, Eintritt Mitte Monat, Austritt, kein Überschreiben.
//   D  Generieren/Hochladen: nur gesperrte Monate, Rückfrage, neue Fassung ohne Überschreiben,
//      Papierkorb + Wiederherstellen + Protokoll.
//   E  Lohn-Editor: Sonderwerte (Ferienanteil-Override, eigene Sätze inkl. Quellensteuer) bleiben.
//   F  Vier Augen, Gerätefreigabe (Knopf, 24 h, alter Link, Notweg), «Ansicht als».
//   G  Benutzer löschen = archivieren; Dossier mit Aufbewahrungsdatum.
//   H  Vier Augen bei Rechten: Admin-Rolle/Lohnrecht/Vertretung nur per Antrag,
//      den der andere Admin auf vertrautem Gerät bestätigt (Strohmann-Versuch).
//
// Aufruf: node supabase/lokal/pruefen-phase1.mjs
// Voraussetzungen: bash supabase/lokal/aufbauen.sh (frische Testdaten), Dev-Server auf 3100,
// CRON_SECRET in .env.local gesetzt (lokaler Testwert). Meldet sich überall nur LOKAL ab.
// Ändert nur die lokale Test-DB (Abbruch, wenn .env.local nicht auf 127.0.0.1:55421 zeigt).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const APP = "http://localhost:3100";
const DB = "supabase_db_eventline-fsm-lohn";

const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
if (!/^http:\/\/(127\.0\.0\.1|localhost):55421$/.test(URL_ ?? "")) {
  console.error(`ABBRUCH: .env.local zeigt nicht auf das lokale Supabase (${URL_}).`);
  process.exit(1);
}
if (!env.CRON_SECRET) {
  console.error("ABBRUCH: CRON_SECRET fehlt in .env.local (lokalen Testwert setzen, Dev-Server lädt neu).");
  process.exit(1);
}

const ID = {
  admin: "a0000000-0000-4000-8000-000000000001",
  admin2: "a0000000-0000-4000-8000-000000000002",
  lena: "a0000000-0000-4000-8000-000000000011",
  mia: "a0000000-0000-4000-8000-000000000013",
  lara: "a0000000-0000-4000-8000-000000000017",
  luca: "a0000000-0000-4000-8000-000000000018",
  ben: "a0000000-0000-4000-8000-000000000019",
};
const PW = "LohnTest-2026!";
const service = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let fehler = 0;
const ok = (b, msg) => { console.log(`${b ? "OK    " : "FEHLER"} ${msg}`); if (!b) fehler++; return b; };
const titel = (t) => console.log(`\n== ${t}`);
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();

const sitzungen = [];
async function login(email) {
  const jar = new Map();
  const supa = createServerClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { error } = await supa.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`Login ${email}: ${error.message}`);
  sitzungen.push(supa);
  const extra = new Map();
  const cookie = () => [...jar].map(([n, v]) => `${n}=${v}`).concat([...extra].map(([n, v]) => `${n}=${v}`)).join("; ");
  const api = async (pfad, init = {}) => {
    const res = await fetch(`${APP}${pfad}`, {
      ...init,
      redirect: "manual",
      headers: { cookie: cookie(), ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    });
    // Gesetzte Cookies (z. B. neues Geräte-Cookie) übernehmen
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [paar] = c.split(";");
      const i = paar.indexOf("=");
      const name = paar.slice(0, i);
      const wert = paar.slice(i + 1);
      if (name.startsWith("eventline_")) { if (wert) extra.set(name, wert); else extra.delete(name); }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, json, location: res.headers.get("location") };
  };
  return { supa, api, extra };
}

async function direkteAbfragen(client, wer) {
  for (const t of ["employee_compensation", "payroll_defaults", "wage_documents", "trusted_devices", "lohn_dokument_protokoll", "lohn_lauf", "lohn_einstellungen", "lohn_dossiers"]) {
    const { data, error } = await client.from(t).select("*").limit(5);
    ok(!!error || (data ?? []).length === 0, `${wer}: SELECT ${t} → ${error ? "verweigert (" + (error.code ?? error.message) + ")" : (data ?? []).length + " Zeilen"}`);
  }
  for (const [fn, args] of [
    ["get_monthly_payroll_stats", { p_month_start: "2026-09-01" }],
    ["get_current_bvg_threshold", { p_as_of: "2026-09-01" }],
    ["get_location_stats", {}],
    ["is_trusted_device", { p_token_hash: "x", p_user_id: ID.admin }],
    ["lohn_fassung_speichern", { p_profile_id: ID.lara, p_doc_type: "lohnabrechnung", p_year: 2026, p_period_month: 9, p_storage_path: "x", p_file_size: 1, p_source: "auto", p_actor: null, p_actor_name: "x", p_notes: null }],
    ["geraet_notfreigabe", { p_device_id: ID.admin, p_grund: "x", p_durch: "x" }],
    ["lohn_dokument_archivieren", { p_id: ID.admin, p_actor: null, p_actor_name: "x", p_grund: "x" }],
  ]) {
    const { error } = await client.rpc(fn, args);
    ok(!!error, `${wer}: RPC ${fn} → ${error ? "verweigert (" + (error.code ?? error.message) + ")" : "ERLAUBT"}`);
  }
  // Schreibversuche
  const ins = await client.from("trusted_devices").insert({ user_id: ID.admin, cookie_token_hash: "x", device_name: "x", status: "approved" });
  ok(!!ins.error, `${wer}: INSERT trusted_devices → ${ins.error ? "verweigert" : "ERLAUBT"}`);
  const upd = await client.from("trusted_devices").update({ status: "approved" }).eq("user_id", ID.admin).select("id");
  ok(!!upd.error || (upd.data ?? []).length === 0, `${wer}: UPDATE trusted_devices → ${upd.error ? "verweigert" : (upd.data ?? []).length + " Zeilen"}`);
  const comp = await client.from("employee_compensation").insert({ profile_id: ID.lara, hourly_wage_chf: 99, effective_from: "2030-01-01" });
  ok(!!comp.error, `${wer}: INSERT employee_compensation → ${comp.error ? "verweigert" : "ERLAUBT"}`);
  for (const bucket of ["lohndokumente", "personal-dossiers"]) {
    const { data, error } = await client.storage.from(bucket).list(ID.lara, { limit: 5 });
    ok(!!error || (data ?? []).length === 0, `${wer}: Storage list ${bucket} → ${error ? "verweigert" : (data ?? []).length + " Einträge"}`);
  }
}

try {
  // -------------------------------------------------------------------------
  titel("Vorbereitung (nur lokal)");
  sql(`update lohn_einstellungen set lauf_ab = '2026-03-01', vertretung_profile_id = null, vertretung_name = null where id = 'default'`);
  // Eintritt Mitte Monat ohne Stunden (0-CHF-Monate): Admin Zwei ab 15.07.2026
  // Phase 2 (Migration 364): Lohnzeile in abgerechnetem Monat nur per Antrag — für die
  // Testvorbereitung über den protokollierten Notweg (wie ein Skript mit Grund).
  sql(`select set_config('lohn.notweg', 'an', false); insert into employee_compensation (profile_id, hourly_wage_chf, effective_from, notes)
       select '${ID.admin2}', 30, '2026-07-15', 'Test Phase 1: Eintritt 15.07., keine Stempel'
       where not exists (select 1 from employee_compensation where profile_id = '${ID.admin2}')`);
  ok(true, "lauf_ab = 2026-03, Eintritt-Testzeile Admin Zwei ab 15.07.2026");

  const lara = await login("lara.steiner@example.com");
  const admin = await login("lohn-admin@example.com");      // ohne Geräte-Cookie
  const adminG = await login("lohn-admin@example.com");     // mit Geräte-Cookie
  adminG.extra.set("eventline_trusted_device", "lokal-testgeraet-admin");
  const admin2G = await login("lohn-admin2@example.com");
  admin2G.extra.set("eventline_trusted_device", "lokal-testgeraet-admin2");
  const admin2 = await login("lohn-admin2@example.com");     // ohne Geräte-Cookie

  // -------------------------------------------------------------------------
  titel("A  Sicherheit direkt (Supabase-REST)");
  await direkteAbfragen(createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }), "nicht angemeldet");
  await direkteAbfragen(lara.supa, "Techniker (Lara)");
  await direkteAbfragen(admin.supa, "Admin");
  const consent = await lara.supa.rpc("get_my_wage_consent");
  ok(!consent.error, `Techniker: eigene Einwilligung (get_my_wage_consent) weiter lesbar`);

  // -------------------------------------------------------------------------
  titel("B  Sicherheit über die API");
  const { data: laraDoc0 } = await service.from("wage_documents").select("id").eq("profile_id", ID.lara).limit(1).maybeSingle();
  const lohnRouten = [
    ["GET", "/api/hr/compensation"],
    ["GET", "/api/hr/compensation/history?profile_id=" + ID.lara],
    ["GET", "/api/hr/monthly-stats?month=2026-09"],
    ["GET", `/api/hr/employee-detail?profile_id=${ID.lara}&month=2026-09`],
    ["GET", "/api/hr/lohn-defaults"],
    ["GET", "/api/hr/timesheet?profile_id=" + ID.lara + "&from=2026-09-01&to=2026-09-30"],
    ["GET", "/api/hr/wage-documents?profile_id=" + ID.mia],
    ["GET", "/api/hr/stundensaetze?ids=" + ID.lara],
    ["GET", "/api/hr/lohn-lauf"],
    ["GET", "/api/admin/job-costs?ids=" + ID.lara],
    ["POST", "/api/hr/wage-documents/generate", { profile_id: ID.lara, year: 2026, month: 8 }],
    ["POST", "/api/hr/compensation", { profile_id: ID.lara, hourly_wage_chf: 99 }],
    ["POST", `/api/admin/users/${ID.ben}/dossier`, {}],
    ["PUT", "/api/hr/lohn-einstellungen", { vertretung_profile_id: null }],
  ];
  for (const [methode, pfad, body] of lohnRouten) {
    const a = await lara.api(pfad, { method: methode, body: body ? JSON.stringify(body) : undefined });
    ok(a.status === 401 || a.status === 403 || a.status === 404, `Techniker ${methode} ${pfad.split("?")[0]} → ${a.status}`);
    const b = await admin.api(pfad, { method: methode, body: body ? JSON.stringify(body) : undefined });
    ok(b.status === 403 && (b.json?.error === "device_not_trusted" || /vertraut/i.test(b.json?.error ?? "")), `Admin ohne Gerät ${methode} ${pfad.split("?")[0]} → ${b.status} ${b.json?.error ?? ""}`);
  }
  if (laraDoc0) {
    const a = await admin.api(`/api/hr/wage-documents/${laraDoc0.id}`);
    ok(a.status === 403, `Admin ohne Gerät: fremdes Lohndokument herunterladen → ${a.status}`);
  }
  const bvgL = await lara.api("/api/hr/bvg-prognose?monat=2026-09");
  ok(bvgL.status === 403, `Techniker: BVG-Ampel → ${bvgL.status}`);
  const bvgA = await admin.api("/api/hr/bvg-prognose?monat=2026-09");
  ok(bvgA.status === 200 && Object.keys(bvgA.json?.personen ?? {}).length >= 0, `Admin ohne Gerät: BVG-Ampel (Lohnrecht, ohne Gerätezwang) → ${bvgA.status}`);
  const eigene = await lara.api("/api/hr/wage-documents");
  ok(eigene.status === 200, `Techniker: eigene Lohndokumente → ${eigene.status}`);
  const mitG = await adminG.api("/api/hr/compensation");
  ok(mitG.status === 200 && (mitG.json?.employees ?? []).length > 0, `Admin MIT Gerät: Mitarbeiter-Lohn → ${mitG.status}`);
  const statsG = await adminG.api("/api/hr/monthly-stats?month=2026-09");
  ok(statsG.status === 200 && (statsG.json?.employees ?? []).length > 0, `Admin MIT Gerät: Monatsstunden (RPC über Server) → ${statsG.status}`);
  const finG = await adminG.api("/finanzen");
  ok(finG.status === 200, `Admin MIT Gerät: Seite /finanzen → ${finG.status}`);
  const finApi = await adminG.api("/api/finanzen/uebersicht");
  ok(finApi.status !== 403, `Admin MIT Gerät: Finanzen-API /api/finanzen/uebersicht → ${finApi.status} (Gerätesperre lässt durch)`);
  const finApiOhne = await admin.api("/api/finanzen/uebersicht");
  ok(finApiOhne.status === 403 || finApiOhne.status === 404, `Admin ohne Gerät: Finanzen-API → ${finApiOhne.status}`);

  // -------------------------------------------------------------------------
  titel("C  Automatischer Lauf");
  const cron = (q = "") => fetch(`${APP}/api/cron/auto-lohnabrechnung${q}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const falsch = await fetch(`${APP}/api/cron/auto-lohnabrechnung`, { headers: { authorization: "Bearer falsch" } });
  ok(falsch.status === 401, `Cron mit falschem Geheimnis → ${falsch.status}`);
  const probe = await cron("?probe=1");
  const plan = probe.json?.plan ?? [];
  ok(probe.status === 200 && plan.length > 0, `Probelauf: ${plan.length} Abrechnungen geplant (nichts geschrieben)`);
  const planVon = (id) => plan.filter((p) => p.profile_id === id).map((p) => p.monat);
  ok(JSON.stringify(planVon(ID.ben)) === JSON.stringify(["2026-03", "2026-04", "2026-05", "2026-06"]), `Austritt 30.06. (Ben, inaktiv): ${planVon(ID.ben).join(", ")}`);
  ok(JSON.stringify(planVon(ID.admin2)) === JSON.stringify(["2026-07", "2026-08", "2026-09"]), `Eintritt 15.07. (Admin Zwei): ${planVon(ID.admin2).join(", ")}`);
  ok(planVon(ID.lara).length === 7, `Lara: alle 7 gesperrten Monate März–Sept geplant`);
  ok(!plan.some((p) => p.monat === "2026-10"), "Oktober (noch nicht gesperrt) nicht geplant");
  ok(Number(sql(`select count(*) from lohn_lauf`)) === 0, "Probelauf schreibt keinen Lauf-Eintrag");

  // Fehler simulieren: Speichern für Mia schlägt fehl (DB), Datei muss wieder weg sein.
  sql(`create or replace function pg_temp_lohn_test_fehler() returns trigger language plpgsql as $$ begin raise exception 'Testfehler: Speichern simuliert fehlgeschlagen'; end $$`);
  sql(`drop trigger if exists zz_lohn_test_fehler on wage_documents; create trigger zz_lohn_test_fehler before insert or update on wage_documents for each row when (new.profile_id = '${ID.mia}') execute function pg_temp_lohn_test_fehler()`);
  const lauf1 = await cron();
  const r1 = lauf1.json;
  const miaFehler = (r1.ergebnisse ?? []).filter((e) => e.profile_id === ID.mia);
  ok(lauf1.status === 200 && r1.status === "teilweise", `Lauf 1: Status ${r1.status}, ${r1.erstellt} erstellt, ${r1.fehler} Fehler, ${r1.offen} offen`);
  ok(miaFehler.length > 0 && miaFehler.every((e) => !e.ok), `Fehler nur bei Mia (${miaFehler.length} Monate): ${miaFehler[0]?.fehler ?? ""}`);
  ok((r1.ergebnisse ?? []).filter((e) => !e.ok && e.profile_id !== ID.mia).length === 0, "alle anderen Personen erfolgreich");
  ok(Number(sql(`select count(*) from wage_documents where profile_id = '${ID.mia}'`)) === 0, "Mia: keine Datenbankzeile");
  ok(Number(sql(`select count(*) from storage.objects where bucket_id = 'lohndokumente' and name like '${ID.mia}/%'`)) === 0, "Mia: keine verwaiste PDF (aufgeräumt)");
  const laufZeile = sql(`select status || '|' || fehler || '|' || coalesce(zusammenfassung,'') from lohn_lauf order by gestartet_at desc limit 1`);
  ok(laufZeile.startsWith("teilweise|"), `Lauf-Status sichtbar in lohn_lauf: ${laufZeile}`);
  ok(Number(sql(`select count(*) from notifications where title like 'Lohnlauf:%'`)) > 0, "Meldung an Personen mit Lohnrecht (Glocke)");
  ok(Number(sql(`select count(*) from wage_documents where profile_id = '${ID.ben}' and period_month > 6 and year = 2026`)) === 0, "Ben: nichts nach dem Austritt");

  sql(`drop trigger if exists zz_lohn_test_fehler on wage_documents; drop function if exists pg_temp_lohn_test_fehler()`);
  const pfadeVorher = sql(`select string_agg(storage_path, ',' order by storage_path) from wage_documents where profile_id = '${ID.lara}'`);
  const lauf2 = await cron();
  ok(lauf2.json.status === "ok" || lauf2.json.status === "teilweise", `Lauf 2 (Fehler behoben): Status ${lauf2.json.status}, ${lauf2.json.erstellt} erstellt, ${lauf2.json.fehler} Fehler`);
  ok((lauf2.json.ergebnisse ?? []).every((e) => e.profile_id === ID.mia || (r1.offen > 0)), "Lauf 2 holt Mia nach (andere schon vorhanden)");
  const pfadeNachher = sql(`select string_agg(storage_path, ',' order by storage_path) from wage_documents where profile_id = '${ID.lara}'`);
  ok(pfadeVorher === pfadeNachher, "Lauf 2 überschreibt nichts (Laras Fassungen unverändert)");
  const nullCHF = sql(`select count(*) from wage_documents where profile_id = '${ID.admin2}' and year = 2026 and period_month in (7,8,9) and archived_at is null`);
  ok(Number(nullCHF) === 3, `0-CHF-Monate (Eintritt ohne Stunden) erzeugt: ${nullCHF}`);
  const lauf3 = await cron();
  ok(lauf3.json.erstellt === 0 && lauf3.json.fehler === 0 && lauf3.json.geplant === 0, `Lauf 3: nichts mehr zu tun (geplant ${lauf3.json.geplant})`);

  // -------------------------------------------------------------------------
  titel("D  Generieren, Fassungen, Papierkorb");
  const okt = await adminG.api("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.lara, year: 2026, month: 10 }) });
  ok(okt.status === 400 && okt.json?.code === "nicht_gesperrt", `Oktober (nicht gesperrt) → ${okt.status} ${okt.json?.code}`);
  const doppelt = await adminG.api("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.lara, year: 2026, month: 9 }) });
  ok(doppelt.status === 409 && doppelt.json?.requires_confirm === "neue_fassung", `September schon vorhanden → ${doppelt.status} (Rückfrage)`);
  const v1 = sql(`select storage_path from wage_documents where profile_id = '${ID.lara}' and year = 2026 and period_month = 9 and archived_at is null and superseded_at is null`);
  const neu = await adminG.api("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.lara, year: 2026, month: 9, neue_fassung: true, begruendung: "Test Phase 1: neue Fassung (ab Phase 2 Korrekturfassung mit Begründung)" }) });
  ok(neu.status === 200 && neu.json?.version === 2, `neue Fassung → ${neu.status}, Fassung ${neu.json?.version}, Modus ${neu.json?.mode}`);
  const v2 = sql(`select storage_path from wage_documents where profile_id = '${ID.lara}' and year = 2026 and period_month = 9 and archived_at is null and superseded_at is null`);
  ok(v1 !== v2, "neuer Speicherpfad je Fassung");
  ok(Number(sql(`select count(*) from storage.objects where bucket_id = 'lohndokumente' and name = '${v1}'`)) === 1, "alte Datei (Fassung 1) liegt weiterhin im Speicher");
  ok(sql(`select vorheriger_storage_path from lohn_dokument_protokoll where storage_path = '${v2}'`) === v1, "Protokoll kennt die vorherige Datei");
  const docId = sql(`select id from wage_documents where storage_path = '${v2}'`);
  const korb = await adminG.api(`/api/hr/wage-documents/${docId}`, { method: "DELETE", body: JSON.stringify({ grund: "Test Papierkorb" }) });
  ok(korb.status === 200, `in den Papierkorb → ${korb.status}`);
  ok(Number(sql(`select count(*) from wage_documents where id = '${docId}'`)) === 1, "Zeile bleibt (archiviert, nicht gelöscht)");
  const eigene2 = (await lara.api("/api/hr/wage-documents")).json?.documents ?? [];
  ok(!eigene2.some((d) => d.id === docId), "Mitarbeiterin sieht das archivierte Dokument nicht mehr");
  const korbListe = (await adminG.api(`/api/hr/wage-documents?profile_id=${ID.lara}&papierkorb=1`)).json?.documents ?? [];
  ok(korbListe.some((d) => d.id === docId), "Papierkorb-Ansicht zeigt es");
  const nachKorb = await adminG.api("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.lara, year: 2026, month: 9 }) });
  ok(nachKorb.status === 409 && /Papierkorb/.test(nachKorb.json?.error ?? ""), `Erzeugen bei Abrechnung im Papierkorb → ${nachKorb.status} (Rückfrage)`);
  const laufKorb = await cron();
  ok(laufKorb.json.erstellt === 0 && (laufKorb.json.hinweise ?? []).some((h) => /Papierkorb/.test(h.text)), "Lauf erzeugt Papierkorb-Monat nicht neu (Hinweis)");
  const zurueck = await adminG.api(`/api/hr/wage-documents/${docId}/wiederherstellen`, { method: "POST", body: "{}" });
  ok(zurueck.status === 200, `wiederherstellen → ${zurueck.status}`);
  ok(sql(`select string_agg(aktion, ',' order by occurred_at) from lohn_dokument_protokoll where wage_document_id = '${docId}'`).includes("archiviert,wiederhergestellt"), "Protokoll: archiviert, wiederhergestellt");
  const loeschen = sql(`select 1`) && (() => { try { sql(`delete from wage_documents where id = '${docId}'`); return false; } catch { return true; } })();
  ok(loeschen, "DB verweigert endgültiges Löschen (auch als Superuser-Rolle)");
  const pfadAendern = (() => { try { sql(`update wage_documents set storage_path = 'x.pdf' where id = '${docId}'`); return false; } catch { return true; } })();
  ok(pfadAendern, "DB verweigert stilles Umstellen der Datei einer Fassung");
  const eigenErz = await adminG.api("/api/hr/wage-documents/generate", { method: "POST", body: JSON.stringify({ profile_id: ID.admin, year: 2026, month: 9 }) });
  ok(eigenErz.status === 403, `eigene Lohnabrechnung erzeugen (Vier Augen) → ${eigenErz.status}`);
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }), "t.pdf");
  fd.append("profile_id", ID.mia); fd.append("doc_type", "lohnabrechnung"); fd.append("year", "2026"); fd.append("period_month", "11");
  const upOffen = await adminG.api("/api/hr/wage-documents", { method: "POST", body: fd });
  ok(upOffen.status === 400, `Upload Lohnabrechnung für offenen Monat (11/2026) → ${upOffen.status}`);
  const dl = await lara.api(`/api/hr/wage-documents/${docId}`);
  ok(dl.status === 200 && !!dl.json?.url, `Mitarbeiterin lädt eigene gültige Fassung → ${dl.status}`);

  // -------------------------------------------------------------------------
  titel("E  Lohn-Editor: Sonderwerte bleiben");
  const lenaVor = sql(`select ferienanteil_pct_override from employee_compensation where profile_id = '${ID.lena}' and effective_from = '2026-10-01'`);
  const s1 = await adminG.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({
    profile_id: ID.lena, hourly_wage_chf: 24, uses_standard_lohn: true, wage_exempt: false, auto_lohnabrechnung: true, effective_from: "2026-10-01", notes: "Test Speichern",
  }) });
  const lenaNach = sql(`select ferienanteil_pct_override from employee_compensation where profile_id = '${ID.lena}' and effective_from = '2026-10-01'`);
  ok(s1.status === 200 && lenaVor === "8.33" && lenaNach === "8.33", `Lena: Speichern ohne Override-Feld → Override bleibt ${lenaNach} (vorher ${lenaVor})`);
  const lucaVor = sql(`select quellensteuer_pct || '|' || uses_standard_lohn from employee_compensation where profile_id = '${ID.luca}' and effective_from = '2026-03-09'`);
  const s2 = await adminG.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({
    profile_id: ID.luca, hourly_wage_chf: 29, wage_exempt: false, auto_lohnabrechnung: true, effective_from: "2026-03-09", notes: "Test ohne Satzfelder",
  }) });
  const lucaNach = sql(`select quellensteuer_pct || '|' || uses_standard_lohn from employee_compensation where profile_id = '${ID.luca}' and effective_from = '2026-03-09'`);
  ok(s2.status === 200 && lucaVor === lucaNach && lucaNach.startsWith("10.58"), `Luca: Speichern ohne Satzfelder → eigene Sätze bleiben (${lucaNach})`);
  const luca2027 = sql(`select quellensteuer_pct from employee_compensation where profile_id = '${ID.luca}' and effective_from = '2027-01-01'`);
  ok(luca2027 === "10.5800", `Luca: Zeile ab 2027 unberührt (QST ${luca2027})`);

  // -------------------------------------------------------------------------
  titel("F  Vier Augen, Gerätefreigabe, «Ansicht als»");
  const selbst = await adminG.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({ profile_id: ID.admin, hourly_wage_chf: 99 }) });
  ok(selbst.status === 403 && /eigenen Lohn/.test(selbst.json?.error ?? ""), `Admin ändert eigenen Lohn → ${selbst.status}`);
  const fremdAdmin = await admin2G.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({ profile_id: ID.admin2, hourly_wage_chf: 31, effective_from: "2026-07-15" }) });
  ok(fremdAdmin.status === 403, `Admin Zwei ändert eigenen Lohn → ${fremdAdmin.status}`);
  const durchAndern = await adminG.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({ profile_id: ID.admin2, hourly_wage_chf: 30, uses_standard_lohn: true, effective_from: "2026-07-15" }) });
  ok(durchAndern.status === 200, `anderer Admin ändert Lohn von Admin Zwei → ${durchAndern.status}`);

  // Neues Gerät für Admin Zwei (ohne Cookie)
  const admin2Neu = await login("lohn-admin2@example.com");
  const anfrage = await admin2Neu.api("/api/trust/devices", { method: "POST", body: JSON.stringify({ device_name: "Test-Laptop Phase 1" }) });
  const devId = anfrage.json?.device_id;
  ok(anfrage.status === 200 && anfrage.json?.pending === true, `Anfrage neues Gerät → ${anfrage.status}, wartet`);
  const anfrage2 = await admin2Neu.api("/api/trust/devices", { method: "POST", body: JSON.stringify({ device_name: "Test-Laptop Phase 1" }) });
  ok(anfrage2.json?.pending === true && !anfrage2.json?.reused, "kein Schnellweg (gleicher Browser-Typ gibt keinen Zugang)");
  const sperrt = await admin2Neu.api("/api/hr/compensation");
  ok(sperrt.status === 403, `vor der Freigabe kein Zugang → ${sperrt.status}`);
  const selbstFrei = await admin2G.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: devId, aktion: "freigeben" }) });
  ok(selbstFrei.status === 403, `Admin Zwei gibt eigenes Gerät frei → ${selbstFrei.status}`);
  const ohneGeraet = await admin.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: devId, aktion: "freigeben" }) });
  ok(ohneGeraet.status === 403, `anderer Admin OHNE eigenes vertrautes Gerät → ${ohneGeraet.status}`);
  const technikerFrei = await lara.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: devId, aktion: "freigeben" }) });
  ok(technikerFrei.status === 403, `Techniker gibt frei → ${technikerFrei.status}`);
  const frei = await adminG.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: anfrage2.json?.device_id, aktion: "freigeben" }) });
  ok(frei.status === 200, `anderer Admin mit Gerät gibt frei (Knopf) → ${frei.status}`);
  const nachFrei = await admin2Neu.api("/api/hr/compensation");
  ok(nachFrei.status === 200, `danach Zugang → ${nachFrei.status}`);
  ok(sql(`select count(*) from permission_audit_log where action = 'device.approved' and target_profile_id = '${ID.admin2}'`) !== "0", "Freigabe im Rechte-Protokoll");
  // abgelaufene Anfrage
  sql(`update trusted_devices set anfrage_gueltig_bis = now() - interval '1 minute' where id = '${devId}'`);
  const alt = await adminG.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: devId, aktion: "freigeben" }) });
  ok(alt.status === 410, `Anfrage älter als 24 h → ${alt.status}`);
  // alter Mail-Link gibt nicht frei
  const tokenRoh = "lokaler-alter-bestaetigungslink";
  const altId = sql(`insert into trusted_devices (user_id, cookie_token_hash, confirm_token_hash, device_name, status) values ('${ID.lara}', encode(extensions.digest('x-${Date.now()}', 'sha256'), 'hex'), encode(extensions.digest('${tokenRoh}', 'sha256'), 'hex'), 'Altes Gerät', 'pending') returning id`).split("\n")[0];
  const link = await fetch(`${APP}/api/trust/confirm?token=${tokenRoh}`, { redirect: "manual" });
  ok(link.status === 302 && (link.headers.get("location") ?? "").includes("/geraet-freigabe"), `alter Link → ${link.status} ${link.headers.get("location")}`);
  ok(sql(`select status from trusted_devices where id = '${altId}'`) === "pending", "alter Link gibt NICHT frei (bleibt pending)");
  // Notweg (Skript mit Service-Schlüssel, protokolliert)
  execFileSync("node", ["scripts/geraet-notfreigabe.mjs", altId, "Test Notweg Phase 1", "Mischa (Test)"], { cwd: root, encoding: "utf8" });
  ok(sql(`select status || '|' || freigabe_art from trusted_devices where id = '${altId}'`) === "approved|notweg", "Notweg-Skript gibt frei");
  ok(sql(`select count(*) from permission_audit_log where action = 'device.notfreigabe' and details->>'grund' = 'Test Notweg Phase 1'`) === "1", "Notweg im Rechte-Protokoll mit Grund");

  // Abwesenheit: Entscheid nicht zurücksetzbar; Firmensätze: gültige nicht löschbar/verschiebbar
  const toId = sql(`insert into time_off (user_id, start_date, end_date, type, status) values ('${ID.lara}', '2026-12-01', '2026-12-02', 'ferien', 'genehmigt') returning id`).split("\n")[0];
  ok((() => { try { sql(`update time_off set status = 'beantragt' where id = '${toId}'`); return false; } catch { return true; } })(), "entschiedene Abwesenheit nicht auf «beantragt» zurücksetzbar");
  ok((() => { try { sql(`delete from time_off where id = '${toId}'`); return false; } catch { return true; } })(), "entschiedene Abwesenheit nicht löschbar");
  ok((() => { try { sql(`update payroll_defaults set effective_from = '2099-01-01' where effective_from = '2026-03-09'`); return false; } catch { return true; } })(), "gültige Firmensätze nicht verschiebbar");
  ok((() => { try { sql(`delete from payroll_defaults where effective_from = '2026-03-09'`); return false; } catch { return true; } })(), "gültige Firmensätze nicht löschbar");
  // Geräteanfragen begrenzt
  for (let i = 0; i < 3; i++) await lara.api("/api/trust/devices", { method: "POST", body: JSON.stringify({ device_name: `Flut ${i}` }) });
  const flut = await lara.api("/api/trust/devices", { method: "POST", body: JSON.stringify({ device_name: "Flut 4" }) });
  ok(flut.status === 429, `4. offene Geräteanfrage in 24 h → ${flut.status}`);

  // «Ansicht als»
  sql(`update profiles set developer_mode_enabled = true where id = '${ID.admin}'`);
  // Von Hand gesetztes Cookie (ohne Start im Rechte-Protokoll) zählt nicht
  const handCookie = await login("lohn-admin@example.com");
  handCookie.extra.set("eventline_impersonate_user_id", ID.mia);
  const hand = await handCookie.api("/api/hr/wage-documents");
  ok(hand.status === 200 && !hand.json?.ansicht_als, "von Hand gesetztes «Ansicht als»-Cookie wird ignoriert (nicht protokolliert = nicht aktiv)");
  const start = await adminG.api("/api/dev/impersonate", { method: "POST", body: JSON.stringify({ target_user_id: ID.lara }) });
  ok(start.status === 200, `«Ansicht als» Lara starten → ${start.status}`);
  ok(sql(`select count(*) from permission_audit_log where action = 'view_as.started' and target_profile_id = '${ID.lara}'`) !== "0", "«Ansicht als» im Rechte-Protokoll");
  const ansDocs = await adminG.api("/api/hr/wage-documents");
  ok(ansDocs.json?.ansicht_als === true && (ansDocs.json?.documents ?? []).length === 0, "«Ansicht als»: keine Lohndokumente der angesehenen Person");
  const ansDash = await adminG.api("/api/dashboard");
  ok(ansDash.status === 200 && ansDash.json?.monat == null && !(ansDash.json?.bereiche ?? []).includes("monat"), "«Ansicht als»: kein «Mein Monat»");
  await adminG.api("/api/dev/impersonate/write", { method: "POST", body: JSON.stringify({ enabled: true }) });
  const einw = await adminG.api("/api/hr/wage-documents/accept-digital", { method: "POST", body: "{}" });
  ok(einw.status === 403, `«Ansicht als» (Bearbeitung an): Einwilligung im Namen anderer → ${einw.status}`);
  const stop = await adminG.api("/api/dev/impersonate", { method: "DELETE" });
  ok(stop.status === 200 && sql(`select count(*) from permission_audit_log where action = 'view_as.stopped'`) !== "0", "«Ansicht als» beendet + protokolliert");
  sql(`update profiles set developer_mode_enabled = false where id = '${ID.admin}'`);

  // -------------------------------------------------------------------------
  titel("H  Vier Augen bei Rechten (Strohmann-Schutz)");
  const rechte = (who, id, aktion) => who.api("/api/admin/rechte-antraege", { method: "POST", body: JSON.stringify({ id, aktion }) });
  // Direktzugriff mit Admin-Login (REST, RLS erlaubt Admins das Bearbeiten) — DB-Trigger verweigert
  const hr1 = await admin.supa.from("profiles").update({ role: "admin" }).eq("id", ID.lara).select("id");
  ok(!!hr1.error, `Admin per REST: Lara zur Admin-Rolle → ${hr1.error ? "verweigert" : "ERLAUBT"}`);
  const { data: tech } = await service.from("roles").select("permissions").eq("slug", "techniker").single();
  const hr2 = await admin.supa.from("roles").update({ permissions: [...(tech?.permissions ?? []), "lohn:manage"] }).eq("slug", "techniker").select("slug");
  ok(!!hr2.error, `Admin per REST: Lohnrecht an Rolle «techniker» → ${hr2.error ? "verweigert" : "ERLAUBT"}`);
  ok((() => { try { sql(`update profiles set role = 'admin' where id = '${ID.lara}'`); return false; } catch { return true; } })(), "Server-Schlüssel/SQL direkt: Admin-Rolle vergeben verweigert");
  ok((() => { try { sql(`update lohn_einstellungen set vertretung_profile_id = '${ID.lena}'`); return false; } catch { return true; } })(), "SQL direkt: Vertretung ändern verweigert");
  const neuAdmin = await adminG.api("/api/admin/users", { method: "POST", body: JSON.stringify({ email: "strohmann@example.com", full_name: "Stroh Mann", role: "admin" }) });
  ok(neuAdmin.status === 400, `neues Konto direkt als Admin anlegen → ${neuAdmin.status}`);

  // Strohmann: A macht Mia zum Admin, gibt Mia ein Gerät frei, Mia ändert A's Lohn → muss scheitern
  const h1 = await adminG.api(`/api/admin/users/${ID.mia}`, { method: "PATCH", body: JSON.stringify({ role: "admin" }) });
  const antragMia = h1.json?.antrag?.id;
  ok(h1.status === 200 && !!antragMia, `A: Mia → Admin ergibt nur einen Antrag (${h1.status})`);
  ok(sql(`select role from profiles where id = '${ID.mia}'`) === "techniker", "Mia bleibt Technikerin bis zur Bestätigung");
  const doppelt2 = await adminG.api(`/api/admin/users/${ID.mia}`, { method: "PATCH", body: JSON.stringify({ role: "admin" }) });
  ok(doppelt2.status === 409, `zweiter Antrag für dieselbe Person → ${doppelt2.status}`);
  const miaS = await login("mia.keller@example.com");
  const miaGeraet = await miaS.api("/api/trust/devices", { method: "POST", body: JSON.stringify({ device_name: "Strohmann-Gerät" }) });
  const miaFrei = await adminG.api("/api/trust/freigabe", { method: "POST", body: JSON.stringify({ id: miaGeraet.json?.device_id, aktion: "freigeben" }) });
  ok(miaFrei.status === 200, `A gibt Mias Gerät frei → ${miaFrei.status}`);
  const angriff = await miaS.api("/api/hr/compensation", { method: "POST", body: JSON.stringify({ profile_id: ID.admin, hourly_wage_chf: 99, effective_from: "2026-03-09" }) });
  ok(angriff.status === 403, `Mia (unbestätigt) ändert A's Lohn → ${angriff.status}`);
  const angriffAntrag = await miaS.api("/api/admin/rechte-antraege", { method: "POST", body: JSON.stringify({ id: antragMia, aktion: "bestaetigen" }) });
  ok(angriffAntrag.status === 403, `Mia bestätigt die eigene Beförderung → ${angriffAntrag.status}`);
  const selbstB = await rechte(adminG, antragMia, "bestaetigen");
  ok(selbstB.status === 403, `A bestätigt den eigenen Antrag → ${selbstB.status}`);
  const ohneG = await rechte(admin2, antragMia, "bestaetigen");
  ok(ohneG.status === 403, `anderer Admin OHNE vertrautes Gerät → ${ohneG.status}`);
  ok((() => { try { sql(`select rechte_antrag_ausfuehren('${antragMia}', '${ID.admin}', 'Test', null)`); return false; } catch { return true; } })(), "DB-Funktion: Antragsteller als Bestätiger verweigert");
  const okB = await rechte(admin2G, antragMia, "bestaetigen");
  ok(okB.status === 200 && sql(`select role from profiles where id = '${ID.mia}'`) === "admin", `anderer Admin mit Gerät bestätigt → ${okB.status}, Mia ist Admin`);
  ok(sql(`select count(*) from permission_audit_log where action = 'rechte.antrag_bestaetigt' and target_profile_id = '${ID.mia}'`) === "1", "Bestätigung im Rechte-Protokoll");
  // zurück: A beantragt Mia → Technikerin, anderer Admin bestätigt
  const zur = await adminG.api(`/api/admin/users/${ID.mia}`, { method: "PATCH", body: JSON.stringify({ role: "techniker" }) });
  const zurB = await rechte(admin2G, zur.json?.antrag?.id, "bestaetigen");
  ok(zurB.status === 200 && sql(`select role from profiles where id = '${ID.mia}'`) === "techniker", "Entzug ebenfalls per Antrag + Bestätigung");

  // Lohnrecht an einer Rolle: Antrag, Ablehnen
  const rr = await adminG.api("/api/admin/roles/techniker", { method: "PATCH", body: JSON.stringify({ permissions: [...(tech?.permissions ?? []), "lohn:manage"] }) });
  ok(rr.status === 200 && !!rr.json?.antrag?.id, `Lohnrecht an Rolle «techniker» → Antrag (${rr.status})`);
  ok(sql(`select permissions ? 'lohn:manage' from roles where slug = 'techniker'`) === "f", "Rolle bleibt ohne Lohnrecht");
  const abl = await rechte(admin2G, rr.json?.antrag?.id, "ablehnen");
  ok(abl.status === 200 && sql(`select status from rechte_antraege where id = '${rr.json?.antrag?.id}'`) === "abgelehnt", "anderer Admin lehnt ab");

  // Abgelaufen
  const alt2 = await adminG.api(`/api/admin/users/${ID.lena}`, { method: "PATCH", body: JSON.stringify({ role: "admin" }) });
  sql(`update rechte_antraege set gueltig_bis = now() - interval '1 minute' where id = '${alt2.json?.antrag?.id}'`);
  const altB = await rechte(admin2G, alt2.json?.antrag?.id, "bestaetigen");
  ok(altB.status === 410, `Antrag älter als 24 h → ${altB.status}`);

  // Vertretung: Antrag, Notweg-Skript, Rückweg per Bestätigung
  const vt = await adminG.api("/api/hr/lohn-einstellungen", { method: "PUT", body: JSON.stringify({ vertretung_profile_id: ID.lena }) });
  ok(vt.status === 200 && !!vt.json?.antrag?.id && sql(`select coalesce(vertretung_profile_id::text, '-') from lohn_einstellungen`) === "-", "Vertretung → nur Antrag");
  execFileSync("node", ["scripts/rechte-notfreigabe.mjs", vt.json.antrag.id, "Test Notweg Rechte", "Mischa (Test)"], { cwd: root, encoding: "utf8" });
  ok(sql(`select vertretung_profile_id from lohn_einstellungen`) === ID.lena, "Notweg-Skript führt den Antrag aus");
  ok(sql(`select count(*) from permission_audit_log where action = 'rechte.antrag_notweg' and details->>'grund' = 'Test Notweg Rechte'`) === "1", "Notweg im Rechte-Protokoll mit Grund");
  const vt2 = await adminG.api("/api/hr/lohn-einstellungen", { method: "PUT", body: JSON.stringify({ vertretung_profile_id: null }) });
  const vt2B = await rechte(admin2G, vt2.json?.antrag?.id, "bestaetigen");
  ok(vt2B.status === 200 && sql(`select coalesce(vertretung_profile_id::text, '-') from lohn_einstellungen`) === "-", "Vertretung wieder leer (bestätigt)");

  // Gegenprüfung 2: neue Rolle mit Lohnrecht — vor der Bestätigung jemanden hineinsetzen → Antrag veraltet
  const neuRolle = await adminG.api("/api/admin/roles", { method: "POST", body: JSON.stringify({ label: "GP Rolle Phase1", permissions: ["lohn:manage"] }) });
  const neuRolleAntrag = neuRolle.json?.antrag?.id;
  ok(neuRolle.status === 200 && !!neuRolleAntrag && sql(`select permissions ? 'lohn:manage' from roles where slug = 'gp-rolle-phase1'`) === "f", "neue Rolle entsteht ohne Lohnrecht, Lohnrecht nur als Antrag");
  const hinein = await adminG.api(`/api/admin/users/${ID.lara}`, { method: "PATCH", body: JSON.stringify({ role: "gp-rolle-phase1" }) });
  ok(hinein.status === 200 && !hinein.json?.antrag, "Lara in die (noch rechtlose) Rolle gesetzt");
  const veraltet = await rechte(admin2G, neuRolleAntrag, "bestaetigen");
  ok(veraltet.status === 400 && /veraltet/.test(veraltet.json?.error ?? ""), `Bestätigen nach Personenwechsel in der Rolle → ${veraltet.status} (veraltet)`);
  ok(sql(`select permissions ? 'lohn:manage' from roles where slug = 'gp-rolle-phase1'`) === "f", "Rolle bleibt ohne Lohnrecht");
  await rechte(adminG, neuRolleAntrag, "ablehnen");
  await adminG.api(`/api/admin/users/${ID.lara}`, { method: "PATCH", body: JSON.stringify({ role: "techniker" }) });
  await adminG.api("/api/admin/roles/gp-rolle-phase1", { method: "DELETE" });
  ok((() => { try { sql(`update roles set slug = 'techniker-alt' where slug = 'techniker'`); return false; } catch { return true; } })(), "Rollen umbenennen verweigert");
  ok((() => { try { sql(`begin; delete from lohn_einstellungen; insert into lohn_einstellungen (id, vertretung_profile_id) values ('default', '${ID.lara}'); commit;`); return false; } catch { return true; } })(), "Vertretung über Löschen+Einfügen verweigert");
  ok(sql(`select count(*) from lohn_einstellungen`) === "1", "Lohn-Einstellungen unversehrt");

  // -------------------------------------------------------------------------
  titel("G  Benutzer löschen = archivieren; Dossier");
  const benDateienVor = sql(`select count(*) from storage.objects where bucket_id = 'lohndokumente' and name like '${ID.ben}/%'`);
  const del = await adminG.api(`/api/admin/users/${ID.ben}`, { method: "DELETE" });
  ok(del.status === 409 && del.json?.archiviert_statt_geloescht === true, `Ben löschen → ${del.status}: ${del.json?.error ?? ""}`);
  ok(sql(`select count(*) from profiles where id = '${ID.ben}'`) === "1", "Profil bleibt");
  ok(sql(`select count(*) from storage.objects where bucket_id = 'lohndokumente' and name like '${ID.ben}/%'`) === benDateienVor && benDateienVor !== "0", `Lohn-PDFs bleiben (${benDateienVor})`);
  const imp = await adminG.api(`/api/admin/users/${ID.ben}/impact`);
  ok(imp.json?.can_delete_directly === false && (imp.json?.aufbewahrung ?? []).length > 0, "Lösch-Vorschau zeigt Aufbewahrungspflicht");
  const dos = await adminG.api(`/api/admin/users/${ID.ben}/dossier`, { method: "POST", body: "{}" });
  ok(dos.status === 200, `Dossier mit Gerät → ${dos.status}`);
  const bis = sql(`select aufbewahren_bis from lohn_dossiers where profile_id = '${ID.ben}' order by erstellt_at desc limit 1`);
  ok(/^20(3[6-9])-/.test(bis), `Dossier registriert, aufbewahren bis ${bis}`);
  ok((() => { try { sql(`delete from lohn_dossiers where profile_id = '${ID.ben}'`); return false; } catch { return true; } })(), "Dossier-Register nicht löschbar");
} catch (e) {
  ok(false, `Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  try { sql(`drop trigger if exists zz_lohn_test_fehler on wage_documents; drop function if exists pg_temp_lohn_test_fehler()`); } catch { /* schon weg */ }
  for (const s of sitzungen) await s.auth.signOut({ scope: "local" });
  console.log(`\n${fehler === 0 ? "ALLES OK" : fehler + " FEHLER"} — Sitzungen nur lokal abgemeldet.`);
  process.exitCode = fehler === 0 ? 0 : 1;
}
