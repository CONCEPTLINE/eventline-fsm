// Finanzen Welle 1: Angriffs-Probe gegen das Schema `finanzen` (NUR LESEND).
//
// Beweist, dass anon/authenticated weder per SQL, noch per PostgREST, noch
// per GraphQL an den Bexio-Spiegel oder das Lese-Protokoll kommen, und dass
// die Finanz-API ohne Sitzung 401 liefert.
//
// Usage:
//   node scripts/finanzen-probe.mjs                      (App auf http://localhost:3000)
//   node scripts/finanzen-probe.mjs --app=https://eventline-fsm-usyk.vercel.app
//   node scripts/finanzen-probe.mjs --skip-api           (nur DB + PostgREST + GraphQL)
//
// Braucht in .env.local: SUPABASE_ACCESS_TOKEN (sbp_…, Management-API),
// NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY.
//
// Grundsatz: die Probe darf nie «vakuum-gruen» werden — jeder Negativtest
// hat eine Vorpruefung, die beweist, dass der Test ueberhaupt greift:
//   (a0) Rollenwechsel `set local role anon|authenticated` muss funktionieren
//        (current_user), sonst sofort FAIL + Exit 1 — ohne diesen Check
//        zaehlte «permission denied to set role» faelschlich als PASS.
//   (a)  Jede Tabelle/View/Funktion als anon UND authenticated — immer in
//        einer Transaktion (`set local role` endet mit ihr; ein nacktes
//        `set role` bliebe auf der gepoolten Verbindung haengen). PASS NUR
//        bei spezifischem «permission denied for (schema|table|view|relation|function)».
//   (a2) Rollen-unabhaengige Katalog-Checks als postgres (fangen auch
//        kuenftige Objekte und Default-Grants).
//   (b0) PostgREST-Positiv-Check (antwortet ueberhaupt?), sonst Exit 1.
//   (b)  PostgREST mit Accept-/Content-Profile finanzen + rpc + GraphQL.
//   (c)  App-API ohne Cookie → 401 (Cron-Routen 401/503); Server weg → SKIP.
//   (d)  Tabelle PASS/FAIL | Pruefung | Detail; Exit 1 bei mindestens einem FAIL.
// Niemals Tokens/Keys ausgeben; Fehlermeldungen auf 160 Zeichen gekappt.
// Keine DML, keine DDL — nur SELECT/Katalog und HTTP-GET/POST ohne Nebenwirkung.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------
// Env + Argumente
// ---------------------------------------------------------------------
const env = readFileSync(".env.local", "utf-8")
  .split(/\r?\n/).filter(l => l && !l.startsWith("#"))
  .reduce((a, l) => { const e = l.indexOf("="); if (e > 0) a[l.slice(0, e).trim()] = l.slice(e + 1).trim(); return a; }, {});

const PAT = env.SUPABASE_ACCESS_TOKEN;
const SUPABASE_URL = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const REF = SUPABASE_URL.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/)?.[1];

const argv = process.argv.slice(2);
const APP = (argv.find(a => a.startsWith("--app="))?.slice("--app=".length) || "http://localhost:3000").replace(/\/+$/, "");
const SKIP_API = argv.includes("--skip-api");

const ROLLEN = ["anon", "authenticated"];
const MIN_OBJEKTE = 16;
const FUNKTIONEN = [
  "select * from finanzen.kennzahlen()",
  "select * from finanzen.umsatz_monate(2026)",
  "select * from finanzen.zugriffe_zaehlung(now() - interval '7 days', now())",
];
/** PASS nur bei diesem spezifischen Fehler — generisches «permission denied»
 *  (z. B. «permission denied to set role») zaehlt NICHT. */
