#!/usr/bin/env node
// Prüftor Phase 2 — Nachrechnung März–Oktober 2026 auf LIVE, NUR LESEND.
//
// Liest Live über die Management-API (Endpoint database/query/read-only, Rolle
// supabase_read_only_user — kann nichts schreiben; Token nur aus
// _secrets\supabase-access-token.txt bzw. SUPABASE_ACCESS_TOKEN), rechnet jeden
// Monat mit dem ECHTEN Rechenkern (src/lib/lohn/kern, geladen über jiti) und
// vergleicht mit den bestehenden Abrechnungen (gesicherte PDFs, gelesen mit
// demselben Leser wie das Altbestand-Werkzeug). Jede Abweichung wird auf
// Ursachen verteilt (Summe der Ursachen = Differenz Netto, auf den Rappen).
//
// Ergebnis NUR als lokale Dateien unter _lohn-korrektur\arbeit\phase2\
// (nachrechnung.csv, erklaerung.md, rohdaten.json). Die Konsole zeigt nur
// Anzahlen und Summen je Ursache — keine Namen, keine Beträge je Person.
//
// Aufruf: node supabase/lokal/nachrechnung-live.mjs [--pdf <ordner>]
//   Standard-PDF-Ordner: C:\Users\misch\projects\_lohn-korrektur\sicherung\2026-10-28\pdf

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { pdfZeilen } from "../../scripts/lohn-pdf-text.mjs";
import { leseAltePdf } from "../../scripts/lohn-altbestand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const LIVE_REF = "uxtotpniwbwyoznwkygd";
const ZIEL = "C:/Users/misch/projects/_lohn-korrektur/arbeit/phase2";
const iPdf = process.argv.indexOf("--pdf");
const PDF_ORDNER = iPdf >= 0 ? process.argv[iPdf + 1] : "C:/Users/misch/projects/_lohn-korrektur/sicherung/2026-10-28/pdf";
const MONATE = [3, 4, 5, 6, 7, 8, 9, 10].map((m) => ({ jahr: 2026, monat: m }));

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const zeile = fs.readFileSync("C:/Users/misch/projects/_secrets/supabase-access-token.txt", "utf8").split(/\r?\n/).find((l) => l.startsWith("SUPABASE_ACCESS_TOKEN="));
  if (!zeile) throw new Error("SUPABASE_ACCESS_TOKEN nicht gefunden");
  return zeile.slice(zeile.indexOf("=") + 1).trim();
}

