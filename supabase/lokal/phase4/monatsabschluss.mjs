// Prüfmodul C «Monatsabschluss» (Lohn-Umbau Phase 4) — geladen von
// supabase/lokal/pruefen-phase4.mjs (ctx siehe dort). NUR LOKAL.
//
// Eigene Fälle (andere Prüfmodule nutzen dieselbe DB):
//   - Lauf nur für die eigenen Personen: «automatisch abrechnen» der übrigen
//     Lohnzeilen für die Dauer der Läufe aus, «Lauf ab» = geprüfter Monat
//     (beides am Ende exakt zurückgesetzt). Je Durchgang wird der JÜNGSTE
//     freie gesperrte Monat je Person verbraucht → mehrfach lauffähig.
//   - Jonas: offener Stempel (blockiert → Ende per Antrag, Vier Augen → erstellt),
//     Zustellung, ausbezahlt/Storno, Korrekturfassung
//   - Sara: langer Stempel (blockiert → «geprüft» → erstellt), Korrektur-Vorschlag
//   - Mia: Fehler-Status (Geburtsdatum kurz entfernt)
//   - Erinnerungs-Cron: offener Oktober-Stempel von Jonas, simuliert am 3.11.
//
// Testgriffe an der DB: offene Test-Stempel als «Altfall» markiert (sonst
// überlappt ein offener Stempel jeden späteren); das Setzen des Endes hebt die
// Markierung wieder auf (Trigger). Was offen bleibt, wird am Ende gelöscht.

const NOTWEG = "select set_config('lohn.notweg','an',true); select set_config('lohn.grund','Prüfung Phase 4 Monatsabschluss',true);";

