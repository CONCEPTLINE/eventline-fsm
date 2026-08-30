// Einmal-Import: 22 Leads aus EVENTLINE_Firmen_Weihnachtsfeier_Leads.xlsx.
// Alle status=offen, step=1, event_typ='Firmenweihnachtsfeier',
// kategorie='veranstaltung'. Prio-Mapping aus Excel-Farbe:
//   Hoch -> top
//   Mittel / Niedrig-Mittel -> gut
//   Niedrig -> mittel
// nr wird per MAX(nr)+1 fortgezaehlt (kein sequence-Default).

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
  if (!r.ok) { console.error("SQL fail:", t); process.exit(1); }
  return JSON.parse(t);
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const LEADS = [
  { firma: "Solvias AG", branche: "Auftragsforschung / Life Science (CRO/CDMO)", ort: "Kaiseraugst", website: "solvias.com", mitarbeiter: "~550", prio: "top",
    email: "info@solvias.com", telefon: "061 845 60 00", adresse: "Römerpark 2, 4303 Kaiseraugst",
    analyse: "BESTÄTIGT: ~550 MA (Swiss Venture Club). Gross & finanzstark – ideal für Abteilungsfeiern statt Gesamtanlass." },
  { firma: "Bright Peak Therapeutics", branche: "Biotech (Immunonkologie)", ort: "Allschwil", website: "brightpeaktx.com", mitarbeiter: "~47–57 (CH-Team ~25–35)", prio: "top",
    email: null, telefon: null, adresse: "Hegenheimermattweg 167, Allschwil (SIP Basel Area)",
    analyse: "BESTÄTIGT: 47–57 MA gesamt (PitchBook/LeadIQ). Sehr gut finanziert ($232M+), wachsend. Teil des Teams in San Diego." },
  { firma: "Alira Health", branche: "Healthcare-Beratung / CRO", ort: "Basel", website: "alirahealth.com", mitarbeiter: "CH-Standort 20–49", prio: "top",
    email: null, telefon: "061 205 96 69", adresse: "Hochbergerstrasse 60F, 4057 Basel",
    analyse: "BESTÄTIGT: Basler Standort 20–49 MA (Swiss Biotech Dir.). Global ~569 MA (HQ USA) – klären, ob Basler Feier lokal entschieden wird." },
  { firma: "iart AG", branche: "Kreativtechnologie / Media-Architektur", ort: "Münchenstein", website: "iart.ch", mitarbeiter: "~20–40", prio: "top",
    email: "info@iart.ch", telefon: "061 500 11 50", adresse: "Freilager-Platz 3, 4142 Münchenstein",
    analyse: "BESTÄTIGT: interdisz. Studio. HR nennt 20 Mgmt-Personen. Kreativ/event-affin – guter Fit. Zweitkontakt: sales@iart.ch." },
  { firma: "Polyneuron Pharmaceuticals AG", branche: "Biotech-Spin-off", ort: "Basel", website: "polyneuron.com", mitarbeiter: "~9–10", prio: "mittel",
    email: null, telefon: null, adresse: "Hochbergerstrasse 60C, Basel",
    analyse: "KORRIGIERT: nur ~9–10 MA (PitchBook 9), Uni-Basel-Spin-off. Zu klein für Full-Service – gehen essen." },
  { firma: "Cellestia Biotech AG", branche: "Biotech", ort: "Basel", website: "cellestia.com", mitarbeiter: "~6–15", prio: "gut",
    email: null, telefon: null, adresse: null,
    analyse: "KORRIGIERT: ~6–15 MA (PitchBook 15, Tracxn 6). Gut finanziert (8M), aber kleines Kernteam. Postet eigene Team-Weihnachtsgrüsse = feiert informell selbst." },
  { firma: "Anaveon AG", branche: "Biotech (Immunonkologie)", ort: "Basel", website: "anaveon.com", mitarbeiter: "~25–31", prio: "gut",
    email: "contact@anaveon.com", telefon: null, adresse: null,
    analyse: "KORRIGIERT (war Hoch): nur ~25–31 MA (PitchBook 27). 'late-stage preclinical', sucht Partner fürs Legacy-Portfolio = Schrumpfung. Wenig Feier-Budget wahrscheinlich." },
  { firma: "Duttweiler Treuhand AG", branche: "Treuhand / Wirtschaftsprüfung", ort: "Liestal", website: "duttweiler-treuhand.ch", mitarbeiter: "~19", prio: "gut",
    email: null, telefon: null, adresse: "Liestal (nicht Basel)",
    analyse: "KORRIGIERT: ~19 MA, CHF 3 Mio Umsatz. ACHTUNG: organisiert selbst aufwändige Kundenanlässe (Chienbäse-Umzug mit Flying Buffet/Politprominenz) – event-erfahren, macht es selbst." },
  { firma: "Birseck-Treuhand AG", branche: "Treuhand", ort: "Arlesheim", website: "birseck-treuhand.ch", mitarbeiter: "~6", prio: "mittel",
    email: "office@birseck-treuhand.ch", telefon: "061 706 90 00", adresse: "Postplatz 7, 4144 Arlesheim",
    analyse: "KORRIGIERT: nur ~6 MA (LinkedIn), Familienbetrieb (3x Huber im VR). Zu klein für Full-Service-Feier." },
  { firma: "Affina Treuhand GmbH", branche: "Treuhand / Beratung", ort: "Seltisberg (BL)", website: "affina.ch", mitarbeiter: "~1–5", prio: "mittel",
    email: null, telefon: "076 435 50 08", adresse: "Seltisberg BL",
    analyse: "KORRIGIERT: Kleinstbetrieb, Kontakt via Natel = 1–5 Personen. Zu klein für Full-Service-Weihnachtsfeier." },
  { firma: "nextron GmbH", branche: "Webagentur / Software", ort: "Basel", website: "nextron.ch", mitarbeiter: "~5–10", prio: "gut",
    email: null, telefon: "061 695 92 20", adresse: "Reinacherstrasse 129, 4053 Basel",
    analyse: "KORRIGIERT: 5–10 MA (mehrere Quellen). Etabliert seit 1996, aber kleines Team – eher informelle Feier." },
  { firma: "arteria GmbH", branche: "Webagentur / Web-Apps", ort: "Basel", website: "arteria.ch", mitarbeiter: "~2–10", prio: "gut",
    email: "info@arteria.ch", telefon: "061 331 15 65", adresse: "Dornacherstrasse 192, 4053 Basel",
    analyse: "KORRIGIERT: 2–10 MA (LinkedIn). Kleines Team – eher informelle Feier." },
  { firma: "Prolog", branche: "Digitalagentur", ort: "Basel", website: "prolog.work", mitarbeiter: "~6 (2–10)", prio: "gut",
    email: "daniel@prolog.work", telefon: null, adresse: "Hammerstrasse 44, 4058 Basel",
    analyse: "KORRIGIERT: ~6 MA (LinkedIn 2–10). Kreativ, gutes Kultur-/Kanton-BS-Netzwerk, aber klein." },
  { firma: "Violetta Digital Craft", branche: "Full-Service-Webagentur", ort: "Kriens (Nebenst. Basel)", website: "violetta.ch", mitarbeiter: "~2–4", prio: "mittel",
    email: null, telefon: null, adresse: "HQ Kriens/LU, nur Nebenstandort Basel",
    analyse: "KORRIGIERT: nur ~2–4 MA (Remote-Agentur). Macht Team-Events (TeamDay/Winterday) selbst. Zu klein + nicht wirklich Basel." },
  { firma: "Masterhomepage", branche: "Webagentur / Onlineshops", ort: "Basel", website: "masterhomepage.ch", mitarbeiter: "~6–8", prio: "gut",
    email: "info@masterhomepage.ch", telefon: "061 681 54 50", adresse: "Thiersteinerallee 17, 4053 Basel",
    analyse: "KORRIGIERT: ~6-8 MA (Team-Seite: 6 Namen). Achtung: verschickt laut Bewertung selbst Werbemails. Klein." },
  { firma: "OHO Design", branche: "Digital-/Designagentur", ort: "Liestal / Basel", website: "ohodesign.ch", mitarbeiter: "~7", prio: "gut",
    email: "hallo@ohodesign.ch", telefon: "061 922 20 20", adresse: "Sitz Liestal (Benzburweg 18) + Büro Basel (Feldbergstr. 42)",
    analyse: "KORRIGIERT: ~7 MA (LinkedIn). Junges kreatives Team – evtl. offen für guten Anlass, aber klein." },
  { firma: "Treuhand Dr. E. Schaeren AG", branche: "Treuhand / Beratung", ort: "Basel", website: "schaeren-treuhand.ch", mitarbeiter: "~5–10", prio: "gut",
    email: null, telefon: "061 205 23 23", adresse: "Gartenstr. 105, 4052 Basel",
    analyse: "KORRIGIERT: ~5-10 MA (Team-Seite). Traditionsbetrieb seit 1954, klein." },
  { firma: "KMU Treuhand Revisions AG", branche: "Treuhand / Revision", ort: "Siebnen/LU/ZH (kein Basel)", website: "kmu-treurevi.ch", mitarbeiter: "n/a (nicht Basel)", prio: "mittel",
    email: null, telefon: null, adresse: "HQ Siebnen (SZ), Filialen Luzern/Zürich/SG/Bern/Brig/Wil",
    analyse: "KORRIGIERT: KEIN Basler Standort! Fällt als Basel-Lead raus." },
  { firma: "Dufour Treuhand", branche: "Treuhand", ort: "Basel", website: "dufour-treuhand.ch", mitarbeiter: "~10", prio: "mittel",
    email: null, telefon: null, adresse: "Tiergartenrain 3, 4054 Basel",
    analyse: "BESTÄTIGT: ~10 MA. Organisiert JEDES JAHR selbst ein Adventskonzert (Pauluskirche) mit 5 Partnerfirmen + eigene Charity. Macht Anlässe selbst." },
  { firma: "novu (jkweb)", branche: "Digitalagentur", ort: "Basel / Bern / Zürich", website: "novu.ch", mitarbeiter: "~50 (3 Standorte)", prio: "mittel",
    email: null, telefon: null, adresse: "Basel: Gempenstr. 10 + Zürich + Bern",
    analyse: "BESTÄTIGT: ~50 MA über 3 Standorte. Grösste Agentur der Liste, ABER pflegt starke eigene Feier-Kultur (Sommerfest, Winterweekend, GAM, Teamausflüge). Macht Events klar selbst." },
  { firma: "Waldhirsch", branche: "Web-/Online-Marketing-Agentur", ort: "Lörrach/Freiburg (DE)", website: "waldhirsch.ch", mitarbeiter: "~11–20 (in DE)", prio: "mittel",
    email: null, telefon: null, adresse: "HQ Lörrach/Freiburg (Deutschland)",
    analyse: "KORRIGIERT: HQ in Deutschland, in Basel nur Partner-Standort ohne eigenes Personal. Marketing-Agentur macht Events selbst. Kein echtes Basler Team." },
  { firma: "Gally Websolutions", branche: "Webagentur", ort: "Basel", website: "gally-websolutions.com", mitarbeiter: "~5–6", prio: "mittel",
    email: "mail@gally-websolutions.com", telefon: "061 511 78 78", adresse: "Klybeckstrasse 71, 4057 Basel",
    analyse: "BESTÄTIGT: ~5-6 MA (RocketReach). Macht Workations/eigene Feste selbst. Klein." },
];