const PERMISSION_DENIED = /permission denied for (schema|table|view|relation|function)/i;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------
// Ergebnis-Sammlung
// ---------------------------------------------------------------------
const ergebnisse = [];
function kappe(s, n = 160) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}
function pass(pruefung, detail = "") { ergebnisse.push({ status: "PASS", pruefung, detail: kappe(detail) }); }
function fail(pruefung, detail = "") { ergebnisse.push({ status: "FAIL", pruefung, detail: kappe(detail) }); }
function skip(pruefung, detail = "") { ergebnisse.push({ status: "SKIP", pruefung, detail: kappe(detail) }); }

function tabelle() {
  const w2 = Math.min(64, Math.max(8, ...ergebnisse.map(e => e.pruefung.length)));
  console.log(`\n${"PASS/FAIL".padEnd(9)} | ${"Pruefung".padEnd(w2)} | Detail`);
  console.log(`${"-".repeat(9)}-+-${"-".repeat(w2)}-+-${"-".repeat(40)}`);
  for (const e of ergebnisse) {
    console.log(`${e.status.padEnd(9)} | ${e.pruefung.slice(0, w2).padEnd(w2)} | ${e.detail}`);
  }
  const nFail = ergebnisse.filter(e => e.status === "FAIL").length;
  const nPass = ergebnisse.filter(e => e.status === "PASS").length;
  const nSkip = ergebnisse.filter(e => e.status === "SKIP").length;
  console.log(`\n${nPass} PASS, ${nFail} FAIL, ${nSkip} SKIP`);
  return nFail;
}

/** Beendet die Probe (Tabelle + Exit-Code). Kein process.exit(): Node 24 auf
 *  Windows bricht sonst nach offenen fetch-Handles mit einer libuv-Assertion ab. */
function abschluss() {
  const nFail = tabelle();
  process.exitCode = nFail > 0 ? 1 : 0;
  return nFail;
}

// ---------------------------------------------------------------------
// SQL via Management-API (nur SELECT / Katalog)
// ---------------------------------------------------------------------
/** @returns {Promise<{ok:true, rows:unknown[]} | {ok:false, fehler:string, netz?:boolean}>} */
async function sql(query) {
  let res, text;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, netz: true, fehler: `Netzfehler Management-API: ${e?.name ?? ""} ${e?.message ?? ""}` };
  }
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    // Form (gemessen): HTTP 400 { message: "Failed to run sql query: ERROR:  42501: permission denied for schema …" }
    const msg = json && typeof json.message === "string" ? json.message : text;
    return { ok: false, fehler: `HTTP ${res.status}: ${msg}` };
  }
  if (!Array.isArray(json)) return { ok: false, fehler: `Unerwartete Antwortform (HTTP ${res.status})` };
  return { ok: true, rows: json };
}

/** Negativtest als Rolle: PASS nur bei spezifischem permission denied. */
async function alsRolleVerboten(rolle, statement, label) {
  const r = await sql(`begin; set local role ${rolle}; ${statement}; rollback;`);
  if (r.ok) {
    fail(label, `${rolle} erhielt ${r.rows.length} Zeile(n) zurueck — Zugriff moeglich!`);
    return;
  }
  if (r.netz) { fail(label, r.fehler); return; }
  if (PERMISSION_DENIED.test(r.fehler)) {
    pass(label, r.fehler.match(PERMISSION_DENIED)?.[0] ?? "permission denied");
  } else {
    fail(label, `kein spezifisches permission denied: ${r.fehler}`);
  }
}

// ---------------------------------------------------------------------
// HTTP-Helfer (PostgREST / GraphQL / App)
// ---------------------------------------------------------------------
/** @returns {Promise<{status:number, text:string, json:unknown} | {netz:string}>} */
async function http(url, init = {}) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, text, json };
  } catch (e) {
    return { netz: `${e?.name ?? "Fehler"}: ${e?.message ?? ""}` };
  }
}
const anonHeader = { apikey: ANON, Authorization: `Bearer ${ANON}` };

