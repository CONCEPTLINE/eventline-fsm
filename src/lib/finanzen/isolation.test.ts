/**
 * Finanzen-Isolation (Spec Entscheid 8 / C.B2 Schritt 11).
 *
 * Vier Zusicherungen ueber den Finanz-Code (lib/finanzen, api/finanzen,
 * components/finanzen, die Finanz-Crons, api/einstellungen/zugriffe und
 * die Karte zugriffe-card.tsx):
 *
 *   1. Import-Graph: nichts davon erreicht KI-Code (lib/ai, lib/ki, akquise-ki,
 *      akquise-websuche, akquise-tiefenrecherche) oder @anthropic-ai/*.
 *   2. Keine erreichte Datei enthaelt ANTHROPIC_API_KEY / GEMINI_API_KEY.
 *   3. Heuristik logError: kein Aufruf traegt Betraege/Namen/Nummern als
 *      Extra-Schluessel; Supabase-/Postgres-Fehler werden nie serialisiert
 *      (kein JSON.stringify(err), String(err), { ...err }) — Postgres legt
 *      bei Check-/Not-Null-Verletzungen die GANZE Zeile (Betraege, Kunden-
 *      namen) in DETAIL, supabase-js liefert das als error.details. Erlaubt
 *      ist nur { code: error.code }.
 *   4. Schema-Grenze: ausserhalb src/lib/finanzen/db.ts erzeugt kein Code in
 *      src/** einen Client mit Schema `finanzen` (Literal, .schema(,
 *      FINANZEN_SCHEMA, createClient(... db: {) — eine Variable statt Literal
 *      wuerde sonst die Regex umgehen.
 *
 * Der Test laeuft auch, solange B3/B4-Dateien fehlen (leere Mengen → gruen;
 * die Positiv-Pruefung von db.ts ist bis dahin it.skip). Test-Dateien
 * (*.test.ts/tsx) werden nicht gescannt — sie enthalten die Muster als Regex.
 *
 * Wenn dieser Test rot wird: fixe den Code, nicht den Test.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC_ROOT = join(process.cwd(), "src");

const START_DIRS = [
  "lib/finanzen",
  "app/api/finanzen",
  "components/finanzen",
  "app/api/cron/finanzen-sync",
  "app/api/cron/zugriffe-digest",
  "app/api/einstellungen/zugriffe",
];
const START_FILES = ["components/einstellungen/zugriffe-card.tsx"];
const DB_DATEI = "lib/finanzen/db.ts";

const VERBOTENE_PFADE: RegExp[] = [
  /src\/lib\/ai\//,
  /src\/lib\/ki\//,
  /akquise-ki/,
  /akquise-websuche/,
  /akquise-tiefenrecherche/,
];
const VERBOTENE_SCHLUESSEL = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"];

// Extra-Schluessel mit Geldbezug/Namen in logError-Aufrufen.
const LOGERROR_SCHLUESSEL_RE = /\b(total|betrag|amount|summe|saldo|name|name_1|name_2|kunde|lieferant|document_nr|document_no|iban|email|mail|title|details|hint)\s*:/i;
const FEHLER_SERIALISIERT_RE: { re: RegExp; regel: string }[] = [
  { re: /JSON\.stringify\(\s*(err|error|e)\b/, regel: "JSON.stringify(err) — serialisiert error.details (Postgres DETAIL = ganze Zeile)" },
  { re: /\bString\(\s*(err|error|e)\s*\)/, regel: "String(err) — nur { code: error.code } erlaubt" },
  { re: /\{\s*\.\.\.(err|error|e)\b/, regel: "{ ...err } — kopiert details/hint mit" },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function normalizeRel(file: string): string {
  return relative(SRC_ROOT, file).split(sep).join("/");
}

function istTestDatei(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function istCodeDatei(file: string): boolean {
  return /\.(ts|tsx)$/.test(file) && !istTestDatei(file);
}

/** Start-Menge: alle Code-Dateien der Finanz-Ordner + Einzeldateien.
 *  Fehlende Ordner/Dateien (Bauteile noch nicht da) werden uebersprungen. */
function startMenge(): string[] {
  const out = new Set<string>();
  for (const d of START_DIRS) {
    const full = join(SRC_ROOT, d);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const f of walk(full)) if (istCodeDatei(f)) out.add(f);
  }
  for (const f of START_FILES) {
    const full = join(SRC_ROOT, f);
    if (existsSync(full) && statSync(full).isFile()) out.add(full);
  }
  return Array.from(out);
}

// import … from "x" | export … from "x" | import "x" | import("x")
const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function spezifizierer(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

/** @/x → src/x, relative Pfade aufloesen; Pakete → null. */
function aufloesen(spec: string, vonDatei: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(vonDatei), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

interface Graph {
  start: string[];
  erreicht: string[];
  pakete: string[];
}

function graphBauen(): Graph {
  const start = startMenge();
  const erreicht = new Set<string>(start);
  const pakete = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const spec of spezifizierer(src)) {
      const ziel = aufloesen(spec, file);
      if (ziel === null) {
        pakete.add(spec);
        continue;
      }
      if (!erreicht.has(ziel)) {
        erreicht.add(ziel);
        queue.push(ziel);
      }
    }
  }
  return { start, erreicht: Array.from(erreicht), pakete: Array.from(pakete) };
}