function buildNotizen(l) {
  const lines = [
    `Website: ${l.website}`,
    `Mitarbeiter: ${l.mitarbeiter}`,
  ];
  if (l.adresse) lines.push(`Adresse: ${l.adresse}`);
  lines.push("");
  lines.push("Analyse (aus Excel-Recherche Juni 2026):");
  lines.push(l.analyse);
  return lines.join("\n");
}

// Naechste nr holen
const nxt = await sql("SELECT COALESCE(MAX(nr), 0) + 1 AS next_nr FROM vertrieb_contacts");
let nextNr = Number(nxt[0].next_nr);
console.log("Start nr:", nextNr);

let inserted = 0;
let skipped = 0;
for (const l of LEADS) {
  // Nochmal Duplikat-Check pro Firma
  const dup = await sql(`SELECT id FROM vertrieb_contacts WHERE firma = ${q(l.firma)} LIMIT 1`);
  if (dup.length > 0) { console.log("SKIP (dup):", l.firma); skipped++; continue; }

  const values = [
    nextNr,
    q(l.firma),
    l.branche ? q(l.branche) : "NULL",
    l.email ? q(l.email) : "NULL",
    l.telefon ? q(l.telefon) : "NULL",
    q("Firmenweihnachtsfeier"),
    q("offen"),
    q(buildNotizen(l)),
    q(l.prio),
    q("veranstaltung"),
    "1", // step
  ].join(", ");

  const res = await sql(`
    INSERT INTO vertrieb_contacts
      (nr, firma, branche, email, telefon, event_typ, status, notizen, prioritaet, kategorie, step)
    VALUES (${values})
    RETURNING id, nr, firma
  `);
  console.log("INS:", res[0].nr, "-", res[0].firma);
  inserted++;
  nextNr++;
}

console.log(`\nFertig. Inserted: ${inserted}, Skipped: ${skipped}`);