// ---------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------
async function main() {
  // Env-Vorpruefung (ohne Werte auszugeben).
  const fehlend = [];
  if (!PAT) fehlend.push("SUPABASE_ACCESS_TOKEN");
  if (!SUPABASE_URL) fehlend.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!ANON) fehlend.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (fehlend.length) { fail("Env .env.local", `fehlt: ${fehlend.join(", ")}`); abschluss(); return; }
  if (!REF) { fail("Env .env.local", "NEXT_PUBLIC_SUPABASE_URL ist keine https://<ref>.supabase.co-URL"); abschluss(); return; }

  console.log(`Finanzen-Probe — Projekt ${REF}, App ${SKIP_API ? "(uebersprungen)" : APP}`);

  // (a0) Rollen-Vorpruefung — ohne sie ist alles Weitere nicht aussagekraeftig.
  let rollenOk = true;
  for (const rolle of ROLLEN) {
    const r = await sql(`begin; set local role ${rolle}; select current_user as r; rollback;`);
    const row = r.ok && r.rows.length === 1 ? r.rows[0] : null;
    if (row && row.r === rolle) {
      pass(`Rollenwechsel ${rolle}`, `current_user = ${rolle}`);
    } else {
      rollenOk = false;
      fail(`Rollenwechsel ${rolle}`, `Rollenwechsel nicht moeglich — Ergebnis nicht aussagekraeftig: ${r.ok ? JSON.stringify(r.rows).slice(0, 80) : r.fehler}`);
    }
  }
  if (!rollenOk) { abschluss(); return; }

  // (a) Objektliste + Negativtests je Rolle.
  const liste = await sql(
    "select table_name, table_type from information_schema.tables where table_schema='finanzen' and table_type in ('BASE TABLE','VIEW') order by 1",
  );
  const objekte = liste.ok ? liste.rows.filter(o => IDENT.test(String(o.table_name))) : [];
  const schemaVoll = liste.ok && objekte.length >= MIN_OBJEKTE;
  if (!liste.ok) {
    fail("Schema finanzen: Objektliste", liste.fehler);
  } else if (!schemaVoll) {
    fail("Schema finanzen: Objektliste", `Schema leer/unvollstaendig: ${objekte.length} Objekte (erwartet >= ${MIN_OBJEKTE}) — Migration 323 eingespielt?`);
  } else {
    pass("Schema finanzen: Objektliste", `${objekte.length} Tabellen/Views`);
  }
  /** Katalog-Checks ueber «keine Zeile darf zurueckkommen» sind bei leerem
   *  Schema vakuum-gruen — dann FAIL statt PASS. */
  const leerCheck = (label, r, zeilenText) => {
    if (!r.ok) fail(label, r.fehler);
    else if (!schemaVoll) fail(label, "nicht aussagekraeftig: Schema leer/fehlt");
    else if (r.rows.length) fail(label, zeilenText(r.rows));
    else return true;
    return false;
  };

  for (const rolle of ROLLEN) {
    for (const o of objekte) {
      const art = o.table_type === "VIEW" ? "View" : "Tabelle";
      await alsRolleVerboten(rolle, `select count(*) from finanzen.${o.table_name}`, `${rolle}: ${art} ${o.table_name}`);
    }
    for (const f of FUNKTIONEN) {
      const name = f.match(/finanzen\.([a-z_]+)\(/)?.[1] ?? f;
      await alsRolleVerboten(rolle, f, `${rolle}: Funktion ${name}()`);
    }
  }
  // Sicherheitsnetz: falls je ein set role haengen geblieben waere.
  await sql("reset role;");

  // (a2) Rollen-unabhaengige Katalog-Checks (als postgres).
  {
    const r = await sql("select has_schema_privilege('anon','finanzen','USAGE') as anon, has_schema_privilege('authenticated','finanzen','USAGE') as authenticated");
    if (!r.ok) fail("Katalog: has_schema_privilege", r.fehler);
    else {
      const row = r.rows[0] ?? {};
      for (const rolle of ROLLEN) {
        if (row[rolle] === false) pass(`Katalog: ${rolle} hat keine USAGE auf finanzen`, "has_schema_privilege = false");
        else fail(`Katalog: ${rolle} hat keine USAGE auf finanzen`, `has_schema_privilege = ${JSON.stringify(row[rolle])}`);
      }
    }
  }
  {
    const r = await sql("select nspacl::text as acl from pg_namespace where nspname='finanzen'");
    if (!r.ok) fail("Katalog: nspacl ohne PUBLIC", r.fehler);
    else if (r.rows.length !== 1) fail("Katalog: nspacl ohne PUBLIC", "Schema finanzen existiert nicht");
    else {
      const acl = String(r.rows[0].acl ?? "");
      const eintraege = acl.replace(/^\{|\}$/g, "").split(",").map(s => s.trim()).filter(Boolean);
      const publicEintrag = eintraege.find(e => e.startsWith("="));
      if (publicEintrag) fail("Katalog: nspacl ohne PUBLIC", `PUBLIC-Eintrag: ${publicEintrag}`);
      else pass("Katalog: nspacl ohne PUBLIC", acl || "(nspacl null = nur Owner)");
    }
  }
  {
    const label = "Katalog: keine Tabellen-Grants an anon/authenticated/PUBLIC";
    const r = await sql("select grantee, table_name from information_schema.role_table_grants where table_schema='finanzen' and grantee in ('anon','authenticated','PUBLIC') order by 1,2");
    if (leerCheck(label, r, rows => rows.map(x => `${x.grantee}:${x.table_name}`).join(", "))) pass(label, "role_table_grants leer");
  }
  {
    // Vorpruefung: die drei Funktionen muessen existieren, sonst ist «keine ausfuehrbar» leer.
    const n = await sql("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='finanzen'");
    const anzahl = n.ok ? Number(n.rows[0]?.n ?? 0) : 0;
    const label = "Katalog: keine Funktion fuer anon/authenticated ausfuehrbar";
    const r = await sql("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='finanzen' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')) order by 1");
    if (anzahl < FUNKTIONEN.length) fail(label, `nicht aussagekraeftig: nur ${anzahl} Funktion(en) im Schema (erwartet >= ${FUNKTIONEN.length})`);
    else if (leerCheck(label, r, rows => rows.map(x => x.proname).join(", "))) pass(label, `has_function_privilege bei ${anzahl} Funktionen ueberall false`);
  }
  {
    const label = "Katalog: RLS auf allen Tabellen an";
    const r = await sql("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='finanzen' and c.relkind='r' and not c.relrowsecurity order by 1");
    if (leerCheck(label, r, rows => `ohne RLS: ${rows.map(x => x.relname).join(", ")}`)) pass(label, "relrowsecurity ueberall true");
  }
  {
    const label = "Katalog: alle Views security_invoker";
    const views = objekte.filter(o => o.table_type === "VIEW").length;
    const r = await sql("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='finanzen' and c.relkind='v' and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'false') not in ('on','true') order by 1");
    if (schemaVoll && views === 0) fail(label, "nicht aussagekraeftig: keine View im Schema");
    else if (leerCheck(label, r, rows => `ohne security_invoker: ${rows.map(x => x.relname).join(", ")}`)) pass(label, `security_invoker = on bei ${views} Views`);
  }

  // (b0) PostgREST-Positiv-Check: antwortet PostgREST ueberhaupt?
  {
    const r = await http(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=0`, { headers: anonHeader });
    const schemaCache = !("netz" in r) && /schema cache/i.test(r.text);
    if ("netz" in r || r.status === 503 || schemaCache || !(r.status === 200 || r.status === 401)) {
      fail("PostgREST erreichbar (Positiv-Check)", "netz" in r ? r.netz : `HTTP ${r.status}${schemaCache ? " (schema cache)" : ""} — PostgREST nicht erreichbar — Negativtests nicht aussagekraeftig`);
      abschluss();
      return;
    }
    pass("PostgREST erreichbar (Positiv-Check)", `HTTP ${r.status}`);
  }

  // (b) PostgREST-Negativtests mit Anon-Key.
  {
    const r = await http(`${SUPABASE_URL}/rest/v1/rechnungen?select=id&limit=1`, { headers: { ...anonHeader, "Accept-Profile": "finanzen" } });
    if ("netz" in r) fail("PostgREST: GET rechnungen (Accept-Profile finanzen)", r.netz);
    else if ([401, 403, 404, 406].includes(r.status)) pass("PostgREST: GET rechnungen (Accept-Profile finanzen)", `HTTP ${r.status}`);
    else fail("PostgREST: GET rechnungen (Accept-Profile finanzen)", `HTTP ${r.status}${r.status === 200 ? " — Daten lesbar!" : " (unerwartet)"}: ${r.text}`);
  }
  for (const [fn, body] of [["kennzahlen", {}], ["umsatz_monate", { p_jahr: 2026 }]]) {
    const r = await http(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { ...anonHeader, "Content-Profile": "finanzen", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ("netz" in r) fail(`PostgREST: rpc/${fn} (Content-Profile finanzen)`, r.netz);
    else if (r.status !== 200) pass(`PostgREST: rpc/${fn} (Content-Profile finanzen)`, `HTTP ${r.status}`);
    else fail(`PostgREST: rpc/${fn} (Content-Profile finanzen)`, `HTTP 200 — Funktion ausfuehrbar!`);
  }
  {
    const r = await http(`${SUPABASE_URL}/graphql/v1`, {
      method: "POST",
      headers: { ...anonHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ rechnungenCollection { edges { node { id } } } }" }),
    });
    if ("netz" in r) fail("GraphQL: rechnungenCollection", r.netz);
    else {
      const j = r.json && typeof r.json === "object" ? r.json : {};
      const coll = j.data && typeof j.data === "object" ? j.data.rechnungenCollection : undefined;
      const edgesArray = coll && typeof coll === "object" && Array.isArray(coll.edges);
      if (edgesArray) fail("GraphQL: rechnungenCollection", `HTTP ${r.status} — edges geliefert (${coll.edges.length})!`);
      else if (Array.isArray(j.errors) && j.errors.length) pass("GraphQL: rechnungenCollection", `HTTP ${r.status}, errors: ${kappe(j.errors[0]?.message, 80)}`);
      else if (coll === undefined || coll === null) pass("GraphQL: rechnungenCollection", `HTTP ${r.status}, keine Collection`);
      else fail("GraphQL: rechnungenCollection", `HTTP ${r.status}, unerwartete Antwort: ${r.text}`);
    }
  }

  // (c) App-API ohne Cookie.
  if (SKIP_API) {
    skip("App-API ohne Cookie", "--skip-api");
  } else {
    const routen = [
      ["GET", "/api/finanzen/uebersicht", [401]],
      ["GET", "/api/finanzen/offene-posten", [401]],
      ["GET", "/api/finanzen/stepup/status", [401]],
      ["POST", "/api/finanzen/stepup/ende", [401]],
      ["POST", "/api/finanzen/stepup/passwort", [401], "{}"],
      ["POST", "/api/finanzen/sync", [401]],
      ["GET", "/api/einstellungen/zugriffe", [401]],
      ["GET", "/api/cron/finanzen-sync", [401, 503]],
      ["GET", "/api/cron/zugriffe-digest", [401, 503]],
    ];
    let serverWeg = false;
    for (const [methode, pfad, erlaubt, body] of routen) {
      const label = `API ohne Cookie: ${methode} ${pfad}`;
      if (serverWeg) { skip(label, "Server nicht erreichbar"); continue; }
      const r = await http(`${APP}${pfad}`, {
        method: methode,
        headers: body ? { "Content-Type": "application/json" } : {},
        body,
      });
      if ("netz" in r) { serverWeg = true; skip(label, `Server nicht erreichbar: ${r.netz}`); continue; }
      if (erlaubt.includes(r.status)) pass(label, `HTTP ${r.status}`);
      else fail(label, `HTTP ${r.status} (erwartet ${erlaubt.join("/")})`);
    }
  }

  abschluss();
}

await main();