/** Eine Abfrage, nur lesend; Ergebnis als JSON-Array. */
async function lies(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${LIVE_REF}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `select coalesce(json_agg(t), '[]'::json) as j from (${query}) t` }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Live-Abfrage fehlgeschlagen (HTTP ${res.status}): ${txt.slice(0, 160)}`);
  return JSON.parse(txt)[0].j;
}

const r2 = (x) => Math.round(x * 100) / 100;
const mk = (j, m) => `${j}-${String(m).padStart(2, "0")}`;

async function main() {
  const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") } });
  const kern = await jiti.import(path.join(root, "src/lib/lohn/kern/index.ts"));
  const daten = await jiti.import(path.join(root, "src/lib/lohn/daten.ts"));

  // --- Live lesen ------------------------------------------------------------
  const [profile, zeilen, saetze, stempel, docs] = await Promise.all([
    lies(`select id, full_name, birthdate, is_active, role from profiles where role not in ('partner','lieferant')`),
    lies(`select ${daten.LOHNZEILE_SPALTEN} from employee_compensation`),
    lies(`select * from payroll_defaults`),
    lies(`select id, user_id, clock_in, clock_out from time_entries where clock_in >= '2024-11-25' and clock_in < '2026-11-03'`),
    lies(`select id, profile_id, year, period_month, storage_path, archived_at from wage_documents where doc_type = 'lohnabrechnung'`),
  ]);
  // Live hat Migration 364 noch nicht: Regel wie der Standardwert (5. Arbeitstag).
  const arbeitstag = 5;
  fs.mkdirSync(ZIEL, { recursive: true });
  fs.writeFileSync(path.join(ZIEL, "rohdaten.json"), JSON.stringify({ gelesen: new Date().toISOString(), profile, zeilen, saetze, stempel, docs }, null, 1));

  // --- Bestehende Abrechnungen (gesicherte PDFs) ------------------------------
  const alt = new Map();
  let pdfOhneBefund = 0;
  const pdfBefunde = [];
  for (const d of docs.filter((x) => !x.archived_at && x.year === 2026)) {
    const datei = path.join(PDF_ORDNER, `${d.profile_id}_2026_lohnabrechnung_${mk(d.year, d.period_month)}.pdf`);
    if (!fs.existsSync(datei)) { pdfBefunde.push(`PDF fehlt in der Sicherung: ${d.id}`); continue; }
    const r = leseAltePdf(await pdfZeilen(fs.readFileSync(datei)));
    if (!r.ok) { pdfBefunde.push(`${d.id}: ${r.fehler.join("; ")}`); continue; }
    pdfOhneBefund++;
    alt.set(`${d.profile_id}|${mk(d.year, d.period_month)}`, r.werte);
  }

  // --- Neu rechnen ------------------------------------------------------------
  const firmensaetze = saetze.map(daten.firmensatzAusZeile);
  const personen = new Map();
  for (const p of profile) {
    const roh = zeilen.filter((z) => z.profile_id === p.id).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    const st = stempel.filter((s) => s.user_id === p.id).map((s) => ({ id: s.id, start: s.clock_in, ende: s.clock_out }));
    const hatStempel2026 = st.some((s) => s.start >= "2026-03-01" && s.start < "2026-11-01");
    if (roh.length === 0 && !hatStempel2026) continue;
    personen.set(p.id, {
      profileId: p.id, name: p.full_name ?? "?",
      person: { id: p.id, geburtsdatum: p.birthdate, anstellungen: null, ahvVerlangtJahre: [] },
      lohnzeilen: roh.map(daten.lohnzeileAusRoh), stempel: st,
    });
  }
  const rechne = (lp, j, m, bisher) => {
    try {
      return { ok: true, e: kern.rechneMonat(daten.monatsEingabe(lp, firmensaetze, j, m, daten.regelAuszahlungsdatum(j, m, arbeitstag), bisher)) };
    } catch (err) {
      return { ok: false, code: err.code ?? "fehler", text: err.message };
    }
  };

  const URSACHEN = [
    ["stunden", "Stunden (Überlappung, offene Stempel, Zählweise)"],
    ["ansatz", "Lohnansatz tageweise / Lohnzeile"],
    ["sonntag", "Sonntag Sa 23–So 23, Feiertage, 6 pro Jahr"],
    ["nacht", "Nacht: eine Nacht je Abend, 24 pro Jahr"],
    ["august", "1. August 0,39 % (neu)"],
    ["rundung_brutto", "Rundung Brutto (5 Rappen je Lohnart)"],
    ["nbu", "NBU nach 7/87"],
    ["qst", "Quellensteuer (auf geändertem Brutto)"],
    ["abzuege", "AHV/IV/EO, ALV auf geändertem Brutto, Rundung"],
  ];
  const csv = [["profile_id", "name", "monat", "alt_brutto", "alt_netto", "neu_brutto", "neu_netto", "diff_netto", ...URSACHEN.map((u) => u[0]), "fall", "kern_fehler", "hinweise"].join(";")];
  const summe = Object.fromEntries(URSACHEN.map(([k]) => [k, { chf: 0, n: 0 }]));
  const faelle = { verglichen: 0, gleich: 0, abweichend: 0, nurNeu: 0, nurNeuNetto: 0, kernFehler: new Map(), altOhneNeu: 0 };
  let diffTotal = 0;

  for (const [id, lp] of personen) {
    for (const { jahr, monat } of MONATE) {
      const key = `${id}|${mk(jahr, monat)}`;
      const a = alt.get(key);
      // «bisher» im Auszahlungsjahr: bestehende Abrechnung, sonst Kern (wie nach der Altbestand-Übernahme)
      const bisher = { ahvLohn: 0, alvLohn: 0, uvgLohn: 0 };
      for (const v of daten.vormonateImAuszahlungsjahr(jahr, monat)) {
        const av = alt.get(`${id}|${mk(v.jahr, v.monat)}`);
        const w = av ? av.brutto : (() => { const x = rechne(lp, v.jahr, v.monat, undefined); return x.ok ? x.e.loehne.ahv : 0; })();
        bisher.ahvLohn += w; bisher.alvLohn += w; bisher.uvgLohn += w;
      }
      const n = rechne(lp, jahr, monat, bisher);
      if (!n.ok) {
        faelle.kernFehler.set(n.code, (faelle.kernFehler.get(n.code) ?? 0) + 1);
        if (a) faelle.altOhneNeu++;
        csv.push([id, lp.name, mk(jahr, monat), a?.brutto ?? "", a?.netto ?? "", "", "", "", ...URSACHEN.map(() => ""), a ? "alt, Kern-Fehler" : "Kern-Fehler", n.text.replace(/;/g, ","), ""].join(";"));
        continue;
      }
      const e = n.e;
      if (!a) {
        if (e.mengen.minuten === 0 && e.brutto === 0) continue;
        faelle.nurNeu++;
        faelle.nurNeuNetto += e.netto;
        csv.push([id, lp.name, mk(jahr, monat), "", "", e.brutto, e.netto, "", ...URSACHEN.map(() => ""), "keine bisherige Abrechnung", "", e.hinweise.map((h) => h.text).join(" | ").replace(/;/g, ",")].join(";"));
        continue;
      }
      faelle.verglichen++;
      // Neue Positionen inkl. ihres Ferienanteils (Stundenlohn ist inkl. Ferien)
      const pos = (art) => e.positionen.filter((p) => p.lohnart === art).reduce((s, p) => s + p.betrag, 0);
      const normal = pos("normal"), sonntag = pos("sonntag"), nacht = pos("nacht"), ferien = pos("ferien"), august = pos("feiertag_1aug");
      const basis = normal + sonntag + nacht;
      const inkl = (x) => (basis > 0 ? x + ferien * (x / basis) : 0);
      const altPos = (art) => a.positionen.filter((p) => p.lohnart === art).reduce((s, p) => s + p.betrag, 0);
      const gAlt = altPos("normal") + altPos("ferien") + altPos("sonstige");
      const sAlt = altPos("sonntag"), nAlt = altPos("nacht");
      const stundenEffekt = a.stundenlohn != null && a.minuten != null ? ((e.mengen.minuten - a.minuten) / 60) * a.stundenlohn : 0;
      const u = {
        stunden: stundenEffekt,
        ansatz: inkl(normal) - gAlt - stundenEffekt,
        sonntag: inkl(sonntag) - sAlt,
        nacht: inkl(nacht) - nAlt,
        august,
      };
      // Kleinstbeträge beim Lohnansatz sind Rundung (Aufteilung Basislohn/Ferien), keine Lohnänderung.
      if (Math.abs(u.ansatz) < 0.05) { u.rundung_brutto0 = u.ansatz; u.ansatz = 0; }
      u.rundung_brutto = (u.rundung_brutto0 ?? 0) + (e.brutto - (inkl(normal) + inkl(sonntag) + inkl(nacht) + august)) - (a.brutto - (gAlt + sAlt + nAlt));
      const ab = (liste, art) => liste.filter((x) => x.art === art).reduce((s, x) => s + x.betrag, 0);
      u.nbu = -(ab(e.abzuege, "nbu") - ab(a.abzuege, "nbu"));
      u.qst = -(ab(e.abzuege, "quellensteuer") - ab(a.abzuege, "quellensteuer"));
      u.abzuege = -((e.totalAbzuege - ab(e.abzuege, "nbu") - ab(e.abzuege, "quellensteuer")) - (a.totalAbzuege - ab(a.abzuege, "nbu") - ab(a.abzuege, "quellensteuer")));
      const diff = r2(e.netto - a.netto);
      delete u.rundung_brutto0;
      const summeU = Object.values(u).reduce((s, x) => s + x, 0);
      u.rundung_brutto += diff - summeU; // Restcent (Anzeige-Rundung der alten PDF) zur Rundung
      if (Math.abs(diff) < 0.005) faelle.gleich++; else faelle.abweichend++;
      diffTotal += diff;
      for (const [k] of URSACHEN) {
        const w = r2(u[k]);
        if (Math.abs(w) >= 0.005) { summe[k].chf += w; summe[k].n++; }
      }
      csv.push([id, lp.name, mk(jahr, monat), a.brutto, a.netto, e.brutto, e.netto, diff, ...URSACHEN.map(([k]) => r2(u[k])), "verglichen", "", e.hinweise.map((h) => h.text).join(" | ").replace(/;/g, ",")].join(";"));
    }
  }

  fs.writeFileSync(path.join(ZIEL, "nachrechnung.csv"), "\uFEFF" + csv.join("\r\n"));
  const md = [
    "# Nachrechnung März–Oktober 2026 mit dem Rechenkern (Phase 2)",
    "",
    `Erstellt ${new Date().toISOString()} · Kern ${kern.KERN_VERSION} · Live nur gelesen (read-only Endpoint) · bestehende Abrechnungen aus den gesicherten PDFs (${PDF_ORDNER}).`,
    "",
    "Annahmen: Anstellung nicht erfasst (Eintritt/Austritt unbekannt → ganzer Monat); Auszahlung je Monat nach Regel (5. Arbeitstag Folgemonat); «bisher» im Auszahlungsjahr aus den bestehenden Abrechnungen, sonst Kern.",
    "",
    "## Ergebnis",
    "",
    `- Personen-Monate verglichen (bestehende Abrechnung vorhanden): ${faelle.verglichen}, davon gleich ${faelle.gleich}, abweichend ${faelle.abweichend}`,
    `- Summe Differenz Netto (neu − bisher): CHF ${r2(diffTotal).toFixed(2)}`,
    `- Personen-Monate ohne bisherige Abrechnung, Kern rechnet Lohn: ${faelle.nurNeu} (Netto zusammen CHF ${r2(faelle.nurNeuNetto).toFixed(2)}; z. B. Oktober — Lauf am 5.11.)`,
    `- Kern-Fehler (fehlende Daten): ${[...faelle.kernFehler].map(([c, n]) => `${c} ${n}×`).join(", ") || "keine"}; davon mit bestehender Abrechnung ${faelle.altOhneNeu}`,
    `- PDFs gelesen ohne Befund: ${pdfOhneBefund}; Befunde: ${pdfBefunde.length}`,
    "",
    "## Differenz Netto je Ursache (Summe über alle verglichenen Monate)",
    "",
    "| Ursache | Monate | CHF |",
    "| --- | ---: | ---: |",
    ...URSACHEN.map(([k, t]) => `| ${t} | ${summe[k].n} | ${r2(summe[k].chf).toFixed(2)} |`),
    "",
    "Vorzeichen: + = Person bekommt mehr (Nachzahlung), − = weniger. Die Ursachen ergeben je Monat genau die Differenz Netto (Restrappen bei «Rundung Brutto»).",
    "",
    "## Erklärung der Ursachen",
    "",
    "- **Stunden:** Der Kern zählt überlappende Stempel einer Person nur einmal und offene Stempel (ohne Ende) nicht. Bewertet mit dem bisherigen Stundenlohn.",
    "- **Lohnansatz tageweise:** Jede Minute wird mit der Lohnzeile ihres Kalendertags bezahlt (bisher: eine Lohnzeile für den ganzen Monat, z. B. Lohnerhöhung mitten im Monat).",
    "- **Sonntag:** Sonntag = Samstag 23 Uhr bis Sonntag 23 Uhr, Feiertage gleich (Vortag 23 Uhr bis 23 Uhr); 50 % für die ersten 6 Sonn-/Feiertage im Kalenderjahr (bisher Kalendertag 0–24 Uhr).",
    "- **Nacht:** 23–6 Uhr; eine Schicht über Mitternacht ist EINE Nacht im Jahr, in dem sie um 23 Uhr beginnt (bisher zwei Nächte); 25 % für die ersten 24 Nächte, danach Zeitzuschlag.",
    "- **1. August:** Stundenlöhner erhalten 0,39 % auf den Lohn (Art. 110 Abs. 3 BV, AAB) — bisher nie bezahlt.",
    "- **NBU 7/87:** NBU-Abzug nur, wenn im 3- oder 12-Monats-Zeitraum Ø ≥ 8 h/Woche (nur ganze Wochen; Arbeitswochen nur, wenn sie überwiegen). Bisher meist zu Unrecht abgezogen → Rückzahlung.",
    "- **Quellensteuer / AHV, ALV:** gleiche Sätze, aber auf dem neuen Brutto; Beträge je Abzug auf 5 Rappen gerundet.",
    "- **Rundung Brutto:** neu jede Lohnart einmal auf 5 Rappen; die alten PDFs zeigten ungerundete Rappenbeträge.",
    "",
    "## Befunde beim Lesen der PDFs",
    "",
    ...(pdfBefunde.length ? pdfBefunde.map((b) => `- ${b}`) : ["- keine"]),
    "",
    "Details je Person und Monat: nachrechnung.csv (Semikolon, UTF-8). Rohdaten: rohdaten.json.",
  ].join("\n");
  fs.writeFileSync(path.join(ZIEL, "erklaerung.md"), md);

  console.log(`Live gelesen (read-only). PDFs ohne Befund: ${pdfOhneBefund}, Befunde: ${pdfBefunde.length}`);
  console.log(`Verglichen: ${faelle.verglichen} Personen-Monate, gleich ${faelle.gleich}, abweichend ${faelle.abweichend}, Summe Differenz Netto CHF ${r2(diffTotal).toFixed(2)}`);
  for (const [k, t] of URSACHEN) console.log(`  ${t}: ${summe[k].n} Monate, CHF ${r2(summe[k].chf).toFixed(2)}`);
  console.log(`Ohne bisherige Abrechnung: ${faelle.nurNeu} Personen-Monate, Netto CHF ${r2(faelle.nurNeuNetto).toFixed(2)}`);
  console.log(`Kern-Fehler: ${[...faelle.kernFehler].map(([c, n]) => `${c} ${n}×`).join(", ") || "keine"} (mit bestehender Abrechnung: ${faelle.altOhneNeu})`);
  console.log(`Dateien: ${ZIEL}`);
}

main().catch((e) => { console.error(`ABBRUCH: ${e.message}`); process.exit(1); });
