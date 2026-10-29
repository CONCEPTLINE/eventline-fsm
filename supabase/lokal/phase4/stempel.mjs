// Prüfmodul A «Stempel» (Lohn-Umbau Phase 4) — NUR LOKAL.
// Aufruf: node supabase/lokal/pruefen-phase4.mjs stempel
//
// Läuft gegen die aktuelle Test-DB und legt seine Daten selbst an
// (Beschreibung/Titel «P4-Stempel-Test …», Dezember 2026 = offener Monat,
// September 2026 = gesperrt). Räumt vorher und nachher auf (Notweg nur für
// die eigenen Testdaten), stellt den geänderten Stempel von Lara wieder her,
// lehnt eigene offene Anträge ab und verwirft eigene Korrektur-Vorschläge.
//
//   A0 Grenze 16 h an drei Stellen gleich (DB, Lohn-Kern, Client)
//   A1 Überlappung (supabase-js als Techniker): 23P01, angrenzend erlaubt,
//      zwei Geräte gleichzeitig, Altfall Noah 11.09. bleibt
//   A2 lange Stempel nur mit Begründung
//   A3 «geprüft»/«Altfall» setzt nur die Lohnverwaltung
//   A4 Sperre auch für den Server (service_role) und RLS im Browser
//   A5 Stempel-Antrag: ändern, nachtragen, löschen nach der Sperre (Vier Augen)
//   A6 /api/hr/stempel-pruefen
//   A7 Ticket «Stempel-Änderung»: Überlappung → Klartext, > 16 h, gesperrter
//      Monat → Antrag, normaler Weg (apply_ticket)

import fs from "node:fs";
import path from "node:path";

const TEST = "P4-Stempel-Test";

/** Zürcher Wandzeit mit Offset → UTC-ISO. */
const z = (s) => new Date(s).toISOString();

