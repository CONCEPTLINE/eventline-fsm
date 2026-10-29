// Prüfmodul Phase 4 «Abrechnung» (geladen von supabase/lokal/pruefen-phase4.mjs).
//
//   node supabase/lokal/pruefen-phase4.mjs abrechnung
//
// Prüft: Zusatzposten (Lohn, Rückerstattung, Spesen) in Brutto/Abzügen/
// Auszahlung über Lohn-Details, Monatstabelle und erzeugte Abrechnung gleich;
// Inhalt der Lohnabrechnung (Klartext, keine internen Angaben, Auszahlungsdatum,
// keine kaputten Zeichen); Korrekturfassung mit Vorfassung und Differenz;
// Stempel-Prüfung blockiert; Korrektur-Vorschlag erkennt Spesen-Abweichung;
// Zusatzposten-Route (direkt / Antrag nach der Sperre / Vier Augen);
// Jahresliste 2026, Lohnausweis (Formular 11) und AK 40 enthalten die Posten;
// Lohnausweis-Upload ohne zweite gültige Zeile.
//
// Testfälle (eigene, andere Agenten nutzen dieselbe DB): Sara Huber Juli 2026
// (Posten «P4-Test …», wird bei jedem Lauf neu aufgesetzt), Oktober 2026 (noch
// offen) für den direkten Weg, Jonas Frei für den Lohnausweis-Upload. Kein
// Lohnlauf. Aufräumen: offener Antrag abgelehnt, Vorschlag verworfen,
// Hilfs-Stempel und -Posten gelöscht; die drei Basis-Posten und die
// erzeugten Fassungen bleiben (Fassung = Rechnung).

import path from "node:path";
import { pathToFileURL } from "node:url";

const JAHR = 2026;
const MONAT = 7;
const TEST = "P4-Test";