export async function pruefe(ctx) {
  const { ok, titel, sql, gleich, login, post, lauf, cron, ID } = ctx;
  const q = (s) => s.replace(/'/g, "''");
  // psql gibt bei mehreren Befehlen / RETURNING auch Zwischenergebnisse und «INSERT 0 1» aus.
  const uuids = (text) => text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  const sqlId = (befehl) => uuids(sql(befehl)).pop() ?? "";

  const freierMonat = (pid) => sql(`
    select to_char(m, 'YYYY-MM') from generate_series('2026-03-01'::date, '2026-09-01'::date, interval '1 month') m
     where not exists (select 1 from lohn_momentaufnahmen x where x.profile_id = '${pid}' and x.jahr = extract(year from m)::int and x.monat = extract(month from m)::int)
       and not exists (select 1 from wage_documents w where w.profile_id = '${pid}' and w.doc_type = 'lohnabrechnung' and w.year = extract(year from m)::int and w.period_month = extract(month from m)::int)
       and exists (select 1 from employee_compensation c where c.profile_id = '${pid}' and c.effective_from <= (m + interval '1 month - 1 day')::date
                     and (c.effective_to is null or c.effective_to >= m::date) and not coalesce(c.wage_exempt, false))
     order by m desc limit 1`);
  /** Tag im Monat, an dem die Person von Vortag bis Folgetag keinen Stempel hat. */
  const freierTag = (pid, monat) => sql(`
    select to_char(d, 'YYYY-MM-DD') from generate_series('${monat}-02'::date, ('${monat}-01'::date + interval '1 month - 2 day')::date, interval '1 day') d
     where not exists (select 1 from time_entries t where t.user_id = '${pid}'
             and tstzrange(t.clock_in, coalesce(t.clock_out, 'infinity'::timestamptz), '[)')
              && tstzrange(((d::date - 1)::timestamp at time zone 'Europe/Zurich'), ((d::date + 2)::timestamp at time zone 'Europe/Zurich'), '[)'))
     order by d limit 1`);
  const zeit = (tag, hhmm) => `('${tag} ${hhmm}'::timestamp at time zone 'Europe/Zurich')`;
  const status = async (s, monat, pid) => (await s.api(`/api/hr/monatsstatus?month=${monat}`)).json?.zeilen?.find((z) => z.profile_id === pid);
  const letzterLauf = () => sql(`select status || '|' || blockiert || '|' || fehler || '|' || coalesce(alarm_fehler,'') || '|' || coalesce(alarm_empfaenger::text,'') || '|' || (alarm_gesendet_at is null) from lohn_lauf order by gestartet_at desc limit 1`).split("|");
  const ergebnis = (r, pid, monat) => r.json?.ergebnisse?.find((e) => e.profile_id === pid && e.monat === monat);
  const zaehler = async (s) => (await s.api("/api/admin/rechte-antraege/zaehler")).json?.anzahl;
  const knoepfe = async (s) => {
    const [r, l] = await Promise.all([s.api("/api/admin/rechte-antraege"), s.api("/api/hr/lohn-antraege")]);
    return [...(r.json?.offen ?? []), ...(l.json?.offen ?? [])].filter((a) => a.darf_bestaetigen).length;
  };

  const admin = await login("admin");
  const admin2 = await login("admin2");
  const jonas = await login("jonas", null);
  const lara = await login("lara", null);

  const laufAbVorher = sql(`select lauf_ab from lohn_einstellungen where id = 'default'`);
  const geburtMia = sql(`select birthdate from profiles where id = '${ID.mia}'`);
  const offeneTestStempel = [];
  // «automatisch abrechnen» je Lohnzeile vor dem Test; zurückgesetzt wird nur, was dieses Modul änderte.
  const zeilen = () => sql(`select id || '|' || profile_id || '|' || coalesce(auto_lohnabrechnung::text, 'null') from employee_compensation`)
    .split("\n").map((z) => z.trim().split("|")).filter((z) => z.length === 3);
  const autoVorher = new Map(zeilen().map(([id, , wert]) => [id, wert]));
  const geaendert = new Set();
  const liste = (ids) => ids.map((i) => `'${i}'`).join(",");
  const setze = (ids, wert) => {
    if (ids.length === 0) return;
    sql(`update employee_compensation set auto_lohnabrechnung = ${wert} where id in (${liste(ids)})`);
    for (const id of ids) geaendert.add(id);
  };
  /** Lauf nur für diese Personen: ihre Lohnzeilen «automatisch» an, alle anderen aus (am Ende exakt zurück). */
  const nurFuer = (personen) => {
    const z = zeilen();
    setze(z.filter(([, p, w]) => !personen.includes(p) && w !== "false").map(([id]) => id), "false");
    setze(z.filter(([, p, w]) => personen.includes(p) && w !== "true").map(([id]) => id), "true");
  };

  try {
    const mA = freierMonat(ID.jonas);
    const mB = freierMonat(ID.sara);
    if (!ok(!!mA && !!mB, `freie gesperrte Monate: Jonas ${mA || "—"}, Sara ${mB || "—"} (sonst: aufbauen.sh --nur-seed)`)) return;
    const tagA = freierTag(ID.jonas, mA);
    const tagB = freierTag(ID.sara, mB);
    const [jA, moA] = mA.split("-").map(Number);

    // -----------------------------------------------------------------------
    titel("C1  Offener / langer Stempel blockiert den Monat im Lauf");
    const sA = sqlId(`${NOTWEG} insert into time_entries (user_id, clock_in, ueberlappung_altfall, description) values ('${ID.jonas}', ${zeit(tagA, "08:00")}, true, 'Prüfung Phase 4: offener Stempel') returning id`);
    offeneTestStempel.push(sA);
    const sB = sqlId(`${NOTWEG} insert into time_entries (user_id, clock_in, clock_out, lang_begruendung, description) values ('${ID.sara}', ${zeit(tagB, "06:00")}, (${zeit(tagB, "06:00")} + interval '18 hours 30 minutes'), 'Aufbau und Anlass bis spät (Prüfung)', 'Prüfung Phase 4: langer Stempel') returning id`);
    ok(/^[0-9a-f-]{36}$/.test(sA) && /^[0-9a-f-]{36}$/.test(sB), `Test-Stempel angelegt: Jonas ${tagA} offen, Sara ${tagB} 18:30 h`);

    nurFuer([ID.jonas, ID.sara]);
    sql(`update lohn_einstellungen set lauf_ab = '${[mA, mB].sort()[0]}-01' where id = 'default'`);
    const l1 = await lauf();
    const eA = ergebnis(l1, ID.jonas, mA);
    const eB = ergebnis(l1, ID.sara, mB);
    ok(l1.status === 200 && l1.json?.status === "blockiert" && l1.json?.blockiert >= 2 && l1.json?.fehler === 0,
      `Lauf: Status ${l1.json?.status}, ${l1.json?.blockiert} blockiert, ${l1.json?.fehler} Fehler, ${l1.json?.erstellt} erstellt (HTTP ${l1.status})`);
    ok(eA && !eA.ok && /offener Stempel/.test(eA.blockiert ?? "") && !eA.fehler, `Jonas ${mA}: blockiert — ${eA?.blockiert}`);
    ok(eB && !eB.ok && /über 16 h ungeprüft/.test(eB.blockiert ?? "") && !eB.fehler, `Sara ${mB}: blockiert — ${eB?.blockiert}`);
    ok(sql(`select count(*) from lohn_momentaufnahmen where profile_id = '${ID.jonas}' and jahr = ${jA} and monat = ${moA}`) === "0", "blockiert = keine (zu tiefe) Abrechnung erstellt");
    const [st1, blk1, , alarmFehler1, alarmEmpf1, alarmNichtGesendet1] = letzterLauf();
    ok(st1 === "blockiert" && Number(blk1) >= 2, `lohn_lauf: Status ${st1}, blockiert ${blk1}`);
    const mailEingerichtet = !!ctx.env.RESEND_API_KEY;
    if (mailEingerichtet) {
      ok(alarmNichtGesendet1 === "false" && Number(alarmEmpf1) >= 2, `Alarm-Mail versendet an ${alarmEmpf1}`);
    } else {
      ok(/Mailversand nicht eingerichtet/.test(alarmFehler1) && alarmNichtGesendet1 === "true" && Number(alarmEmpf1) >= 2,
        `Alarm-Mail: lokal kein Mailversand (RESEND_API_KEY leer) → nicht beansprucht, festgehalten: «${alarmFehler1}», ${alarmEmpf1} Empfänger`);
    }
    const glocke = sql(`select title || '|' || coalesce(link,'') from notifications where user_id = '${ID.admin}' and title like 'Lohnlauf:%blockiert%' order by created_at desc limit 1`);
    ok(glocke.includes("tab=monatsstunden&monat=") && !/CHF/.test(glocke), `Glocke an die Lohnverwaltung: ${glocke.split("|")[0]}`);
    const prot = (await admin.api("/api/hr/lohn-lauf")).json?.laeufe ?? [];
    ok(prot.length >= 1 && prot[0].blockiert >= 2 && prot[0].ergebnisse.some((e) => e.blockiert) && "alarm_fehler" in prot[0],
      `Lauf-Protokoll (/api/hr/lohn-lauf): ${prot.length} Läufe, Ergebnis je Person/Monat mit Grund`);

    const zA = await status(admin, mA, ID.jonas);
    const zB = await status(admin, mB, ID.sara);
    ok(zA?.status === "blockiert" && zA.stempel?.[0]?.art === "offen" && zA.stempel[0].id === sA, `Statusspalte Jonas ${mA}: ${zA?.status} (${zA?.stempel?.length} Stempel, offen)`);
    ok(zB?.status === "blockiert" && zB.stempel?.[0]?.art === "lang" && zB.stempel[0].langBegruendung, `Statusspalte Sara ${mB}: ${zB?.status} (lang, mit Begründung)`);
    ok((await lara.api(`/api/hr/monatsstatus?month=${mA}`)).status >= 401, "Statusspalte: Techniker ohne Lohnrecht → verweigert");

    // -----------------------------------------------------------------------
    titel("C2  Langer Stempel → «geprüft» → Lauf erstellt");
    const gp = await post(admin, "/api/hr/stempel-pruefen", { id: sB });
    ok(gp.status === 200 && gp.json?.success && sql(`select geprueft_at is not null from time_entries where id = '${sB}'`) === "t", `«Stempel ist korrekt» → geprüft (${gp.status})`);
    ok((await status(admin, mB, ID.sara))?.status === "fehlt", "Statusspalte Sara: blockiert → fehlt");
    const l2 = await lauf();
    const e2 = ergebnis(l2, ID.sara, mB);
    ok(e2?.ok === true && !e2.uebersprungen, `Lauf erstellt Sara ${mB} (Lauf-Status ${l2.json?.status} — Jonas noch blockiert)`);
    const zB2 = await status(admin, mB, ID.sara);
    ok(zB2?.status === "erstellt" && zB2.fassung?.fassung === 1, `Statusspalte Sara: ${zB2?.status} (${zB2?.text})`);

    // -----------------------------------------------------------------------
    titel("C3  Offener Stempel → Ende per Antrag (Vier Augen) → Zähler «Anträge» → erstellt");
    const ende = await post(admin, "/api/hr/stempel-antrag", { op: "update", id: sA, clock_out: new Date(sql(`select to_char(${zeit(tagA, "16:00")} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)).toISOString(), lang_begruendung: null, begruendung: "Prüfung Phase 4: laut Einsatzplan bis 16:00" });
    ok(ende.status === 200 && ende.json?.mode === "antrag" && ende.json?.antrag_id, `«Ende per Antrag setzen» im gesperrten Monat → ${ende.json?.mode} (${ende.status})`);
    const [z1, z2] = [await zaehler(admin), await zaehler(admin2)];
    const [k1, k2] = [await knoepfe(admin), await knoepfe(admin2)];
    ok(z2 >= 1 && z2 === k2 && z1 === k1, `Zähler «Anträge» (Rechte & Lohndaten): zweite Person ${z2} = ${k2} Bestätigen-Knöpfe, Antragsteller ${z1} = ${k1}`);
    const best = await post(admin2, "/api/hr/lohn-antraege", { id: ende.json?.antrag_id, aktion: "bestaetigen" });
    ok(best.status === 200 && sql(`select (clock_out is not null) || '|' || ueberlappung_altfall from time_entries where id = '${sA}'`) === "true|false", `zweite Person bestätigt → Ende gesetzt, Altfall-Markierung weg (${best.status})`);
    offeneTestStempel.splice(offeneTestStempel.indexOf(sA), 1);
    const offenNach = (await admin2.api("/api/hr/lohn-antraege")).json?.offen ?? [];
    ok(!offenNach.some((a) => a.id === ende.json?.antrag_id) && (await zaehler(admin2)) === (await knoepfe(admin2)), "nach dem Entscheid: Antrag nicht mehr offen, Zähler = Bestätigen-Knöpfe");
    ok((await status(admin, mA, ID.jonas))?.status === "fehlt", "Statusspalte Jonas: blockiert → fehlt");
    const l3 = await lauf();
    ok(l3.json?.status === "ok" && ergebnis(l3, ID.jonas, mA)?.ok === true, `Lauf: Status ${l3.json?.status}, Jonas ${mA} erstellt`);
    const zA3 = await status(admin, mA, ID.jonas);
    ok(zA3?.status === "erstellt" && gleich(zA3.fassung?.betrag, sql(`select auszahlung from lohn_momentaufnahmen where id = '${zA3.fassung?.momentaufnahme_id}'`)),
      `Statusspalte Jonas ${mA}: ${zA3?.status}, Betrag aus der Fassung CHF ${zA3?.fassung?.betrag}`);

    // -----------------------------------------------------------------------
    titel("C4  Zustellung: Meldung ohne Beträge, Wahl digital/Papier, Öffnen");
    const docA = zA3?.fassung?.wage_document_id;
    const zu = sql(`select (bereitgestellt_at is not null) || '|' || coalesce(wahl,'-') || '|' || (benachrichtigt_at is not null) || '|' || coalesce(array_to_string(benachrichtigt_kanaele, ','),'') || '|' || anzahl_geoeffnet from lohn_dokument_zustellung where wage_document_id = '${docA}'`);
    // Wahl beim Bereitstellen = aktuelle Wahl der Person (erster Durchgang: noch keine).
    const w0 = (await jonas.api("/api/hr/lohn-zustellung")).json;
    const wahlVorher = w0?.wahl?.wahl ?? "-";
    ok(w0?.success && zu.startsWith(`true|${wahlVorher}|true|`) && zu.split("|")[3].includes("app") && zu.endsWith("|0"),
      `Nachweis: bereitgestellt (Wahl ${wahlVorher === "-" ? "noch keine" : wahlVorher}), benachrichtigt (${zu.split("|")[3]}), 0× geöffnet; «Meine» liefert die Wahl`);
    // (gebündelt «n× …», wenn kurz davor schon eine Meldung kam)
    const meld = sql(`select title || '|' || coalesce(message,'') || '|' || coalesce(link,'') from notifications where user_id = '${ID.jonas}' and type = 'lohn_dokument' and created_at > now() - interval '3 minutes' order by created_at desc limit 1`);
    ok(/^(\d+× )?Deine Lohnabrechnung \S+ \d{4} liegt bereit\|/.test(meld) && !/CHF|\d+[.,]\d{2}\b/.test(meld) && meld.endsWith("/lohn?ansicht=meine"),
      `Meldung: «${meld.split("|")[0]}» — ohne Beträge, Link auf Lohn › Meine`);
    ok(!mailEingerichtet ? !zu.includes("mail") : true, mailEingerichtet ? "Mail eingerichtet" : "Mail-Kanal: lokal kein Versand (RESEND_API_KEY leer) → nicht als «mail» vermerkt");

    const wp = await post(jonas, "/api/hr/lohn-zustellung", { wahl: "papier" });
    const w1 = (await jonas.api("/api/hr/lohn-zustellung")).json?.wahl;
    ok(wp.status === 200 && w1?.wahl === "papier" && w1.quelle === "selbst" && sql(`select lohndokumente_digital_accepted_at is null from profiles where id = '${ID.jonas}'`) === "t", "Person wählt «auf Papier» (selbst, Einwilligung leer)");
    const ohneNotiz = await post(admin, "/api/hr/lohn-zustellung", { profile_id: ID.jonas, wahl: "digital", notiz: "" });
    const mitNotiz = await post(admin, "/api/hr/lohn-zustellung", { profile_id: ID.jonas, wahl: "digital", notiz: "per Mail gewünscht (Prüfung)" });
    ok(ohneNotiz.status === 400 && mitNotiz.status === 200, `Lohnverwaltung trägt ein: ohne Notiz ${ohneNotiz.status}, mit Notiz ${mitNotiz.status}`);
    ok((await post(lara, "/api/hr/lohn-zustellung", { profile_id: ID.jonas, wahl: "papier", notiz: "fremd eingetragen" })).status >= 401, "Techniker kann die Wahl anderer nicht eintragen");
    const acc = await post(jonas, "/api/hr/wage-documents/accept-digital", {});
    const hist = (await admin.api(`/api/hr/lohn-zustellung?profile_id=${ID.jonas}`)).json;
    ok(acc.status === 200 && hist?.wahl?.wahl === "digital" && hist.wahl.quelle === "selbst" && hist.historie?.length >= 3
      && hist.historie.some((h) => h.quelle === "lohnverwaltung" && h.notiz) && sql(`select lohndokumente_digital_accepted_version from profiles where id = '${ID.jonas}'`) === "1.0",
      `accept-digital schreibt die Historie mit (${hist?.historie?.length} Einträge, Lohnverwaltung sichtbar)`);
    ok(hist?.zustellung?.[docA]?.bereitgestellt_at, "Lohnverwaltung sieht den Nachweis je Dokument");

    await admin.api(`/api/hr/wage-documents/${docA}`);
    ok(sql(`select anzahl_geoeffnet from lohn_dokument_zustellung where wage_document_id = '${docA}'`) === "0", "Abruf durch die Lohnverwaltung zählt nicht als geöffnet");
    const o1 = await jonas.api(`/api/hr/wage-documents/${docA}`);
    await jonas.api(`/api/hr/wage-documents/${docA}`);
    ok(o1.status === 200 && sql(`select anzahl_geoeffnet || '|' || (erstmals_geoeffnet_at is not null) from lohn_dokument_zustellung where wage_document_id = '${docA}'`) === "2|true", "Person öffnet selbst → zählt (2×, erstmals festgehalten)");
    const dr1 = await post(admin, "/api/hr/lohn-zustellung", { wage_document_id: docA, ausgedruckt: true }, "PATCH");
    const dr2 = await post(admin, "/api/hr/lohn-zustellung", { wage_document_id: docA, ausgedruckt: true }, "PATCH");
    ok(dr1.status === 200 && dr2.status === 409 && sql(`select ausgedruckt_von_name from lohn_dokument_zustellung where wage_document_id = '${docA}'`) === "Test Admin", `«ausgedruckt» abhaken: ${dr1.status}, zweites Mal ${dr2.status}`);

    // -----------------------------------------------------------------------
    titel("C5  «Ausbezahlt» setzen / stornieren, Korrektur-Status");
    const fA = zA3.fassung.momentaufnahme_id;
    const morgen = sql(`select to_char(((now() at time zone 'Europe/Zurich')::date + 1), 'YYYY-MM-DD')`);
    const heute = sql(`select to_char((now() at time zone 'Europe/Zurich')::date, 'YYYY-MM-DD')`);
    ok((await post(admin, "/api/hr/auszahlungen", { momentaufnahme_id: fA, ausbezahlt_am: morgen })).status === 400, "ausbezahlt in der Zukunft → 400");
    ok((await post(lara, "/api/hr/auszahlungen", { momentaufnahme_id: fA, ausbezahlt_am: heute })).status >= 401, "Techniker → verweigert");
    const az = await post(admin, "/api/hr/auszahlungen", { momentaufnahme_id: fA, ausbezahlt_am: heute });
    ok(az.status === 200 && gleich(az.json?.auszahlung?.betrag, zA3.fassung.betrag), `als ausbezahlt markiert (Betrag aus der Fassung ${az.json?.auszahlung?.betrag})`);
    ok((await post(admin, "/api/hr/auszahlungen", { momentaufnahme_id: fA, ausbezahlt_am: heute })).status === 409, "zweites Mal → 409 (je Fassung eine)");
    const zA4 = await status(admin, mA, ID.jonas);
    ok(zA4?.status === "ausbezahlt" && zA4.auszahlung?.erfasst_von_name === "Test Admin", `Statusspalte: ${zA4?.status} (${zA4?.text})`);
    ok((await post(admin, "/api/hr/auszahlungen", { id: az.json?.auszahlung?.id, storno_grund: "x" }, "PATCH")).status === 400, "Storno ohne Grund → 400");
    const sto = await post(admin, "/api/hr/auszahlungen", { id: zA4.auszahlung.id, storno_grund: "Prüfung: falsches Datum erfasst" }, "PATCH");
    ok(sto.status === 200 && (await status(admin, mA, ID.jonas))?.status === "erstellt" && sql(`select count(*) from lohn_auszahlungen where momentaufnahme_id = '${fA}'`) === "1",
      "Storno → wieder «erstellt», die Zeile bleibt (Storno statt Löschen)");

    const korr = await post(admin, "/api/hr/wage-documents/generate", { profile_id: ID.jonas, year: jA, month: moA, neue_fassung: true, begruendung: "Prüfung Phase 4: Korrekturfassung" });
    const zA5 = await status(admin, mA, ID.jonas);
    ok(korr.status === 200 && zA5?.status === "korrektur" && zA5.fassung?.art === "korrektur", `Korrekturfassung → Statusspalte ${zA5?.status} (${zA5?.text})`);
    const meldK = sql(`select title from notifications where user_id = '${ID.jonas}' and type = 'lohn_dokument' order by created_at desc limit 1`);
    ok(/korrigierte Lohnabrechnung/.test(meldK) || /^\d+× .*korrigierte/.test(meldK), `Meldung zur Korrekturfassung: «${meldK}»`);
    ok((await post(admin, "/api/hr/auszahlungen", { momentaufnahme_id: fA, ausbezahlt_am: heute })).status === 409, "ersetzte Fassung kann nicht mehr «ausbezahlt» werden");
    const zuK = sql(`select anzahl_geoeffnet || '|' || (ausgedruckt_at is null) || '|' || coalesce(wahl,'-') || '|' || (benachrichtigt_at is not null) from lohn_dokument_zustellung where wage_document_id = '${docA}'`);
    ok(zuK === "0|true|digital|true", `Nachweis gilt für die neue Fassung: zurückgesetzt, Wahl digital, benachrichtigt (${zuK})`);
    const az2 = await post(admin, "/api/hr/auszahlungen", { momentaufnahme_id: zA5.fassung.momentaufnahme_id, ausbezahlt_am: heute });
    ok(az2.status === 200 && (await status(admin, mA, ID.jonas))?.status === "ausbezahlt", "Korrektur ausbezahlt → «ausbezahlt»");

    const fB = zB2.fassung.momentaufnahme_id;
    const vor = sqlId(`insert into lohn_korrektur_vorschlaege (profile_id, jahr, monat, vorfassung_id, brutto_alt, brutto_neu, netto_alt, netto_neu, differenz)
                     select profile_id, jahr, monat, id, brutto, brutto + 10, netto, netto + 9, 9 from lohn_momentaufnahmen where id = '${fB}' returning id`);
    const zB3 = await status(admin, mB, ID.sara);
    ok(zB3?.status === "korrektur" && zB3.korrektur_vorschlag === true, `offener Korrektur-Vorschlag → Statusspalte ${zB3?.status}`);
    sql(`update lohn_korrektur_vorschlaege set status = 'verworfen', erledigt_at = now(), erledigt_von_name = 'Prüfung Phase 4' where id = '${vor}'`);
    ok((await status(admin, mB, ID.sara))?.status === "erstellt", "Vorschlag verworfen → wieder «erstellt»");

    // -----------------------------------------------------------------------
    titel("C6  Fehler-Status (Lauf scheitert für Person/Monat)");
    const mC = freierMonat(ID.mia);
    if (ok(!!mC, `freier Monat für Mia: ${mC || "—"}`)) {
      nurFuer([ID.mia]);
      sql(`update lohn_einstellungen set lauf_ab = '${mC}-01' where id = 'default'`);
      sql(`update profiles set birthdate = null where id = '${ID.mia}'`);
      let l4;
      try {
        l4 = await lauf();
      } finally {
        sql(`update profiles set birthdate = ${geburtMia ? `'${geburtMia}'` : "null"} where id = '${ID.mia}'`);
      }
      const e4 = ergebnis(l4, ID.mia, mC);
      ok(l4.status === 500 && l4.json?.status === "fehler" && e4 && !e4.ok && /Geburtsdatum/.test(e4.fehler ?? ""), `Lauf: ${l4.json?.status} — Mia ${mC}: ${e4?.fehler}`);
      const [st4, , feh4, alarm4] = letzterLauf();
      ok(st4 === "fehler" && Number(feh4) >= 1 && (mailEingerichtet || /Mailversand nicht eingerichtet/.test(alarm4)), `lohn_lauf: ${st4}, ${feh4} Fehler, Alarm festgehalten`);
      const zC = await status(admin, mC, ID.mia);
      ok(zC?.status === "fehler" && /Geburtsdatum/.test(zC.fehler ?? ""), `Statusspalte Mia ${mC}: ${zC?.status} (${zC?.text})`);
    }

    // -----------------------------------------------------------------------
    titel("C7  Erinnerung vor der Monatssperre (Cron 1.–4.)");
    const okt = "2026-10";
    const tagO = freierTag(ID.jonas, okt);
    const sO = sqlId(`insert into time_entries (user_id, clock_in, ueberlappung_altfall, description) values ('${ID.jonas}', ${zeit(tagO, "07:30")}, true, 'Prüfung Phase 4: offen vor Monatsende') returning id`);
    offeneTestStempel.push(sO);
    const zO = await status(admin, okt, ID.jonas);
    ok(zO?.status === "offen" && zO.stempel?.some((p) => p.id === sO), `Oktober noch offen: Status «—» mit Hinweis (${zO?.stempel?.length} Stempel prüfen)`);
    ok((await cron("/api/cron/stempel-monatsende?heute=2026-11-05")).json?.status === "nicht_faellig", "am 5. nicht fällig");
    const vorP = Number(sql(`select count(*) from notifications where resource_type = 'stempel_monatsende' and user_id = '${ID.jonas}'`));
    const vorU = Number(sql(`select count(*) from notifications where resource_type = 'stempel_monatsende_uebersicht'`));
    const c1 = await cron("/api/cron/stempel-monatsende?heute=2026-11-03");
    const c2 = await cron("/api/cron/stempel-monatsende?heute=2026-11-03");
    const nachP = Number(sql(`select count(*) from notifications where resource_type = 'stempel_monatsende' and user_id = '${ID.jonas}'`));
    const nachU = Number(sql(`select count(*) from notifications where resource_type = 'stempel_monatsende_uebersicht'`));
    ok(c1.status === 200 && c1.json?.monat === okt && c1.json?.erinnert + c1.json?.schon_heute >= 1 && nachP >= 1 && nachP - vorP <= 1,
      `3.11.: Person erinnert (neu ${c1.json?.erinnert}, heute schon ${c1.json?.schon_heute}), Übersicht an ${c1.json?.uebersicht} Person(en) Lohnverwaltung`);
    ok(c2.json?.erinnert === 0 && c2.json?.uebersicht === 0 && c2.json?.schon_heute >= 1 && nachU - vorU === c1.json?.uebersicht,
      `Cron-Wiederholung am selben Tag: nichts doppelt (${c2.json?.schon_heute} schon erinnert, ${c2.json?.uebersicht_schon_heute} Übersichten schon da)`);
    const txt = sql(`select title || '|' || message from notifications where resource_type = 'stempel_monatsende' and user_id = '${ID.jonas}' order by created_at desc limit 1`);
    ok(/Stempel Oktober 2026 noch offen/.test(txt) && /bis am 4\. November ausstempeln/.test(txt) && /am 5\. November wird der Oktober abgeschlossen/.test(txt), `Klartext an die Person: «${txt.split("|")[1]?.slice(0, 120)}…»`);
    const ueb = sql(`select title || '|' || message || '|' || link from notifications where resource_type = 'stempel_monatsende_uebersicht' and user_id = '${ID.admin}' order by created_at desc limit 1`);
    ok(/Monatsabschluss Oktober 2026/.test(ueb) && /Jonas Frei/.test(ueb) && !/CHF/.test(ueb) && ueb.endsWith("monat=2026-10"), `Übersicht an die Lohnverwaltung: «${ueb.split("|")[0]}» (ohne Beträge)`);
    const c3 = await cron("/api/cron/stempel-monatsende?heute=2026-11-01");
    ok(c3.json?.uebersicht === 0 && c3.json?.uebersicht_schon_heute === 0, "am 1./2. keine Übersicht an die Lohnverwaltung");
  } finally {
    // Aufräumen: offene Test-Stempel löschen, Einstellungen exakt zurück.
    for (const id of offeneTestStempel) sql(`${NOTWEG} delete from time_entries where id = '${q(id)}' and clock_out is null`);
    const zurueck = [...geaendert];
    for (const wert of ["true", "false", "null"]) {
      const ids = zurueck.filter((id) => (autoVorher.get(id) ?? "true") === wert);
      if (ids.length) sql(`update employee_compensation set auto_lohnabrechnung = ${wert} where id in (${liste(ids)})`);
    }
    sql(`update lohn_einstellungen set lauf_ab = '${laufAbVorher}' where id = 'default'`);
    const jetzt = new Map(zeilen().map(([id, , wert]) => [id, wert]));
    ok(zurueck.every((id) => jetzt.get(id) === autoVorher.get(id)) && sql(`select lauf_ab from lohn_einstellungen where id = 'default'`) === laufAbVorher,
      `Aufgeräumt: «automatisch abrechnen» (${zurueck.length} Lohnzeilen) und «Lauf ab» wie vorher`);
  }
}