export async function pruefe(ctx) {
  const { ok, titel, sql, login, post, ID, service, root } = ctx;
  const eigeneAntraege = [];

  const aufraeumen = () => {
    sql(`select set_config('lohn.notweg','an',true);
         delete from tickets where title like '${TEST}%';
         delete from time_entries where description like '${TEST}%';`);
  };

  titel("A0 Stempel — Vorbereitung und Grenze 16 h");
  aufraeumen();
  const lara = await login("lara");
  const lara2 = await login("lara");
  const admin = await login("admin");
  const admin2 = await login("admin2");

  const db = Number(sql("select extract(epoch from stempel_lang_grenze()) / 3600"));
  const kern = /STEMPEL_LANG_STUNDEN = (\d+)/.exec(fs.readFileSync(path.join(root, "src/lib/lohn/stempel-pruefung.ts"), "utf8"))?.[1];
  const client = /export const LANG_STUNDEN = (\d+)/.exec(fs.readFileSync(path.join(root, "src/lib/stempel-meldungen.ts"), "utf8"))?.[1];
  ok(db === 16 && kern === "16" && client === "16", `Grenze lange Stempel gleich: DB ${db} h, Kern ${kern} h, Client ${client} h`);

  const ins = (s, werte) =>
    s.supa.from("time_entries").insert({ user_id: s.userId, description: TEST, ...werte }).select("id").single();

  // -------------------------------------------------------------------------
  titel("A1 Überlappung (Regel 368)");
  const a = await ins(lara, { clock_in: z("2026-12-14T08:00:00+01:00"), clock_out: z("2026-12-14T12:00:00+01:00") });
  ok(!a.error && a.data?.id, `Techniker legt Stempel 14.12. 08:00–12:00 an ${a.error?.message ?? ""}`);
  const b = await ins(lara, { clock_in: z("2026-12-14T11:00:00+01:00"), clock_out: z("2026-12-14T13:00:00+01:00") });
  ok(b.error?.code === "23P01" && /time_entries_keine_ueberlappung/.test(b.error?.message ?? ""), `überlappend 11:00–13:00 → ${b.error?.code ?? "gespeichert!"}`);
  ok(/conflicts with existing key/.test(b.error?.details ?? ""), "Fehler-Details nennen den bestehenden Stempel (Klartext-Fallback)");
  const rpc = await lara.supa.rpc("stempel_ueberlappung", {
    p_user: lara.userId, p_von: z("2026-12-14T11:00:00+01:00"), p_bis: z("2026-12-14T13:00:00+01:00"), p_ohne: null,
  });
  ok(rpc.data?.[0]?.id === a.data?.id, `stempel_ueberlappung als Techniker (RLS) findet den Stempel ${rpc.error?.message ?? ""}`);
  const c = await ins(lara, { clock_in: z("2026-12-14T12:00:00+01:00"), clock_out: z("2026-12-14T14:00:00+01:00") });
  ok(!c.error, `angrenzend [08:00, 12:00) + [12:00, 14:00) erlaubt ${c.error?.message ?? ""}`);
  const offenDanach = await ins(lara, { clock_in: z("2026-12-14T13:00:00+01:00") });
  ok(offenDanach.error?.code === "23P01", `offener Stempel ab 13:00 (bis «unendlich») überschneidet 12–14 → ${offenDanach.error?.code ?? "gespeichert!"}`);
  const [g1, g2] = await Promise.all([
    ins(lara, { clock_in: z("2026-12-15T08:00:00+01:00"), clock_out: z("2026-12-15T10:00:00+01:00") }),
    ins(lara2, { clock_in: z("2026-12-15T09:00:00+01:00"), clock_out: z("2026-12-15T11:00:00+01:00") }),
  ]);
  ok([g1, g2].filter((r) => !r.error).length === 1 && [g1, g2].some((r) => r.error?.code === "23P01"),
    `zwei Geräte gleichzeitig (08–10 / 09–11): genau einer gespeichert, der andere 23P01`);
  const altfall = sql(`select count(*) from time_entries where user_id = '${ID.noah}' and ueberlappung_altfall and (clock_in at time zone 'Europe/Zurich')::date = '2026-09-11'`);
  ok(altfall === "2", `Altfall Noah 11.09.: beide Stempel bleiben, markiert (${altfall})`);
  const noahUeb = sql(`select count(*) from stempel_ueberlappung('${ID.noah}', '2026-09-11 19:30+00', '2026-09-11 20:00+00', null)`);
  ok(noahUeb === "0", "Altfälle zählen nicht als Überschneidung");

  // -------------------------------------------------------------------------
  titel("A2 Lange Stempel nur mit Begründung");
  const l1 = await ins(lara, { clock_in: z("2026-12-17T06:00:00+01:00"), clock_out: z("2026-12-17T23:00:00+01:00") });
  ok(l1.error?.code === "P0001" && /über 16 Stunden/.test(l1.error?.message ?? ""), `17 h ohne Begründung → ${l1.error?.message ?? "gespeichert!"}`);
  const l2 = await ins(lara, { clock_in: z("2026-12-17T06:00:00+01:00"), clock_out: z("2026-12-17T23:00:00+01:00"), lang_begruendung: "Aufbau und Anlass am Stück" });
  ok(!l2.error, `17 h mit Begründung erlaubt ${l2.error?.message ?? ""}`);
  const l3 = await ins(lara, { clock_in: z("2026-12-18T06:00:00+01:00"), clock_out: z("2026-12-18T22:00:00+01:00") });
  ok(!l3.error, `genau 16 h ohne Begründung erlaubt (Grenze: über 16 h) ${l3.error?.message ?? ""}`);

  // -------------------------------------------------------------------------
  titel("A3 «geprüft» und «Altfall» setzt nur die Lohnverwaltung");
  const f1 = await ins(lara, { clock_in: z("2026-12-19T08:00:00+01:00"), clock_out: z("2026-12-19T09:00:00+01:00"), geprueft_at: new Date().toISOString() });
  ok(/setzt nur die Lohnverwaltung/.test(f1.error?.message ?? ""), `Techniker legt «geprüft» an → ${f1.error?.message ?? "gespeichert!"}`);
  const f2 = await lara.supa.from("time_entries").update({ ueberlappung_altfall: true }).eq("id", c.data?.id);
  ok(/setzt nur die Lohnverwaltung/.test(f2.error?.message ?? ""), `Techniker setzt «Altfall» → ${f2.error?.message ?? "gespeichert!"}`);
  const f3 = await lara.supa.from("time_entries").update({ geprueft_at: new Date().toISOString() }).eq("id", l2.data?.id);
  ok(/setzt nur die Lohnverwaltung/.test(f3.error?.message ?? ""), `Techniker setzt «geprüft» → ${f3.error?.message ?? "gespeichert!"}`);

  // -------------------------------------------------------------------------
  titel("A4 Sperre auch für den Server");
  const [septId, septEnde] = sql(`select id || '|' || extract(epoch from clock_out)::bigint from time_entries
    where user_id = '${ID.lara}' and clock_in >= '2026-09-17' and clock_in < '2026-09-18' and description not like '${TEST}%' order by clock_in limit 1`).split("|");
  const ende = () => sql(`select extract(epoch from clock_out)::bigint from time_entries where id = '${septId}'`);
  const plus30 = new Date((Number(septEnde) + 1800) * 1000).toISOString();
  const s1 = await service.from("time_entries").update({ clock_out: plus30 }).eq("id", septId);
  ok(/nur per Antrag/.test(s1.error?.message ?? ""), `service_role ändert Lara 17.09. → ${s1.error?.message ?? "geändert!"}`);
  const s2 = await service.from("time_entries").delete().eq("id", septId);
  ok(/nicht löschbar|nur per Antrag/.test(s2.error?.message ?? ""), `service_role löscht Lara 17.09. → ${s2.error?.message ?? "gelöscht!"}`);
  const s3 = await lara.supa.from("time_entries").update({ clock_out: plus30 }, { count: "exact" }).eq("id", septId);
  ok(!s3.error && s3.count === 0 && ende() === septEnde, `Techniker im Browser: RLS filtert den gesperrten Stempel (0 Zeilen)`);

  // -------------------------------------------------------------------------
  titel("A5 Nach der Sperre nur per Antrag (Vier Augen)");
  const r0 = await post(lara, "/api/hr/stempel-antrag", { op: "update", id: septId, clock_out: plus30, begruendung: `${TEST}: kein Recht` });
  ok(r0.status === 403, `Techniker → ${r0.status}`);
  const r1 = await post(admin, "/api/hr/stempel-antrag", { op: "update", id: septId, clock_out: plus30 });
  ok(r1.status === 409 && r1.json?.mode === "begruendung_noetig" && /abgerechnet/.test(r1.json?.meldung ?? ""),
    `ohne Begründung → ${r1.status} ${r1.json?.mode}: ${r1.json?.meldung}`);
  const r2 = await post(admin, "/api/hr/stempel-antrag", { op: "update", id: septId, clock_out: plus30, begruendung: `${TEST}: Ende laut Rapport 30 min später` });
  if (r2.json?.antrag_id) eigeneAntraege.push(r2.json.antrag_id);
  ok(r2.status === 200 && r2.json?.mode === "antrag" && ende() === septEnde, `mit Begründung → ${r2.json?.mode}, Stempel noch unverändert`);
  const offen = (await admin2.api("/api/hr/lohn-antraege")).json?.offen ?? [];
  const antrag = offen.find((x) => x.id === r2.json?.antrag_id);
  ok(antrag?.bereich === "stempel" && antrag?.darf_bestaetigen === true, `Antrag «stempel» für Admin Zwei bestätigbar: ${antrag?.beschreibung}`);
  const selbst = await post(admin, "/api/hr/lohn-antraege", { id: r2.json?.antrag_id, aktion: "bestaetigen" });
  ok(selbst.status === 400, `eigener Antrag bestätigen → ${selbst.status}`);
  const best = await post(admin2, "/api/hr/lohn-antraege", { id: r2.json?.antrag_id, aktion: "bestaetigen" });
  ok(best.status === 200 && ende() === String(Number(septEnde) + 1800), `Admin Zwei bestätigt → Stempel geändert (${best.status} ${best.json?.error ?? ""})`);
  const prot = sql(`select quelle || '|' || coalesce(akteur_name, '') from lohn_aenderungen where datensatz_id = '${septId}' and antrag_id = '${r2.json?.antrag_id}' order by occurred_at desc limit 1`);
  ok(prot.startsWith("antrag|"), `lohn_aenderungen: Quelle antrag (${prot})`);

  const ueb = await post(admin, "/api/hr/stempel-antrag", {
    op: "insert", user_id: ID.lara, clock_in: "2026-09-17T11:00:00+02:00", clock_out: "2026-09-17T12:00:00+02:00", description: `${TEST} überlappt`, begruendung: `${TEST}: überlappt`,
  });
  ok(ueb.status === 409 && /überschneidet sich mit dem Stempel von Lara Steiner vom 17\.09\. 10:00–16:30/.test(ueb.json?.error ?? ""), `Nachtrag überlappend → ${ueb.status}: ${ueb.json?.error}`);
  const lang = await post(admin, "/api/hr/stempel-antrag", {
    op: "insert", user_id: ID.lara, clock_in: "2026-09-20T05:00:00+02:00", clock_out: "2026-09-20T23:00:00+02:00", description: `${TEST} lang`, begruendung: `${TEST}: lang`,
  });
  ok(lang.status === 400 && lang.json?.code === "lang_begruendung_noetig", `Nachtrag 18 h ohne Begründung zum langen Stempel → ${lang.status} ${lang.json?.code}`);

  const n1 = await post(admin, "/api/hr/stempel-antrag", {
    op: "insert", user_id: ID.lara, clock_in: "2026-09-20T08:00:00+02:00", clock_out: "2026-09-20T10:00:00+02:00", description: `${TEST} Nachtrag`, begruendung: `${TEST}: Nachtrag im abgerechneten Monat`,
  });
  if (n1.json?.antrag_id) eigeneAntraege.push(n1.json.antrag_id);
  const n1b = await post(admin2, "/api/hr/lohn-antraege", { id: n1.json?.antrag_id, aktion: "bestaetigen" });
  const neuId = sql(`select id from time_entries where user_id = '${ID.lara}' and description = '${TEST} Nachtrag'`);
  ok(n1.json?.mode === "antrag" && n1b.status === 200 && !!neuId, `Nachtrag 20.09. per Antrag → bestätigt, Stempel da`);
  const d1 = await post(admin, "/api/hr/stempel-antrag", { op: "delete", id: neuId });
  ok(d1.status === 409 && d1.json?.mode === "begruendung_noetig", `Löschen im abgerechneten Monat ohne Begründung → ${d1.status} ${d1.json?.mode}`);
  const d2 = await post(admin, "/api/hr/stempel-antrag", { op: "delete", id: neuId, begruendung: `${TEST}: Nachtrag wieder weg` });
  if (d2.json?.antrag_id) eigeneAntraege.push(d2.json.antrag_id);
  const d2b = await post(admin2, "/api/hr/lohn-antraege", { id: d2.json?.antrag_id, aktion: "bestaetigen" });
  ok(d2.json?.mode === "antrag" && d2b.status === 200 && sql(`select count(*) from time_entries where id = '${neuId}'`) === "0",
    `Löschen per Antrag → bestätigt, Stempel weg (${d2b.json?.error ?? "ok"})`);

  // -------------------------------------------------------------------------
  titel("A6 «Geprüft» (/api/hr/stempel-pruefen)");
  const p0 = await post(lara, "/api/hr/stempel-pruefen", { id: l2.data?.id });
  ok(p0.status === 403, `Techniker → ${p0.status}`);
  const p1 = await post(admin, "/api/hr/stempel-pruefen", { id: l2.data?.id });
  const geprueft = sql(`select coalesce(geprueft_von_name, '') || '|' || (geprueft_at is not null) from time_entries where id = '${l2.data?.id}'`);
  ok(p1.status === 200 && geprueft.endsWith("|true") && geprueft.startsWith("Test"), `Admin prüft 17-h-Stempel → ${p1.status} (${geprueft})`);
  const p2 = await post(admin, "/api/hr/stempel-pruefen", { id: a.data?.id });
  ok(p2.status === 400, `kurzer Stempel → ${p2.status}: ${p2.json?.error}`);
  await lara.supa.from("time_entries").update({ clock_out: z("2026-12-17T23:30:00+01:00") }).eq("id", l2.data?.id);
  ok(sql(`select geprueft_at is null from time_entries where id = '${l2.data?.id}'`) === "t", "Ende geändert → «geprüft» fällt weg");

  // -------------------------------------------------------------------------
  titel("A7 Ticket «Stempel-Änderung»");
  const ticket = async (titelText, data) => {
    const r = await lara.supa.from("tickets")
      .insert({ type: "stempel_aenderung", title: `${TEST} ${titelText}`, created_by: lara.userId, priority: "normal", data })
      .select("id").single();
    if (r.error) throw new Error(`Ticket anlegen: ${r.error.message}`);
    return r.data.id;
  };
  const status = (id) => sql(`select status from tickets where id = '${id}'`);

  const t1 = await ticket("Überlappung", { context: "andere_arbeit", beschreibung: TEST, neu_start: z("2026-12-14T09:00:00+01:00"), neu_end: z("2026-12-14T10:00:00+01:00"), grund: "Test Überlappung" });
  const ap1 = await post(admin, `/api/tickets/${t1}/approve`, {});
  ok(ap1.status === 409 && /überschneidet sich mit dem Stempel von Lara Steiner vom 14\.12\. 08:00–12:00/.test(ap1.json?.error ?? "") && status(t1) === "offen",
    `Genehmigen mit Überlappung → ${ap1.status}: ${ap1.json?.error}`);

  const t2 = await ticket("Normal", { context: "andere_arbeit", beschreibung: TEST, neu_start: z("2026-12-21T08:00:00+01:00"), neu_end: z("2026-12-21T10:00:00+01:00"), grund: "Vergessen einzustempeln" });
  const ap2 = await post(admin, `/api/tickets/${t2}/approve`, {});
  ok(ap2.status === 200 && status(t2) === "erledigt" && sql(`select count(*) from time_entries where user_id = '${ID.lara}' and description = '${TEST}' and clock_in = '${z("2026-12-21T08:00:00+01:00")}'`) === "1",
    `normales Ticket (apply_ticket) → ${ap2.status}, Stempel angelegt`);

  const t3 = await ticket("Lang", { context: "andere_arbeit", beschreibung: TEST, neu_start: z("2026-12-22T05:00:00+01:00"), neu_end: z("2026-12-22T23:00:00+01:00"), grund: "Aufbau, Anlass und Abbau am Stück" });
  const ap3 = await post(admin, `/api/tickets/${t3}/approve`, {});
  const langB = sql(`select coalesce(lang_begruendung, '') from time_entries where user_id = '${ID.lara}' and description = '${TEST}' and clock_in = '${z("2026-12-22T05:00:00+01:00")}'`);
  ok(ap3.status === 200 && status(t3) === "erledigt" && /Aufbau, Anlass und Abbau/.test(langB), `Ticket über 16 h → ${ap3.status}, Begründung «${langB}»`);

  const [sept10, sept10Ende] = sql(`select id || '|' || clock_out from time_entries where user_id = '${ID.lara}' and clock_in >= '2026-09-10' and clock_in < '2026-09-11' and description not like '${TEST}%' limit 1`).split("|");
  const t4 = await ticket("Gesperrt", { context: "andere_arbeit", time_entry_id: sept10, neu_end: new Date(Date.parse(sept10Ende.replace(" ", "T").replace(/\+00$/, "Z")) + 900_000).toISOString(), grund: "Ende war 15 Minuten später" });
  const ap4 = await post(admin, `/api/tickets/${t4}/approve`, {});
  ok(ap4.status === 423 && ap4.json?.code === "antrag_noetig" && ap4.json?.antrag_moeglich === true, `gesperrter Monat → ${ap4.status} ${ap4.json?.code}`);
  const ap5 = await post(admin, `/api/tickets/${t4}/approve`, { als_antrag: true, begruendung: "Ende war 15 Minuten später (laut Rapport)" });
  const t4Daten = sql(`select coalesce(data->>'lohn_antrag_id', '') from tickets where id = '${t4}'`);
  if (t4Daten) eigeneAntraege.push(t4Daten);
  ok(ap5.status === 200 && ap5.json?.mode === "antrag" && status(t4) === "erledigt" && !!t4Daten && sql(`select clock_out from time_entries where id = '${sept10}'`) === sept10Ende,
    `als Antrag → ${ap5.json?.mode}, Ticket erledigt, Stempel noch unverändert`);
  const abl = await post(admin2, "/api/hr/lohn-antraege", { id: t4Daten, aktion: "ablehnen", grund: `${TEST}: aufräumen` });
  ok(abl.status === 200, `Antrag aus dem Ticket abgelehnt (aufräumen) → ${abl.status}`);

  // Doppelklick / zwei Admins gleichzeitig: das Ticket wird zuerst beansprucht.
  const anzahlAm = (iso) => sql(`select count(*) from time_entries where user_id = '${ID.lara}' and description = '${TEST}' and clock_in = '${iso}'`);
  const t5 = await ticket("Doppelt normal", { context: "andere_arbeit", beschreibung: TEST, neu_start: z("2026-12-23T08:00:00+01:00"), neu_end: z("2026-12-23T10:00:00+01:00"), grund: "Doppelklick-Test" });
  const [d5a, d5b] = await Promise.all([post(admin, `/api/tickets/${t5}/approve`, {}), post(admin2, `/api/tickets/${t5}/approve`, {})]);
  ok(anzahlAm(z("2026-12-23T08:00:00+01:00")) === "1" && d5a.status === 200 && d5b.status === 200 && status(t5) === "erledigt",
    `zwei Genehmigungen gleichzeitig (apply_ticket) → ${d5a.status}/${d5b.status}, genau 1 Stempel`);
  const t6 = await ticket("Doppelt lang", { context: "andere_arbeit", beschreibung: TEST, neu_start: z("2026-12-24T05:00:00+01:00"), neu_end: z("2026-12-24T23:00:00+01:00"), grund: "Doppelklick-Test lang" });
  const [d6a, d6b] = await Promise.all([post(admin, `/api/tickets/${t6}/approve`, {}), post(admin2, `/api/tickets/${t6}/approve`, {})]);
  ok(anzahlAm(z("2026-12-24T05:00:00+01:00")) === "1" && d6a.status === 200 && d6b.status === 200,
    `zwei Genehmigungen gleichzeitig (über 16 h) → ${d6a.status}/${d6b.status}, genau 1 Stempel`);
  const t7 = await ticket("Doppelt Antrag", { context: "andere_arbeit", time_entry_id: sept10, neu_end: new Date(Date.parse(sept10Ende.replace(" ", "T").replace(/\+00$/, "Z")) + 600_000).toISOString(), grund: "Doppelklick-Test Antrag" });
  const antraegeVorher = Number(sql("select count(*) from lohn_aenderungs_antraege"));
  const [d7a, d7b] = await Promise.all([
    post(admin, `/api/tickets/${t7}/approve`, { als_antrag: true, begruendung: "Doppelklick-Test: Ende 10 min später" }),
    post(admin2, `/api/tickets/${t7}/approve`, { als_antrag: true, begruendung: "Doppelklick-Test: Ende 10 min später" }),
  ]);
  const t7Antrag = sql(`select coalesce(data->>'lohn_antrag_id', '') from tickets where id = '${t7}'`);
  if (t7Antrag) eigeneAntraege.push(t7Antrag);
  ok(Number(sql("select count(*) from lohn_aenderungs_antraege")) - antraegeVorher === 1 && !!t7Antrag && status(t7) === "erledigt",
    `zwei Genehmigungen als Antrag gleichzeitig → ${d7a.status}/${d7b.status}, genau 1 Antrag`);
  const t8 = await ticket("Kurz", { context: "andere_arbeit", time_entry_id: sept10, neu_end: new Date(Date.parse(sept10Ende.replace(" ", "T").replace(/\+00$/, "Z")) + 300_000).toISOString(), grund: "kurz" });
  const d8 = await post(admin, `/api/tickets/${t8}/approve`, { als_antrag: true, begruendung: "kurz" });
  ok(d8.status === 409 && d8.json?.code === "begruendung_noetig" && status(t8) === "offen", `Antrag ohne genügende Begründung → ${d8.status}, Ticket wieder offen`);

  // -------------------------------------------------------------------------
  titel("A Aufräumen");
  sql(`select set_config('lohn.notweg','an',true); update time_entries set clock_out = to_timestamp(${septEnde}) where id = '${septId}';`);
  if (eigeneAntraege.length > 0) {
    const liste = eigeneAntraege.map((x) => `'${x}'`).join(",");
    sql(`update lohn_aenderungs_antraege set status = 'abgelehnt', ablehnung_grund = '${TEST}: aufräumen' where id in (${liste}) and status = 'offen'`);
    sql(`update lohn_korrektur_vorschlaege set status = 'verworfen' where antrag_id in (${liste}) and status = 'offen'`);
  }
  aufraeumen();
  ok(ende() === septEnde && sql(`select count(*) from time_entries where description like '${TEST}%'`) === "0", "Testdaten entfernt, Lara 17.09. wiederhergestellt");
}