/** Text eines logError(-Aufrufs bis zur schliessenden Klammer (max. 8 Zeilen). */
function logErrorAufrufe(src: string): { zeile: number; text: string }[] {
  const out: { zeile: number; text: string }[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let idx = lines[i].indexOf("logError(");
    while (idx !== -1) {
      // Fenster beginnt mit der aktuellen Zeile → Position im Fenster = idx.
      const fenster = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
      const startPos = idx;
      let tiefe = 0;
      let ende = -1;
      for (let p = startPos + "logError".length; p < fenster.length; p++) {
        const ch = fenster[p];
        if (ch === "(") tiefe++;
        else if (ch === ")") {
          tiefe--;
          if (tiefe === 0) { ende = p; break; }
        }
      }
      out.push({ zeile: i + 1, text: fenster.slice(startPos, ende === -1 ? fenster.length : ende + 1) });
      idx = lines[i].indexOf("logError(", idx + 1);
    }
  }
  return out;
}

describe("Finanzen-Isolation", () => {
  const graph = graphBauen();
  const relErreicht = graph.erreicht.map((f) => `src/${normalizeRel(f)}`);

  it("Assertion 1: Finanz-Code erreicht keinen KI-Code und kein @anthropic-ai", () => {
    const treffer = relErreicht.filter((p) => VERBOTENE_PFADE.some((re) => re.test(p)));
    const paketTreffer = graph.pakete.filter((p) => p.startsWith("@anthropic-ai"));
    if (treffer.length || paketTreffer.length) {
      throw new Error(
        `Finanz-Code zieht KI-Code mit:\n${[...treffer, ...paketTreffer].map((t) => `  ${t}`).join("\n")}`,
      );
    }
    expect(treffer.length + paketTreffer.length).toBe(0);
  });

  it("Assertion 2: keine erreichte Datei enthaelt KI-Schluesselnamen", () => {
    const treffer: string[] = [];
    for (const f of graph.erreicht) {
      const src = readFileSync(f, "utf8");
      for (const k of VERBOTENE_SCHLUESSEL) {
        if (src.includes(k)) treffer.push(`src/${normalizeRel(f)} enthaelt ${k}`);
      }
    }
    if (treffer.length) throw new Error(treffer.join("\n"));
    expect(treffer.length).toBe(0);
  });

  it("Assertion 3: logError ohne Betraege/Namen, Fehler nie serialisiert (Heuristik)", () => {
    const treffer: string[] = [];
    for (const f of graph.start) {
      const rel = `src/${normalizeRel(f)}`;
      const src = readFileSync(f, "utf8");
      for (const call of logErrorAufrufe(src)) {
        // Drittes Argument: alles nach dem zweiten Top-Level-Komma — die
        // Heuristik prueft den ganzen Aufruf; Label und Fehlerobjekt tragen
        // solche Schluessel ohnehin nicht.
        const m = call.text.match(LOGERROR_SCHLUESSEL_RE);
        if (m) treffer.push(`${rel}:${call.zeile}  logError-extra mit Schluessel "${m[1]}"`);
      }
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const { re, regel } of FEHLER_SERIALISIERT_RE) {
          if (re.test(line)) treffer.push(`${rel}:${i + 1}  ${regel}  →  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    if (treffer.length) {
      throw new Error(`Finanz-Logging leckt potenziell Betraege/Namen:\n${treffer.map((t) => `  ${t}`).join("\n")}`);
    }
    expect(treffer.length).toBe(0);
  });

  it("Assertion 4: Schema finanzen nur in src/lib/finanzen/db.ts", () => {
    const dbVoll = join(SRC_ROOT, DB_DATEI);
    const treffer: string[] = [];
    for (const f of walk(SRC_ROOT)) {
      if (f === dbVoll || istTestDatei(f)) continue;
      const rel = `src/${normalizeRel(f)}`;
      const src = readFileSync(f, "utf8");
      if (/schema:\s*("|')finanzen("|')/.test(src)) treffer.push(`${rel}: Schema-Literal "finanzen"`);
      if (/\.schema\(/.test(src)) treffer.push(`${rel}: .schema(`);
      // [^)]* matcht auch Zeilenumbrueche — kein s-Flag noetig (tsconfig-Target < es2018).
      if (/createClient\([^)]*\bdb:\s*\{/.test(src)) treffer.push(`${rel}: createClient(... db: {`);
      src.split(/\r?\n/).forEach((line, i) => {
        if (line.includes("FINANZEN_SCHEMA") && !line.trimStart().startsWith("import type")) {
          treffer.push(`${rel}:${i + 1}: FINANZEN_SCHEMA ausserhalb db.ts`);
        }
      });
    }
    if (treffer.length) {
      throw new Error(`Schema-Grenze verletzt (nur db.ts darf das):\n${treffer.map((t) => `  ${t}`).join("\n")}`);
    }
    expect(treffer.length).toBe(0);
  });

  const dbVorhanden = existsSync(join(SRC_ROOT, DB_DATEI));
  (dbVorhanden ? it : it.skip)("Assertion 4 (positiv): db.ts definiert und nutzt FINANZEN_SCHEMA — uebersprungen bis B3 db.ts liefert", () => {
    const src = readFileSync(join(SRC_ROOT, DB_DATEI), "utf8");
    expect(src).toMatch(/export const FINANZEN_SCHEMA = "finanzen"/);
    expect(src).toMatch(/schema:\s*FINANZEN_SCHEMA/);
  });
});