export async function pruefe(ctx) {
  const { ok, titel, sql, sqlFehler, gleich, mm, login, post, ID, MAIL, service, root } = ctx;
  const { pdfZeilen } = await import(pathToFileURL(path.join(root, "scripts", "lohn-pdf-text.mjs")).href);
  const pdfText = async (buf) => (await pdfZeilen(buf)).map((z) => z.text).join("\n");
  const notweg = (q) => sql(`select set_config('lohn.notweg','an',true); select set_config('lohn.grund','Pruefung Phase 4 (lokal)',true); ${q}`);
  const P = ID.sara;
  const admin = await login("admin");
  const admin2 = await login("admin2");

  // ---------------------------------------------------------------------------
  titel("Abrechnung A  Zusatzposten im Rechenkern (Sara Huber, Juli 2026)");
  notweg(`delete from lohn_zusatzposten where profile_id = '${P}' and bezeichnung like '${TEST}%'`);
  const detail = async () => (await admin.api(`/api/hr/employee-detail?profile_id=${P}&year=${JAHR}&month=${MONAT}`)).json?.monat;
  const tabelle = async () => (await admin.api(`/api/hr/monthly-stats?month=${mm(JAHR, MONAT)}`)).json?.employees?.find((e) => e.profile_id === P);
  const ohne = await detail();
  ok(ohne && !ohne.fehler && ohne.spesen === 0 && gleich(ohne.auszahlungsbetrag, ohne.netto), `ohne Posten: Brutto ${ohne?.brutto}, Netto ${ohne?.netto}, Auszahlung = Netto`);
  notweg(`insert into lohn_zusatzposten (profile_id, jahr, monat, art, bezeichnung, betrag, ahv_pflichtig, steuerbar, abzug_art, begruendung, created_by_name) values
    ('${P}', ${JAHR}, ${MONAT}, 'lohn', '${TEST} Quellensteuer vom Arbeitgeber bezahlt', 120.00, true, true, null, 'Pruefung Phase 4: Lohnposten', 'Pruefung Phase 4'),
    ('${P}', ${JAHR}, ${MONAT}, 'rueckerstattung', '${TEST} AHV zurueck', 5.30, false, false, 'ahv_iv_eo', 'Pruefung Phase 4: Rueckerstattung', 'Pruefung Phase 4'),
    ('${P}', ${JAHR}, ${MONAT}, 'spesen', U&'${TEST} Verpflegung ausw\\00e4rts', 35.50, false, false, null, 'Pruefung Phase 4: Spesen', 'Pruefung Phase 4')`);
  const mit = await detail();
  const tab = await tabelle();
  const zp = (mit?.positionen ?? []).filter((p) => p.lohnart === "zusatz");
  ok(zp.length === 1 && gleich(zp[0].betrag, 120) && zp[0].bezeichnung.endsWith("vom Arbeitgeber bezahlt"), `Lohn-Details: eigene Position «${zp[0]?.bezeichnung}» CHF ${zp[0]?.betrag}`);
  ok(gleich(mit?.brutto, ohne.brutto + 120), `Brutto ${ohne.brutto} + 120.00 = ${mit?.brutto}`);
  ok(gleich(mit?.spesen, 35.5) && gleich(mit?.auszahlungsbetrag, mit.netto + 35.5), `Spesen nach dem Netto: Netto ${mit?.netto} + 35.50 = Auszahlung ${mit?.auszahlungsbetrag}`);
  ok(tab && gleich(tab.lohnkosten_chf, mit.brutto) && gleich(tab.nettolohn_chf, mit.netto), `Monatstabelle = Lohn-Details (Brutto ${tab?.lohnkosten_chf}, Netto ${tab?.nettolohn_chf})`);

  // ---------------------------------------------------------------------------
  titel("Abrechnung B  Stempel-Prüfung vor dem Rechnen");
  const frei = `${JAHR}-07-20`;
  const belegt = Number(sql(`select count(*) from time_entries where user_id = '${P}' and clock_in < '${frei} 23:59+02' and clock_out > '${frei} 00:00+02'`));
  if (belegt === 0) {
    const langId = notweg(`insert into time_entries (user_id, clock_in, clock_out, lang_begruendung, description) values ('${P}', '${frei} 06:00+02', '2026-07-21 00:30+02', 'Pruefung Phase 4: langer Stempel', 'Pruefung Phase 4') returning id`).match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0];
    const block = await post(admin, "/api/hr/wage-documents/generate", { profile_id: P, year: JAHR, month: MONAT, neue_fassung: true, begruendung: "Pruefung Phase 4: soll blockieren" });
    ok(block.status === 409 && block.json?.code === "stempel_pruefen" && /Stempel prüfen/.test(block.json?.error ?? ""), `langer ungeprüfter Stempel → ${block.status} ${block.json?.code}: ${block.json?.error}`);
    notweg(`delete from time_entries where id = '${langId}'`);
  } else {
    ok(false, `Stempel-Prüfung: Testtag ${frei} ist belegt — anderen Tag wählen`);
  }

  // ---------------------------------------------------------------------------
  titel("Abrechnung C  Lohnabrechnung aus der Momentaufnahme");
  const letzte = () => JSON.parse(sql(`select coalesce((select row_to_json(m) from (select id, fassung, art, brutto, total_abzuege, netto, auszahlungsbetrag, auszahlung,
      to_char(auszahlungsdatum, 'YYYY-MM-DD') auszahlungsdatum, storage_path, ergebnis->'zusatzposten' zp, ergebnis->'abzuege' abz
      from lohn_momentaufnahmen where profile_id = '${P}' and jahr = ${JAHR} and monat = ${MONAT} order by fassung desc limit 1) m), 'null')::text`));
  const vor = letzte();
  const erzeugt = vor
    ? await post(admin, "/api/hr/wage-documents/generate", { profile_id: P, year: JAHR, month: MONAT, neue_fassung: true, begruendung: "Pruefung Phase 4: Zusatzposten (Testlauf)", auszahlungsdatum: "2026-12-07" })
    : await post(admin, "/api/hr/wage-documents/generate", { profile_id: P, year: JAHR, month: MONAT });
  const f1 = letzte();
  ok(erzeugt.status === 200 && f1 && f1.fassung === (vor?.fassung ?? 0) + 1, `${vor ? `Korrekturfassung ${f1?.fassung}` : "Fassung 1 (regulär)"} erzeugt (${erzeugt.status}${erzeugt.json?.error ? ` ${erzeugt.json.error}` : ""})`);
  ok(gleich(f1?.brutto, mit.brutto) && gleich(f1?.netto, mit.netto) && gleich(f1?.auszahlungsbetrag, mit.auszahlungsbetrag),
    `Momentaufnahme = Lohn-Details: Brutto ${f1?.brutto}, Netto ${f1?.netto}, Auszahlungsbetrag ${f1?.auszahlungsbetrag}`);
  const erwartet = vor ? Number((mit.auszahlungsbetrag - Number(vor.auszahlungsbetrag ?? vor.netto)).toFixed(2)) : mit.auszahlungsbetrag;
  ok(gleich(f1?.auszahlung, erwartet), `Auszahlung der Fassung ${f1?.auszahlung} = ${vor ? "Differenz zum Auszahlungsbetrag der Vorfassung" : "Netto + Spesen"} (${erwartet})`);
  ok((f1?.zp ?? []).length === 3 && (f1?.abz ?? []).some((a) => a.rueckerstattung && a.art === "ahv_iv_eo" && gleich(a.betrag, -5.3)), "Ergebnis enthält die 3 Posten und die Rückerstattung als eigene Abzugszeile (−5.30)");
  const pdf1 = Buffer.from(await (await service.storage.from("lohndokumente").download(f1.storage_path)).data.arrayBuffer());
  const t1 = await pdfText(pdf1);
  ok(t1.includes(`${TEST} Quellensteuer vom Arbeitgeber bezahlt`) && t1.includes(`Rückerstattung AHV/IV/EO: ${TEST} AHV zurueck`) && t1.includes(`${TEST} Verpflegung auswärts`) && t1.includes("Spesen (nicht im Bruttolohn)"),
    "PDF: Lohnposten im Brutto, Rückerstattung bei den Abzügen, Spesen nach dem Netto");
  ok(/Auszahlung am \d{2}\.\d{2}\.\d{4}/.test(t1) || /(Nachzahlung|Rückforderung) am \d{2}\.\d{2}\.\d{4}|Keine Nachzahlung/.test(t1), "PDF: Auszahlungsdatum klar");
  ok(/Arbeitslosenversicherung \(ALV\)/.test(t1) && /AHV\/IV\/EO \d/.test(t1) && !/\b(ahv_iv_eo|bu_nbu|feiertag_1aug|zusatz_quellensteuer|quellensteuer|nbu|alv|bvg|ktg)\b/.test(t1), "PDF: Abzüge in Klartext, keine Code-Namen");
  ok(!t1.includes(MAIL.sara) && !/Arbeitgeberbeitr|Vollkosten|techniker|E-Mail/i.test(t1), "PDF: keine Mail der Person, keine Arbeitgeberbeiträge/Vollkosten, keine Rolle");
  const kaputt = [...t1].filter((c) => !/[\x20-\x7e\n\xa0-\xff–—‘’“”•…€]/.test(c));
  ok(kaputt.length === 0 && !t1.includes("�"), `PDF: keine kaputten Zeichen${kaputt.length ? ` (${[...new Set(kaputt)].join(" ")})` : ""}`);

  // ---------------------------------------------------------------------------
  titel("Abrechnung D  Korrekturfassung mit Vorfassung und Differenz");
  notweg(`insert into lohn_zusatzposten (profile_id, jahr, monat, art, bezeichnung, betrag, ahv_pflichtig, steuerbar, abzug_art, begruendung, created_by_name) values
    ('${P}', ${JAHR}, ${MONAT}, 'spesen', '${TEST} Parkgebuehr', 12.00, false, false, null, 'Pruefung Phase 4: Spesen nachgetragen', 'Pruefung Phase 4')`);
  const korr = await post(admin, "/api/hr/wage-documents/generate", { profile_id: P, year: JAHR, month: MONAT, neue_fassung: true, begruendung: "Pruefung Phase 4: Spesen nachgetragen", auszahlungsdatum: "2026-12-07" });
  const f2 = letzte();
  ok(korr.status === 200 && f2.fassung === f1.fassung + 1 && f2.art === "korrektur" && gleich(f2.netto, f1.netto) && gleich(f2.auszahlung, 12),
    `Korrekturfassung ${f2?.fassung}: Netto gleich (${f2?.netto}), Auszahlung = Differenz ${f2?.auszahlung} (nur Spesen)`);
  const t2 = await pdfText(Buffer.from(await (await service.storage.from("lohndokumente").download(f2.storage_path)).data.arrayBuffer()));
  ok(t2.includes("Korrektur-Lohnabrechnung") && t2.includes(`Ersetzt Fassung ${f1.fassung} vom`) && t2.includes(`Korrektur gegenüber Fassung ${f1.fassung}`)
    && t2.includes(`Fassung ${f1.fassung} (bisher)`) && t2.includes(`Fassung ${f2.fassung} (neu)`) && t2.includes("Differenz"),
    "Korrektur-PDF: Verweis auf Vorfassung (Fassung, Datum), Tabelle bisher/neu/Differenz");
  ok(/Nachzahlung am 07\.12\.2026 CHF 12\.00/.test(t2) && /Auszahlung \(Netto \+ Spesen\) [\d'’.]+ [\d'’.]+ \+ 12\.00/.test(t2), "Korrektur-PDF: Nachzahlung CHF 12.00 am 07.12.2026, Auszahlung bisher/neu/+12.00");

  // ---------------------------------------------------------------------------
  titel("Abrechnung E  Korrektur-Vorschlag erkennt Spesen-Abweichung");
  notweg(`insert into lohn_zusatzposten (profile_id, jahr, monat, art, bezeichnung, betrag, ahv_pflichtig, steuerbar, abzug_art, begruendung, created_by_name) values
    ('${P}', ${JAHR}, ${MONAT}, 'spesen', '${TEST} Vorschlag', 7.50, false, false, null, 'Pruefung Phase 4: nur Vorschlag', 'Pruefung Phase 4')`);
  const nach = await post(admin, "/api/hr/lohn-korrekturen", { aktion: "nachrechnen", jahr: JAHR, profile_id: P });
  const v = JSON.parse(sql(`select coalesce((select row_to_json(v) from (select id, netto_alt, netto_neu, differenz from lohn_korrektur_vorschlaege
      where profile_id = '${P}' and jahr = ${JAHR} and monat = ${MONAT} and status = 'offen') v), 'null')::text`));
  ok(nach.status === 200 && v && gleich(v.netto_alt, v.netto_neu) && gleich(v.differenz, 7.5), `Vorschlag trotz gleichem Netto: Differenz ${v?.differenz} (Auszahlungsbetrag)`);
  notweg(`delete from lohn_zusatzposten where profile_id = '${P}' and bezeichnung = '${TEST} Vorschlag'`);
  if (v) await post(admin, "/api/hr/lohn-korrekturen", { aktion: "verwerfen", id: v.id });

  // ---------------------------------------------------------------------------
  titel("Abrechnung F  Zusatzposten erfassen (Route, Sperre, Vier Augen)");
  const liste = await admin.api(`/api/hr/zusatzposten?profile_id=${P}`);
  const jul = (liste.json?.monate ?? []).find((m) => m.jahr === JAHR && m.monat === MONAT);
  const okt = (liste.json?.monate ?? []).find((m) => m.jahr === JAHR && m.monat === 10);
  ok(liste.status === 200 && (liste.json?.posten ?? []).filter((p) => p.bezeichnung.startsWith(TEST)).length === 4 && jul?.gesperrt === true && okt?.gesperrt === false,
    `GET: 4 Testposten, Juli gesperrt, Oktober offen`);
  const basisAntraege = Number(sql(`select count(*) from lohn_aenderungs_antraege where bereich = 'zusatzposten' and profile_id = '${P}'`));
  const neuGesperrt = await post(admin, "/api/hr/zusatzposten", {
    profile_id: P, jahr: JAHR, monat: MONAT, art: "lohn", bezeichnung: `${TEST} Antrag`, betrag: 50, ahv_pflichtig: true, steuerbar: true,
    posten_begruendung: "Pruefung Phase 4: gesperrter Monat",
  });
  const antrag = sql(`select id || '|' || status || '|' || begruendung from lohn_aenderungs_antraege where bereich = 'zusatzposten' and profile_id = '${P}' order by beantragt_at desc limit 1`).split("|");
  ok(neuGesperrt.status === 200 && neuGesperrt.json?.mode === "antrag" && Number(sql(`select count(*) from lohn_aenderungs_antraege where bereich = 'zusatzposten' and profile_id = '${P}'`)) === basisAntraege + 1
    && antrag[1] === "offen" && Number(sql(`select count(*) from lohn_zusatzposten where bezeichnung = '${TEST} Antrag'`)) === 0,
    `gesperrter Monat → Antrag (${neuGesperrt.json?.mode}), Begründung des Postens: «${antrag[2]}», noch kein Posten`);
  const ab = await post(admin2, "/api/hr/lohn-antraege", { id: antrag[0], aktion: "ablehnen", grund: "Pruefung Phase 4" });
  ok(ab.status === 200, "Testantrag abgelehnt (aufgeräumt)");
  const direkt = await post(admin, "/api/hr/zusatzposten", {
    profile_id: P, jahr: JAHR, monat: 10, art: "spesen", bezeichnung: `${TEST} Oktober Spesen`, betrag: 20.05, posten_begruendung: "Pruefung Phase 4: offener Monat",
  });
  ok(direkt.status === 200 && direkt.json?.mode === "angelegt", `offener Monat → direkt angelegt (${direkt.json?.mode ?? direkt.json?.error})`);
  const geaendert = await post(admin, "/api/hr/zusatzposten", { id: direkt.json?.id, betrag: 25 }, "PATCH");
  ok(geaendert.json?.mode === "geaendert" && gleich(sql(`select betrag from lohn_zusatzposten where id = '${direkt.json?.id}'`), 25), "ändern direkt");
  const protokoll = Number(sql(`select count(*) from lohn_aenderungen where tabelle = 'lohn_zusatzposten' and datensatz_id = '${direkt.json?.id}'`));
  const weg = await post(admin, "/api/hr/zusatzposten", { id: direkt.json?.id }, "DELETE");
  ok(weg.json?.mode === "geloescht" && Number(sql(`select count(*) from lohn_zusatzposten where id = '${direkt.json?.id}'`)) === 0 && protokoll >= 2, `löschen direkt; Protokoll ${protokoll}+1 Einträge`);
  const rappen = await post(admin, "/api/hr/zusatzposten", { profile_id: P, jahr: JAHR, monat: 10, art: "lohn", bezeichnung: `${TEST} Rappen`, betrag: 10.02, posten_begruendung: "Pruefung Phase 4: Rappen" });
  ok(rappen.status === 400 && /5-Rappen/.test(rappen.json?.error ?? ""), `Betrag 10.02 → ${rappen.status} «${rappen.json?.error}»`);
  const eigen = await post(admin, "/api/hr/zusatzposten", { profile_id: ID.admin, jahr: JAHR, monat: 10, art: "spesen", bezeichnung: `${TEST} eigen`, betrag: 10, posten_begruendung: "Pruefung Phase 4: eigener Lohn" });
  ok(eigen.status === 403, `eigener Lohn → ${eigen.status} (Vier Augen)`);
  ok(sqlFehler(`insert into lohn_zusatzposten (profile_id, jahr, monat, art, bezeichnung, betrag, begruendung) values ('${P}', ${JAHR}, ${MONAT}, 'lohn', '${TEST} direkt', 10, 'Pruefung Phase 4 direkt')`)?.includes("nur per Antrag") === true,
    "DB: Posten in gesperrtem Monat ohne Antrag → verweigert");

  // ---------------------------------------------------------------------------
  titel("Abrechnung G  Jahresliste, Lohnausweis, AK 40 (Auszahlungsjahr 2026)");
  const jl = await admin.api(`/api/hr/jahresliste?jahr=${JAHR}&basis=auszahlung`);
  const zeile = (jl.json?.zeilen ?? []).find((z) => z.profile_id === P && z.arbeitsjahr === JAHR && z.monat === MONAT && z.auszahlungsjahr === JAHR);
  ok(zeile && gleich(zeile.brutto, f2.brutto) && gleich(zeile.zusatz_steuerbar, 120) && gleich(zeile.spesen, 47.5) && gleich(zeile.auszahlungsbetrag, f2.auszahlungsbetrag)
    && zeile.zusatz_texte.includes(`${TEST} Quellensteuer vom Arbeitgeber bezahlt`) && zeile.auszahlungsdaten.includes("2026-12-07"),
    `Jahresliste: Juli mit Zusatzposten 120.00, Spesen ${zeile?.spesen}, Auszahlungen ${zeile?.auszahlungsdaten?.join(", ")}`);
  const summe = (jl.json?.summen ?? []).find((s) => s.profile_id === P);
  const vorlageRes = await admin.api(`/api/hr/lohnausweis?jahr=${JAHR}&vorlage=1`);
  const vorlageText = vorlageRes.buf.toString("utf8");
  ok(vorlageRes.status === 200 && vorlageText.startsWith("﻿profile_id;name;ahv_nr") && vorlageText.includes(P), "CSV-Vorlage Personalien (BOM, «;», je Person)");

  const laDocsVorher = Number(sql(`select count(*) from wage_documents where profile_id = '${P}' and doc_type = 'lohnausweis'`));
  const fd = (felder) => { const f = new FormData(); for (const [k, x] of Object.entries(felder)) f.set(k, x); return f; };
  const la = await admin.api("/api/hr/lohnausweis", { method: "POST", body: fd({ jahr: String(JAHR), profile_id: P }) });
  const laText = la.status === 200 ? await pdfText(la.buf) : "";
  const hinweise = JSON.parse(decodeURIComponent(la.headers.get("x-lohnausweis-hinweise") ?? "%5B%5D"));
  const ch = (n) => Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const fr = (x) => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);
  ok(la.status === 200 && la.headers.get("content-type") === "application/pdf" && laText.includes("Lohnausweis") && laText.includes(`${TEST} Quellensteuer`) && /\b120\b/.test(laText),
    `Lohnausweis-PDF (Formular 11): Ziffer 7 mit Bezeichnung und 120 (${la.status}${la.json?.error ? ` ${la.json.error}` : ""})`);
  ok(laText.includes("AHV-Nr. fehlt") && laText.includes("Adresse fehlt") && hinweise.some((h) => /AHV-Nr\. fehlt/.test(h)), "ohne Personalien: sichtbare Platzhalter + Hinweis");
  ok(summe && laText.includes(ch(fr(summe.steuerbar - summe.zusatz_steuerbar))) && laText.includes(ch(fr(summe.spesen))) && laText.includes(`${JAHR}`),
    `Ziffer 1 ${ch(fr((summe?.steuerbar ?? 0) - (summe?.zusatz_steuerbar ?? 0)))}, Ziffer 13 ${ch(fr(summe?.spesen ?? 0))} im PDF`);
  const csv = `profile_id;name;ahv_nr;geburtsdatum;strasse;adresszusatz;plz;ort\r\n${P};Huber Sara;7561234567897;02.04.1995;Testweg 3;;4051;Basel\r\n`;
  const la2 = await admin.api("/api/hr/lohnausweis", { method: "POST", body: fd({ jahr: String(JAHR), profile_id: P, personalien: new File([csv], "p.csv", { type: "text/csv" }) }) });
  const la2Text = la2.status === 200 ? await pdfText(la2.buf) : "";
  ok(la2.status === 200 && la2Text.includes("756.1234.5678.97") && la2Text.includes("Testweg 3") && !la2Text.includes("AHV-Nr. fehlt"), "mit Personalien-CSV: AHV-Nr. und Adresse gedruckt");
  ok(Number(sql(`select count(*) from wage_documents where profile_id = '${P}' and doc_type = 'lohnausweis'`)) === laDocsVorher
    && Number(sql(`select count(*) from finanzen.zugriffe where details::text like '%Testweg%' or details::text like '%756.1234%'`)) === 0,
    "Personalien nur im Speicher (nicht im Zugriffsprotokoll), Lohnausweis nicht abgelegt");
  const laEigen = await admin.api("/api/hr/lohnausweis", { method: "POST", body: fd({ jahr: String(JAHR), profile_id: ID.admin }) });
  ok(laEigen.status === 403, `eigener Lohnausweis → ${laEigen.status}`);
  const kaputtCsv = await admin.api("/api/hr/lohnausweis", { method: "POST", body: fd({ jahr: String(JAHR), profile_id: P, personalien: new File([`profile_id;ahv_nr\n${P};756.0000.0000.00\n`], "p.csv") }) });
  ok(kaputtCsv.status === 400 && /AHV-Nr/.test(kaputtCsv.json?.error ?? ""), "ungültige AHV-Nr. in der CSV → 400 (kein Druck mit falschen Daten)");
  const ak = await admin.api("/api/hr/ak-export", { method: "POST", body: fd({ jahr: String(JAHR), personalien: new File([csv], "p.csv") }) });
  const akText = ak.buf.toString("utf8");
  const akZeile = akText.split("\r\n").find((z) => z.endsWith(`;${P}`)) ?? "";
  ok(ak.status === 200 && akText.startsWith("﻿AHV-Nr.;Name") && akZeile.startsWith("756.1234.5678.97;Huber Sara;02.04.1995;") && akZeile.includes(`;${Number(summe?.ahv_lohn ?? 0).toFixed(2)};`),
    `AK 40: Sara mit AHV-Nr. und AHV-Lohn ${Number(summe?.ahv_lohn ?? 0).toFixed(2)} («;», BOM)`);

  // ---------------------------------------------------------------------------
  titel("Abrechnung H  Lohnausweis-Upload ohne zweite gültige Zeile (Jonas Frei)");
  const J = ID.jonas;
  const gueltig = () => Number(sql(`select count(*) from wage_documents where profile_id = '${J}' and doc_type = 'lohnausweis' and year = ${JAHR} and archived_at is null and superseded_at is null`));
  const maxVersion = () => Number(sql(`select coalesce(max(version), 0) from wage_documents where profile_id = '${J}' and doc_type = 'lohnausweis' and year = ${JAHR}`));
  const upload = (neueFassung) => admin.api("/api/hr/wage-documents", {
    method: "POST",
    body: fd({ file: new File([Buffer.from("%PDF-1.4\n% Pruefung Phase 4\n%%EOF\n")], "la.pdf", { type: "application/pdf" }), profile_id: J, doc_type: "lohnausweis", year: String(JAHR), ...(neueFassung ? { neue_fassung: "true" } : {}) }),
  });
  const v0 = maxVersion();
  const u1 = await upload(gueltig() === 1);
  const u2 = await upload(false);
  const u3 = await upload(true);
  ok(u1.status === 200 && u2.status === 409 && u2.json?.requires_confirm === "neue_fassung" && u3.status === 200 && gueltig() === 1 && maxVersion() === v0 + 2,
    `zweiter Upload ohne Bestätigung → ${u2.status}, mit Bestätigung → neue Fassung (Version ${maxVersion()}); gültig: ${gueltig()}`);
}
